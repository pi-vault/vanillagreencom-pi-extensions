# Flightdeck — human setup notes

Autonomous mission-control oversight of multi-issue parallel dev sessions running in tmux.

This file is for humans installing or debugging the skill. Agents should read `SKILL.md` instead.

## What it does

When the user invokes flightdeck's `start` workflow (or its parallel-group variant) from main, it launches one or more issue panes via `open-terminal` and the same agent transitions to master overseer of every spawned pane in the current tmux session. The exact invocation syntax depends on the harness (Claude Code uses `/flightdeck start`, Codex uses `$flightdeck start`, OpenCode uses `/flightdeck start` or similar — see your harness docs). It:

- Subscribes to per-pane harness adapter event streams: opencode (HTTP), claude (Channels MCP + JSONL tail), pi (Unix-socket bridge; normal visible Pi TUI, not `--mode rpc`), codex (JSON-RPC over WebSocket app-server). Falls back to bell flag + capture-pane sentinel matching for adapter-unavailable panes.
- Classifies prompts and answers them with learned defaults — adapter-mode responses go through the harness's structured input path (`opencode run --attach` / question API, channel POST, `pi-bridge send` / `answer|reject`, `codex-bridge send`), not tmux send-keys.
- For prompts that trigger sub-agent delegation (rebase resolution, fix delegation), embeds the necessary guidance in the same input as the option pick (a follow-up message arrives too late).
- Watches PR state, builds a file-level conflict graph between in-flight PRs, plans merge order smallest-scope-first.
- Force-merges when a PR is APPROVED + all-green + content-disjoint and GitHub's `mergeStateStatus` has been `UNKNOWN` past the configured threshold.
- Detects scope creep (PR file count >2× declared) and escalates to the user.
- Terminates when every tracked issue is `merged | aborted | dead` and no prompts pending across two consecutive poll cycles.

## When it activates

- Inside tmux only (`$TMUX` set).
- When the user invokes `start` from main — flightdeck calls `open-terminal` for each issue and enters its watch loop.
- For 1 or more issues — single-issue tmux activates flightdeck just as much as multi-issue.

Outside tmux, flightdeck is a no-op.

## Installation

Install via vstack:

```
cd /path/to/your/project
vstack add vanillagreencom/vstack --skill flightdeck -y
```

Flightdeck's required dependencies (`github`, `linear`, `project-management`) are auto-pulled per SKILL.md frontmatter. `decider` and `worktree` are optional. There is no orchestrator role in this repo's root `vstack.toml` — install flightdeck explicitly per project that needs it.

## System Dependencies

- `jq`, `bash` 4+, `flock` (util-linux), `sha256sum`/coreutils, `tmux` 3.x, `gh`

## Testing

Test scripts live under `tests/`.

- `tests/live-wake.sh` is the full live daemon wake smoke test. It requires tmux, a real `pi` binary, GNU bash 5+, GNU date, `jq`, and `git`; runtime is roughly 2 minutes. It spawns a Pi master, starts `flightdeck-daemon --in-tmux-window --master-harness pi`, rings an inner-pane bell, and verifies the wake appears in `pi-bridge history` with `harness=pi via=pi-bridge` in the daemon log.
- `tests/live-wake.sh --no-tmux` is a CI-friendly shape check that validates executable paths and bash syntax without spawning tmux, Pi, or the daemon.

See `tests/README.md` for setup and cleanup of `${FD_STATE_DIR}` artifacts such as `/run/user/$UID/flightdeck/fd-*-s*.*`.

## Configuration (env vars)

