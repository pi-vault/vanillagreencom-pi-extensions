# Flightdeck — development notes

This file is for agents and humans hacking on flightdeck itself. End users should read [`README.md`](./README.md) instead.

## Implementation

Most scripts under `scripts/` are bash trampolines that exec the TypeScript implementation under `lib/flightdeck-core/src/bin/`. `flightdeck-dashboard` is the Rust/ratatui trampoline under `lib/flightdeck-dashboard/`: it prefers a prebuilt release binary and falls back to `cargo run --release`. `bun` is a hard runtime dependency for the TypeScript scripts. Functional + integration tests live under `lib/flightdeck-core/tests/`. The live-wake suite (`tests/live-wake.sh`) is the smoke test for the daemon `start` run-loop.

## Session model and schema boundary

Flightdeck core is the generic tmux-session manager. It owns `TrackedEntry` lifecycle, owner metadata, daemon wake routing, generic prompt handling, and stable pane/window ids for any harness session. Issue orchestration is a domain layer on top: it adds GitHub/Linear/worktree metadata under `entry.domain.issue`, issue-specific lifecycle states (`merge-ready` / `merged` / `aborted`), PR conflict graphs, merge queues, and next-cycle recommendations.

`flightdeck-state init` writes `entries`, `merge_queue`, `conflict_graph`, and `owner`. All readers go through `readTrackedEntries(state)` for the canonical `TrackedEntry` view; `writeTrackedEntry` validates `entry.id` plus optional `entry.domain.issue.id` and stores the entry under `entries[id]`.

Use the TrackedEntry seam everywhere new code reads tracked sessions. Core helpers (`readTrackedEntries`, `writeTrackedEntry`, `entryIdForIssue`, `issueIdForEntry`) live under `lib/flightdeck-core/src/state/`; `pane-registry list --format json` and `flightdeck-state tracked-entries` expose the same normalized view to scripts. `pi-flightdeck` consumes the same seam via read-only `TrackedSession` / `TrackedState` render types, reads `.entries`, and uses `owner.pane_id` for default owner-scoped rendering.

## `flightdeck-session` flag reference

The README points users at natural-language invocation; this is the underlying script's actual surface for contributors and AI callers. All `start` invocations use `tmux new-window` (never split panes), set `FLIGHTDECK_MANAGED=1` + `FLIGHTDECK_CHILD_PANE=1` in the launched environment, capture stable `pane_id`/`window_id`, and register through `pane-registry init-entry`.

```bash
# Managed ad-hoc Pi session.
skills/flightdeck/scripts/flightdeck-session start \
  --session-id scratch-pi \
  --title "Scratch Pi" \
  --cwd "$PWD" \
  --harness pi \
  --prompt "Investigate this repo and report risks" \
  --kind adhoc

# Arbitrary shell command in a tracked tmux window.
skills/flightdeck/scripts/flightdeck-session start \
  --session-id logs-1 \
  --title "Log watcher" \
  --cwd "$PWD" \
  --harness shell \
  --cmd "tail -f tmp/app.log"

# Attach an existing pane without launching a new window.
skills/flightdeck/scripts/flightdeck-session attach \
  --pane %33 \
  --harness pi \
  --title "Manual Pi"
```

`pane-registry list --format json` returns normalized entries for both ad-hoc and issue rows. `session watch` uses the generic session loop; issue `watch` layers merge/PR workflow logic on top. Issue-only prompt tags on ad-hoc sessions trigger a `domain-mismatch` guard; lookups that cannot determine `kind` must pass `--entry-kind-unknown` to fail closed.

## Daemon tuning (`FD_*` env vars)

