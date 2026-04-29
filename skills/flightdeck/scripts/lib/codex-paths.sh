#!/usr/bin/env bash
# Path resolvers + port allocator for the codex app-server adapter.
#
# Codex differs from oc/cc/pi: ONE app-server per flightdeck session
# (not per pane) hosting all per-pane `codex --remote ws://...` TUIs
# as separate threads. Port allocation is per-session, not per-pane.
# Range 41030-41039 (host-global, flock-guarded).
#
# Sourced by codex-app-server-spawn (server lifecycle), open-terminal
# (per-pane spawn after server is up), pane-registry (auto-load),
# pane-respond + pane-poll (read codex bridge metadata),
# flightdeck-daemon (per-pane WS subscriber).

# shellcheck source=daemon-paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/daemon-paths.sh"

CX_PORT_RANGE_START=41030
CX_PORT_RANGE_END=41039

cx_ports_file()    { echo "$(fd_resolve_state_dir)/cx-app-server-ports.json"; }
cx_ports_lock()    { echo "$(fd_resolve_state_dir)/cx-app-server-ports.lock"; }
# Per-session app-server state. SESSION_KEY is the daemon's session
# key (e.g. "s2"); same convention as daemon-paths.sh.
cx_app_server_file() { echo "$(fd_resolve_state_dir)/cx-app-server-$1.json"; }
cx_app_server_log()  { echo "$(fd_resolve_state_dir)/cx-app-server-$1.log"; }
cx_spawn_file()    { echo "$(fd_resolve_state_dir)/cx-spawn-$1.json"; }

cx_pane_id_safe() {
  local id="$1"
  echo "${id#%}"
}

cx_subscriber_pid_file() { echo "$(fd_resolve_state_dir)/fd-cx-subscriber-$(cx_pane_id_safe "$1").pid"; }

cx_port_is_free() {
  local port="$1"
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port" && return 1
  fi
  return 0
}

# Allocate a free port in the codex range, atomically registering it
# in the host-global ports file under flock.
cx_alloc_port() {
  local session_key="$1"
  local ports_file lock_file
  ports_file=$(cx_ports_file)
  lock_file=$(cx_ports_lock)
  [[ -f "$ports_file" ]] || echo '{}' > "$ports_file"

  exec 219>"$lock_file"
  flock 219

  local now port tmp
  now=$(date -Iseconds)

  # Sweep dead pids (best-effort).
  if jq -e 'type == "object"' "$ports_file" >/dev/null 2>&1; then
    local live_tmp; live_tmp="${ports_file}.live.$$"
    echo '{}' > "$live_tmp"
    while IFS=$'\t' read -r p pid; do
      [[ -z "$p" ]] && continue
      if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
        jq --arg p "$p" --slurpfile orig "$ports_file" \
          '. + {($p): $orig[0][$p]}' "$live_tmp" > "${live_tmp}.2" \
          && mv "${live_tmp}.2" "$live_tmp"
      fi
    done < <(jq -r 'to_entries[] | "\(.key)\t\(.value.pid // 0)"' "$ports_file" 2>/dev/null)
    mv "$live_tmp" "$ports_file"
  else
    echo '{}' > "$ports_file"
  fi

  for (( port = CX_PORT_RANGE_START; port <= CX_PORT_RANGE_END; port++ )); do
    if jq -e --arg p "$port" 'has($p)' "$ports_file" >/dev/null 2>&1; then continue; fi
    if ! cx_port_is_free "$port"; then continue; fi
    tmp="${ports_file}.tmp.$$"
    jq --arg p "$port" --arg sess "$session_key" --argjson pid $$ --arg ts "$now" \
      '. + {($p): {session_key:$sess, pid:$pid, allocated_at:$ts}}' \
      "$ports_file" > "$tmp" && mv "$tmp" "$ports_file"
    exec 219>&-
    echo "$port"
    return 0
  done

  exec 219>&-
  return 1
}

cx_release_port() {
  local port="$1"
  local ports_file lock_file
  ports_file=$(cx_ports_file)
  lock_file=$(cx_ports_lock)
  [[ -f "$ports_file" ]] || return 0

  exec 220>"$lock_file"
  flock 220
  local tmp; tmp="${ports_file}.tmp.$$"
  jq --arg p "$port" 'del(.[$p])' "$ports_file" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$ports_file"
  exec 220>&-
}

cx_register_port_pid() {
  local port="$1" pid="$2"
  local ports_file lock_file
  ports_file=$(cx_ports_file)
  lock_file=$(cx_ports_lock)
  [[ -f "$ports_file" ]] || echo '{}' > "$ports_file"

  exec 221>"$lock_file"
  flock 221
  local tmp; tmp="${ports_file}.tmp.$$"
  if jq --arg p "$port" --argjson pid "$pid" \
       '(.[$p] // {}) as $cur | .[$p] = ($cur + {pid: $pid})' \
       "$ports_file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$ports_file"
  else
    rm -f "$tmp"
  fi
  exec 221>&-
}

cx_resolve_codex_bin() {
  if [[ -x /usr/bin/codex ]]; then echo "/usr/bin/codex"; return 0; fi
  local p; p=$(type -P codex 2>/dev/null || true)
  if [[ -n "$p" && -x "$p" ]]; then echo "$p"; return 0; fi
  return 1
}

cx_resolve_bun_bin() {
  if [[ -x /usr/bin/bun ]]; then echo "/usr/bin/bun"; return 0; fi
  local p; p=$(type -P bun 2>/dev/null || true)
  if [[ -n "$p" && -x "$p" ]]; then echo "$p"; return 0; fi
  return 1
}

# Resolve the vendored codex-bridge.ts path. Same as the symbol path
# pattern used for cc-channel-server.
cx_resolve_bridge_script() {
  local p
  p="$(dirname "${BASH_SOURCE[0]}")/../../lib/codex-bridge/bridge.ts"
  if [[ -f "$p" ]]; then
    cd "$(dirname "$p")" && pwd
    return 0
  fi
  return 1
}

cx_bridge_ts_path() {
  local d
  d=$(cx_resolve_bridge_script) || return 1
  echo "$d/bridge.ts"
}

# Run the bun bridge with the given subcommand + args. Used by
# pane-respond, pane-poll, daemon subscriber.
cx_bridge_run() {
  local bun_bin script
  bun_bin=$(cx_resolve_bun_bin) || { echo "bun not found" >&2; return 1; }
  script=$(cx_bridge_ts_path) || { echo "codex-bridge.ts not found" >&2; return 1; }
  "$bun_bin" "$script" "$@"
}

# jq filter: extract last assistant text from `bridge turns` output.
# Verified shape (codex 0.125.0):
#   userMessage: { type:"userMessage", content: [{type:"text", text:"..."}] }
#   agentMessage: { type:"agentMessage", text:"...", phase:"final_answer" }
# agentMessage uses .text directly, NOT .content[].text — different
# from userMessage. Filter tries .text first, falls back to .content
# walk for resilience across versions.
CX_LAST_ASSISTANT_JQ='
  ( [ ( .data // [] ) | .[]? | (.items // [])[] | select(.type == "agentMessage") ] | last )
  | if . == null then ""
    else
      ( .text
        // ( ( .content // [] )
             | (if type == "array" then map(select(.type == "text") | .text // "") | join("") else . end) )
        // "" )
    end
'
