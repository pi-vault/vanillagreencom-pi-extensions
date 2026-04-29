#!/usr/bin/env bash
# Path resolvers + port allocator for the opencode HTTP-attach adapter.
#
# Sourced by open-terminal (spawn-time port alloc + session-discovery
# write), pane-registry (auto-load discovery file at init), pane-respond
# and pane-poll (read oc bridge metadata), and flightdeck-daemon
# (per-pane subscriber spawn).
#
# All file paths live under fd_resolve_state_dir (host-user-scoped). The
# port allocator file is intentionally NOT session-keyed: two concurrent
# flightdeck sessions on the same host must not collide on the
# 18430-18529 range.
#
# Distinction from daemon-paths.sh: daemon-paths.sh names per-session
# files (BUSY_FILE, PID_FILE, ...). This file names per-issue/per-host
# files for the opencode adapter. They share fd_resolve_state_dir.

# shellcheck source=daemon-paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/daemon-paths.sh"

OC_PORT_RANGE_START=18430
OC_PORT_RANGE_END=18529

oc_ports_file()  { echo "$(fd_resolve_state_dir)/oc-ports.json"; }
oc_ports_lock()  { echo "$(fd_resolve_state_dir)/oc-ports.lock"; }
oc_spawn_file()  { echo "$(fd_resolve_state_dir)/oc-spawn-$1.json"; }

# Filename-safe form of a tmux pane_id ("%47" → "47"). Used for per-pane
# subscriber pid + jsonl files where '%' is awkward.
oc_pane_id_safe() {
  local id="$1"
  echo "${id#%}"
}

oc_subscriber_pid_file()  { echo "$(fd_resolve_state_dir)/fd-subscriber-$(oc_pane_id_safe "$1").pid"; }

# Per-port opencode-serve subprocess paths. Server is spawned by
# open-terminal as a detached background process (setsid+nohup) and
# reaped on pane-registry remove (server_pid is persisted in the spawn
# file at allocation time; remove reads it and kills).
oc_server_log()      { echo "$(fd_resolve_state_dir)/oc-serve-$1.log"; }

# Wake-events log: subscribers (Phase 1+) append normalized turn-end
# events here; daemon's main loop drains under SESSION_LOCK and routes
# canonical-tag entries through wake_master. Per-session, keyed.
oc_wake_events_log() {
  local session_key="$1"
  echo "$(fd_resolve_state_dir)/fd-wake-events-${session_key}.log"
}

# Probe a TCP port on 127.0.0.1 — returns 0 if free, 1 if in use.
# Tries (in order): bash /dev/tcp (always present), `ss`, `lsof`.
oc_port_is_free() {
  local port="$1"
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 1  # connected → in use
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port" && return 1
  fi
  return 0
}

# Allocate a free port in the opencode range, atomically registering it
# in the host-global ports file under flock so concurrent open-terminal
# invocations don't double-book.
#
# Args: <issue-id>
# Stdout: the allocated port number on success.
# Exit: 0 success, 1 range exhausted.
oc_alloc_port() {
  local issue="$1"
  local ports_file lock_file
  ports_file=$(oc_ports_file)
  lock_file=$(oc_ports_lock)
  [[ -f "$ports_file" ]] || echo '{}' > "$ports_file"

  exec 209>"$lock_file"
  flock 209

  local now port
  now=$(date -Iseconds)

  # Sweep: drop entries whose pid is dead (best-effort; pid may be reused
  # but the race is benign — worst case we skip a free slot until next sweep).
  local tmp; tmp="${ports_file}.tmp.$$"
  if jq -e 'type == "object"' "$ports_file" >/dev/null 2>&1; then
    jq --argjson now_epoch "$(date +%s)" '
      to_entries
      | map(select(
          (.value.pid // 0) as $p
          | ($p | tostring) as $ps
          | ($p > 0)
        ))
      | from_entries
    ' "$ports_file" > "$tmp" 2>/dev/null || echo '{}' > "$tmp"
    # Filter out pids that aren't alive right now.
    local live_tmp; live_tmp="${ports_file}.live.$$"
    echo '{}' > "$live_tmp"
    while IFS=$'\t' read -r p pid; do
      [[ -z "$p" ]] && continue
      if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
        jq --arg p "$p" --slurpfile orig "$tmp" \
          '. + {($p): $orig[0][$p]}' "$live_tmp" > "${live_tmp}.2" \
          && mv "${live_tmp}.2" "$live_tmp"
      fi
    done < <(jq -r 'to_entries[] | "\(.key)\t\(.value.pid // 0)"' "$tmp")
    mv "$live_tmp" "$ports_file"
    rm -f "$tmp"
  else
    echo '{}' > "$ports_file"
  fi

  for (( port = OC_PORT_RANGE_START; port <= OC_PORT_RANGE_END; port++ )); do
    if jq -e --arg p "$port" 'has($p)' "$ports_file" >/dev/null 2>&1; then
      continue
    fi
    if ! oc_port_is_free "$port"; then
      continue
    fi
    tmp="${ports_file}.tmp.$$"
    jq --arg p "$port" --arg issue "$issue" --argjson pid $$ --arg ts "$now" \
      '. + {($p): {issue:$issue, pid:$pid, allocated_at:$ts}}' \
      "$ports_file" > "$tmp" && mv "$tmp" "$ports_file"
    exec 209>&-
    echo "$port"
    return 0
  done

  exec 209>&-
  return 1
}

# Release a port back to the pool. Idempotent; missing entries are no-ops.
oc_release_port() {
  local port="$1"
  local ports_file lock_file
  ports_file=$(oc_ports_file)
  lock_file=$(oc_ports_lock)
  [[ -f "$ports_file" ]] || return 0

  exec 210>"$lock_file"
  flock 210
  local tmp; tmp="${ports_file}.tmp.$$"
  jq --arg p "$port" 'del(.[$p])' "$ports_file" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$ports_file"
  exec 210>&-
}

# jq filter that extracts the last assistant message text from
# /session/<id>/message responses. Verified against opencode 1.14.26
# shape: each message is `{info:{role:"..."}, parts:[{type:"text",
# text:"..."}, ...]}`. Defensive across plausible top-level shapes
# (top-level array, {messages:[...]}, {data:[...]}, {items:[...]})
# and falls back through alternate role / text accessors so a future
# minor opencode revision is less likely to silently regress this.
OC_LAST_ASSISTANT_JQ='
  ( . // [] )
  | ( if type == "object" then (.messages // .data // .items // []) else . end )
  | [ .[] | select(((.info.role // .role // .message.role) // "") == "assistant") ]
  | last
  | if . == null then ""
    else
      (
        ((.parts // []) | map(select(.type == "text") | .text // "") | join(""))
        // .text
        // .content
        // ((.message.content // []) | map(.text // "") | join(""))
        // ""
      )
    end
'