The background daemon (`flightdeck-daemon`) is configurable but defaults are fine for normal use. Listed for advanced setups:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FD_POLL_SEC` | `2` | Inner-pane poll cadence. |
| `FD_OC_POLL_SEC` | `2` | OpenCode subscriber base poll cadence. |
| `FD_OC_BACKOFF_MAX_SEC` | `16` | Maximum OpenCode subscriber exponential backoff after unchanged polls; resets on new question ids, response hash change, or daemon bell marker. |
| `FD_GRACE_SEC` | `30` | Cold-start grace per pane; bells suppressed during this window. |
| `FD_WAKE_PENDING_TTL` | `300` | Wake-pending revert threshold when master crashes mid-turn. |
| `FD_MASTER_TURN_TTL` | `3600` | Maximum master turn duration before the busy lock is treated as stale. |
| `FD_ADAPTER_FRESHNESS_TTL` | `5` | Adapter freshness probe cache. Set `0` to disable during debugging. |
| `FD_ADAPTER_READ_TIMEOUT_SEC` | `2` | Per-adapter read subprocess timeout. Fractional seconds honored. |
| `FD_SPAWN_MODE` | `detach` | `detach` (setsid+nohup) or `tmux-window` (visible daemon window). Use `tmux-window` for codex/opencode/pi masters where backgrounding is unreliable. |
| `FD_MAX_LIFETIME` | `14400` | Seconds before daemon restarts itself for a fresh process (`0` disables). |
| `FD_STATE_DIR` | `$XDG_RUNTIME_DIR/flightdeck` (or `/tmp/flightdeck-$UID`) | Daemon-private state directory. Must be user-owned, mode `0700`. |

## Top-level scripts

Not run by hand in normal use — the skill calls them.

- `open-terminal` — launches issue worktree tmux windows with the chosen harness.
- `flightdeck-session` — launches or attaches generic tracked tmux sessions without fake issue ids.
- `flightdeck-state` — reads/writes the session's master state file, including tracked-entry normalization (`tracked-entries`, `write-entry`).
- `flightdeck-daemon` — background poller; wakes the master.
- `flightdeck-dashboard` — Rust/ratatui standalone dashboard; `launch` opens the tracked workflow dashboard window and optionally starts the Rust daemon. Also supports demo fixtures plus `tui --state-file <path>` and `tui --session <name>` live-state reads with terminated-archive fallback, debounced file watching, stale/archive banners, and Activity feed scaffolding.
- `pane-registry`, `pane-poll`, `pane-respond` — pane tracking and IO.
- `prompt-classify` — pattern-matches agent output against known prompt shapes; guards issue-only tags on non-issue entries as `domain-mismatch`.
- `pr-conflict-graph`, `parallel-groups` — issue-mode merge-order planning.
- `codex-app-server-spawn` / `-stop` — Codex bridge server lifecycle.

Full per-script descriptions follow in the [Scripts](#scripts) section below.

## Tests

### Bun test suite

Functional + unit tests for every script. Run from the core package:

```bash
cd skills/flightdeck/lib/flightdeck-core
bun test
bun run typecheck
```

The live-wake suite (`tests/live-wake.sh`) must pass before shipping any change to the daemon run-loop, classifier, or pane I/O wiring.

### Rust dashboard

Run from the dashboard crate:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo insta test
cargo run --release -- tui --demo
cargo run --release -- tui --state-file ../../tests/fixtures/state/entries-happy.json
```

`flightdeck-dashboard launch` is the Flightdeck startup hook. It is best-effort: outside tmux it prints `flightdeck-dashboard: not in tmux; skipping launch`, `FLIGHTDECK_DASHBOARD=0` exits silently, `--no-daemon` skips Rust daemon startup, and `FLIGHTDECK_DAEMON_RUST=1` opts into `daemon start --detach` before opening the tracked workflow window through `flightdeck-session start`. The trampoline exports `FLIGHTDECK_SKILL_DIR` so installed `.agents/skills/flightdeck` projects can find sibling scripts. Use `FLIGHTDECK_DASHBOARD_WINDOW` and `FLIGHTDECK_DASHBOARD_MOTION` (or CLI `--window-name` / `--motion`) for local launch smoke variants; `NO_MOTION`/`NO_COLOR` force `--motion off` for launched TUI children.

Snapshots live under `tests/snapshots/`; update intentionally with `INSTA_UPDATE=always cargo insta test`, then review the `.snap` diff before committing. Phase 7 parity smoke steps for terminal bell, no-auto-focus pause behavior, and live observer panes live in `docs/work-in-progress/flightdeck-dashboard-parity-smokes.md`. Watcher tests use `notify-debouncer-full` against temp dirs; if they fail locally, verify the filesystem supports native file notifications.

### Live wake

Exercises the full daemon wake path against a real Pi master. Useful after daemon or `pane-poll` changes. Takes ~2 minutes; requires tmux and a real `pi` binary.

```bash
tests/live-wake.sh
tests/live-wake.sh --no-tmux    # quick shape-check for CI
```

See `tests/README.md` for setup and cleanup.

## Debugging

The session state file lives at `tmp/flightdeck-state-<TMUX_SESSION_NAME>.json`:

```bash
.agents/skills/flightdeck/scripts/flightdeck-state get '.' | jq
```

If flightdeck seems stuck on a prompt, the usual cause is a novel prompt shape the classifier doesn't recognize. The skill escalates these as `generic-multi-choice` for human review. Add a sentinel to `prompt-classify` if it's worth automating.