See `SKILL.md § Configuration` for the canonical list (master-loop + daemon). Common overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FD_POLL_SEC` | `2` | Daemon inner-pane poll cadence |
| `FD_OC_POLL_SEC` | `2` | OpenCode subscriber base poll cadence |
| `FD_OC_BACKOFF_MAX_SEC` | `16` | Maximum OpenCode subscriber exponential backoff after unchanged `/question` + `/session/<id>/message` polls; resets on new question ids, response hash change, or daemon bell marker |
| `FD_MASTER_TURN_TTL` | `3600` | Maximum master turn duration before the busy lock is treated as stale |
| `FD_WAKE_PENDING_TTL` | `300` | Wake-pending revert threshold when master crashes mid-turn |
| `FD_ADAPTER_FRESHNESS_TTL` | `5` | Seconds to cache HTTP/WebSocket adapter freshness probes (`0` disables cache) |
| `FD_SPAWN_MODE` | `detach` | `detach` (setsid+nohup) or `tmux-window` (visible daemon window); recommended `tmux-window` for codex/opencode/pi/omp |
| `FD_STATE_DIR` | `$XDG_RUNTIME_DIR/flightdeck` (or `/tmp/flightdeck-$UID`) | Daemon-private state directory |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | `240` | UNKNOWN-state wait threshold before considering force-merge |
| `FLIGHTDECK_STATE_DIR` | `tmp` | Master-state file directory (project-relative) |
| `FLIGHTDECK_AUTO_MERGE` | `1` | Set `0` to escalate `merge-now` instead of auto-answering |
| `FLIGHTDECK_LAUNCH_MODEL` | unset | Default `open-terminal --model` override when the workflow/user does not pass `--model` |
| `FLIGHTDECK_LAUNCH_EFFORT` | unset | Default `open-terminal --effort` / thinking override when the workflow/user does not pass `--effort` |
| `FLIGHTDECK_OC_FOLLOWUP_PROMPT` | unset | Override the default `/orchestration start <ISSUE>` followup fired post-spawn (for tests / alt workflows) |

## Scripts

Every script in `scripts/` appears in `SKILL.md`'s Scripts table. No hidden scripts.

| Script | What it does |
|--------|--------------|
| `open-terminal` | Launch worktree(s) with selected harness plus optional `--model`/`--effort` overrides — never hand-roll tmux/terminal commands |
| `parallel-groups` | Read/manage parallel issue groups |
| `flightdeck-state` | Atomic CRUD on `tmp/flightdeck-state-<TMUX_SESSION>.json` (init/get/set/append/increment/archive/master-busy). `init` sweeps stale `.tmp.<PID>` orphans; `archive` rotates terminated state to `<file>-<terminated_at>.json.archive`; `master-busy lock [--master-pane <%N>] [--owner-pid <PID>] \| unlock \| check` writes the daemon's busy-lockfile atomically. Daemon validates the lock by pane-alive + (owner-pid alive if recorded) + `FD_MASTER_TURN_TTL`; if the platform cannot parse `started_at`, the TTL gate is skipped rather than treating the lock as epoch-0 stale. Do NOT pass the calling shell's `$$` |
| `flightdeck-daemon` | External bash wake driver. Per-pane subscribers across all four harnesses (opencode/claude/pi/codex) emit normalized turn-end events into the wake-events log; daemon drains and wakes master on canonical classifier tags. Adapter-unavailable / freshness-failed panes fall back to the legacy capture-pane + bell + hash-stable loop; that fallback caches pane target/window bell/activity/mode metadata from one `tmux list-panes -aF` pass per tick and hashes each captured buffer as a SHA-12 value without the old `cut`/`head` helper pipeline. OpenCode subscribers exponentially back off unchanged polls up to `FD_OC_BACKOFF_MAX_SEC` and reset on new question ids, response hash change, or daemon bell marker. The per-tick subscriber liveness watchdog clears `OC_SUBSCRIBED[pane]` if a sidecar wrapper dies so the pane resumes on fallback. Pi and codex subscriber wrappers reconnect their bridge streams every second after a stream exit. Wake delivery is per-harness, separately on payload and transport. Payload: Pi receives `/skill:flightdeck watch --from-daemon`, Codex receives `$flightdeck watch --from-daemon`, Claude/OpenCode/default receive `/flightdeck watch --from-daemon`. Transport: Pi masters via `pi-bridge send --pid <master_pid>` (tmux paste does not reach Pi's alt-screen input loop); pid resolution prefers the master pane process tree and otherwise requires an unambiguous cwd + process/tty match; all others via `tmux load-buffer + paste-buffer + send-keys Enter`; tmux paste is also the fallback if the Pi bridge is unresolved. Actions: `start [--master-harness <h>] [--inner-harnesses <h1>,...] [--foreground\|--in-tmux-window] [--debug-pane <%N>] \| stop \| status \| health \| find-window \| events \| ack` |
| `codex-app-server-spawn` / `codex-app-server-stop` | Idempotent per-session bring-up + teardown of the codex `app-server --listen ws://...` shared by all `codex --remote` panes |
| `pane-registry` | Issue↔pane mapping wrapper. `init` resolves the immutable tmux `pane_id` (`%N`) alongside `pane_target`; `reconcile` keys liveness on `pane_id` and opportunistically backfills it for legacy entries; `list --format inner-panes` emits `pane_id` when present. Tracks per-harness bridge metadata (oc/cc/pi/cx URL+id+port fields); per-harness `*-bridge-args <ISSUE>` and `find-by-pane <pane-target>` lookups drive adapter dispatch in pane-respond / pane-poll. Adapter-args paths gate on freshness probes (`<h>_adapter_is_fresh`): dead pid/socket, failed HTTP health/message endpoint, or failed Codex bridge RPC → empty stdout → daemon falls back to capture-pane instead of marking the pane subscribed against a dead adapter |
| `pane-poll` | Bell + per-harness adapter (opencode `/session/<id>/message`, claude JSONL tail, `pi-bridge history`, `codex-bridge turns`) or tmux capture-pane fallback + classify. `--batch -` reads a JSON array from `pane-registry list --format json`, resolves tmux metadata once, and emits JSONL per issue for the watch loop. Legacy single-pane mode still accepts `<session>:<window> <pane-index>` or immutable `%N` pane ids directly for drift re-polls/manual debugging. Registry and spawn-file adapter fallbacks both run the same freshness gates before using bridge metadata |
| `pane-respond` | Send to pane: free-text / `--option N` / `--option-multi` / `--keys` / `--question <reqID> --answer "<label>" \| --answer-multi "l1,l2" \| --answer-text "free text" \| --answers-json '[[...]]' \| --reject` (opencode/Pi structured question APIs; Pi free text requires `allowCustom=true`; `--answers-json` handles multi-tab requests). Per-harness adapters route via `opencode run --attach` / question API, channel POST, `pi-bridge send` / `answer|reject`, `codex-bridge send`; tmux paste-buffer fallback. Validates rebase payloads have preserve/apply/verify triplet |
| `pane-clear-bell` | Atomic chained `select-window` cycle |
| `pr-conflict-graph` | File-intersection adjacency for a PR list |
| `prompt-classify` | Sentinel matcher → handler tag |

## Patterns docs

Lessons that motivated this skill, distilled into domain-grouped docs under `patterns/`:

- `tmux-monitoring.md` — pane-0 rule, bell handling, capture-pane idioms, per-harness adapter signals
- `prompt-handlers.md` — cleanup scope, combine-guidance, bot-review skip, rebase template, parent-vs-related, verify-don't-trust
- `conflict-detection.md` — defer-ci semantics, file-intersection algorithm, force-merge predicate
- `decision-biases.md` — smaller-PR-first, scope-creep detector, rule-of-three, expansion bias, merge-order tiebreakers
- `claude-channels.md` — opt-in claude code Channels MCP webhook + JSONL adapter contract, known orchestration-trust limitation
- `opencode-questions.md` — opencode question-tool routing via HTTP API (daemon `oc-question` event → `pane-respond --question`); off-list-label policy
- `pi-questions.md` — Pi `pi-questions` routing via `pi-bridge answer|reject`; custom/free-type answer policy

## Debugging

State file: `tmp/flightdeck-state-<TMUX_SESSION>.json`. Inspect with `jq`.

To see flightdeck's view of the world from outside, run from the project root (or pass `--session <NAME>`):
```
.agents/skills/flightdeck/scripts/flightdeck-state get '.' | jq
```

To see what flightdeck would do for a captured prompt without sending:
```
.agents/skills/flightdeck/scripts/prompt-classify --buffer-file /tmp/captured.txt --dry-run
```

If flightdeck is misbehaving, the most likely cause is a novel prompt shape that doesn't match any classifier sentinel. Check `prompt-classify` against the actual buffer; add a sentinel or escalate as `generic-multi-choice`.

## Pi harness — optional dashboard

When the master agent runs under Pi, the [`pi-flightdeck`](../../pi-extensions/pi-flightdeck/README.md) extension renders a read-only mission-control overlay (pause banner, persistent dashboard widget, `/flightdeck` popup with six tabs) by reading the same on-disk state files master and the daemon already maintain. It never writes — the skill remains the canonical owner of all mutation.

Fully optional. The skill behaves identically with or without the extension; install it (`vstack add vanillagreencom/vstack --pi-extension pi-flightdeck --harness pi -y`) only if you want a live dashboard inside Pi.

## Pause / resume

Flightdeck pauses automatically on:
- detected scope creep needing revert
- force-merge against a real conflict
- issue abort
- `main` mutation
- novel prompt shape

When paused, it sets `paused_for_user` in master state and stops polling. Resume by running `watch` again — it picks up where it left off, including the `unknown_since` timer.

## Termination

When every tracked issue is `merged | aborted | dead` and no prompts pending across two consecutive cycles, flightdeck:
1. Writes `tmp/flightdeck-summary-<SESSION>-<TS>.md` containing:
   - Per-issue outcomes (merged PR #, aborted reason, time elapsed)
   - **New issues created during the run**, grouped by structural relation: children that were absorbed into the parent's PR vs. standalone follow-ups — each row showing `id`, `title`, `parent` (if any), `project`, `priority`
   - **Next-cycle recommendation**: which of the newly-created issues (if any) should be picked up before existing todo / active-cycle work, with a one-line rationale per recommended issue (e.g., "blocks CC-X which is in current cycle", "P2 vs current cycle's P3 backlog", "scope creep finding that should land before related restructure starts")
2. Sets `terminated: true` in master state.
3. Emits a single user-visible line summarizing counts (merged / aborted / new-issues / next-cycle-recommendations).
4. Returns control to orchestration's dashboard.

Panes are NOT closed — pane lifecycle stays with the user.

The next-cycle recommendation is just a recommendation — the user decides whether to start a new flightdeck session on the proposed issues immediately or stick with their planned cycle.

## Out of scope

- No automated abort logic — only the user can abort an issue.
- No re-spawn of dead panes — pane lifecycle is the user's.
- No multi-tmux-session coordination — flightdeck is scoped to the current `$TMUX` session.
- No bypass of orchestration's parallel safety checks — flightdeck activates only after `parallel-check` already cleared the spawn.