## Operational caveats

- **Worst-case wake latency on master crash**: `FD_WAKE_PENDING_TTL + FD_POLL_SEC` (default 302s). If master crashes between turn-start and ack-clear, the daemon waits one TTL before reverting in-flight state and re-firing.
- **State directory privacy**: `FD_STATE_DIR` (default `$XDG_RUNTIME_DIR/flightdeck`, fallback `/tmp/flightdeck-$UID`) must be user-owned and mode `0700`.
- **PID reuse race**: stranded `.draining.<pid>` files and stale `BUSY_FILE` recovery can be delayed if the kernel reuses a PID before the next startup GC. Acceptable in practice — startup GC sweeps within seconds of next daemon start.

## Operational caveats

- **Batch polling is timeout-bounded but still sequential.** Adapter reads honor `FD_ADAPTER_READ_TIMEOUT_SEC` so no single pane can wedge the tick, but panes are still polled one after the other. Full async parallelism arrives in a later iteration.
- **Daemon PID changes across `FD_MAX_LIFETIME` boundaries.** The daemon spawns a detached successor on max-lifetime rollover instead of `exec`-replacing itself in place. PID_FILE is updated by the successor; external watchers must re-read PID_FILE each call rather than caching the initial PID. The successor is invoked with the internal `--from-handoff` flag so it preserves the predecessor's wake-pending / events / wake-events.log instead of running the fresh-start wipe. Master and pi-flightdeck dashboard contracts are unaffected (master uses `BUSY_FILE.pid` which is the master's own PID, not the daemon's; the dashboard re-reads PID_FILE each tick).
- **Session-lock hot path uses in-process `flock(2)`** via `bun:ffi` for per-tick session-lock decisions, avoiding a per-call `flock(1)` fork. Falls back to spawning `flock(1)` on runtimes where `bun:ffi` can't dlopen libc.
- **Subscribers carry a parent-watchdog.** Each subscriber polls the daemon's PID every 5s and exits cleanly when the daemon dies, so a crashed daemon doesn't orphan tail/jq processes.

## Adapter read recovery

`FD_ADAPTER_READ_TIMEOUT_SEC` caps each adapter read subprocess (`curl`/`pi-bridge`/`codex-bridge`/`gh`) in `pane-poll`. Fractional seconds are honored. When an adapter read times out or returns an empty body, `pane-poll` clears the per-harness `*_used` flag and falls through to `tmux capture-pane` on the same tick. A wedged opencode/pi/codex adapter therefore recovers via tmux instead of classifying as idle until the freshness probe expires.

## Scripts

Detailed list of what each script does, for debugging or porting work:

| Script | What it does |
| --- | --- |
| `open-terminal` | Launches a new tmux window with the chosen harness running on the chosen issue worktree. |
| `flightdeck-state` | Reads/writes the session's master state file, including tracked-entry normalization (`tracked-entries`, `write-entry`). |
| `flightdeck-daemon` | Background poller. Wakes the master when an agent needs attention. |
| `flightdeck-dashboard` | Rust/ratatui dashboard trampoline. `launch` is the best-effort startup hook that registers `.entries.flightdeck-dashboard` via `flightdeck-session start --kind workflow`; `--no-daemon` keeps file-mode behavior, while `FLIGHTDECK_DAEMON_RUST=1` starts the Rust daemon. `tui --demo[=NAME]` uses compiled fixtures; `tui --state-file <path>` reads a concrete master-state JSON; `tui --session <name>` resolves `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<name>.json` and falls back to newest valid `*.json.archive`. Live TUI mode watches state/archive paths with debounce, tails daemon/wake JSONL into the Activity tab, and surfaces stale/source-state indicators. |
| `pane-registry` | Tracks which tracked entry (issue or adhoc session) lives in which tmux pane and how to talk to its agent. |
| `pane-poll` | Reads an agent's current state (via native channel where possible). |
| `pane-respond` | Sends a reply or option pick into an agent. |
| `prompt-classify` | Pattern-matches an agent's last output against known prompt shapes. |
| `pr-conflict-graph` | Builds a file-overlap graph between PRs so flightdeck can pick a safe merge order. |
| `parallel-groups` | Reads parallel-execution groups for the current planning cycle. |
| `codex-app-server-spawn` / `-stop` | Brings up / tears down the shared Codex bridge server for codex-mode sessions. |
| `pane-clear-bell` | Clears the tmux bell flag without screen flicker after answering. |
