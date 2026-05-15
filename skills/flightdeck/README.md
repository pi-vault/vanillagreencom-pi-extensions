# Flightdeck

Flightdeck supervises AI harness sessions in tmux windows. In core session mode it launches or attaches panes, tracks stable ids, routes prompts, and summarizes completion. Issue orchestration is a built-in domain mode layered on top: GitHub/Linear/worktree decisions, merge planning, and next-cycle recommendations.

> Agents reading this: you want `SKILL.md` instead. Hacking on flightdeck itself: see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## The problem

Running one agent at a time is fine. Running five at once is chaos — each one keeps stopping to ask questions, background tasks finish at odd times, and issue-mode merge order can turn into a guessing game. Flightdeck handles the supervisory layer so you can track generic sessions or spawn a whole issue cycle and walk away.

Activates only inside tmux and only when you ask for it (`flightdeck session start|attach` for core sessions, `flightdeck start` for issue workflows). Outside tmux it's a no-op.

## How it works

Flightdeck launches generic sessions with `flightdeck session start` (or `attach`) or issue agents with `flightdeck start`, always into their own tmux windows, then watches them in parallel. Each agent talks to flightdeck through its native channel (Claude Code MCP, OpenCode HTTP, Pi bridge, Codex app-server) and falls back to tmux when a channel isn't available.

A background daemon detects when an agent has a question, the master agent classifies the prompt, auto-answers when there's a learned default, and pauses for the human when there isn't.

There are two modes per tracked entry:

- **Generic session mode** — structured questions, bash permission prompts, safe bounded choices, Pi background-task exits.
- **Issue mode** — adds GitHub/Linear/worktree decisions: cleanup, rebase, force-push, bot-review/CI recovery, merge planning, scope creep.

When all tracked entries are terminal, flightdeck writes a summary and hands control back.

## Activation and termination

- **Activates** on `flightdeck session start|attach` for generic tracked sessions, or `flightdeck start` for issue workflows, from inside tmux.
- **Pauses** for you on: scope creep that wants reverting, force-merging against a real content conflict, an issue abort, a `main` mutation that needs human OK, domain mismatch, or a novel prompt shape no rule covers. Sets `paused_for_user` in state and stops polling. Resume by running `session watch` or issue `watch` again.
- **Terminates** automatically when every tracked entry is terminal for the relevant mode. Generic-only sessions write a session summary with no GitHub/Linear/worktree calls. Issue sessions write the issue summary, archive the state file, and hand control back.

## Ad-hoc sessions

Ask the agent to track an ad-hoc tmux window (a scratch Pi pane, a log tail, an extra worker) and it will call `flightdeck session start` or `flightdeck session attach` for you. Useful when you want supervision and a dashboard row but no issue/worktree wiring. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the script flag reference.

## Issue workflows

Issue orchestration remains first-class when the session is tied to a Linear/GitHub/worktree domain. Ask the agent to start an issue, check a parallel group for safety, launch the group, watch the session, recompute merge order, or close out the session — it routes to the right flightdeck command for you.

## Install

```bash
cd /path/to/your/project
vstack add vanillagreencom/vstack --skill flightdeck -y
```

Core mode requires tmux only at the workflow/skill-dependency layer, plus the harness adapter you choose for a tracked pane (`pi-bridge`, OpenCode HTTP, Claude Channels, Codex app-server, or tmux fallback). It does not require GitHub, Linear credentials, project-management, or worktree setup.

Issue mode adds the optional `github`, `linear`, `worktree`, and `project-management` skills on demand for `flightdeck start <ISSUE>`, `start new`, `parallel-check`, `merge-plan`, `close-issue`, and issue termination/recommendation workflows.

Runtime requirements for the shipped core scripts remain `bash` 4+, `tmux` 3.x, `jq`, `flock`, and `bun` (https://bun.sh). Issue mode additionally needs the GitHub/Linear CLIs or auth wrappers used by those skills, plus normal git worktree support. Mac users: install GNU coreutils for `sha256sum` and GNU date.

## Rust dashboard (experimental)

`skills/flightdeck/scripts/flightdeck-dashboard launch` is the best-effort startup hook used by Flightdeck. It opens one tracked tmux window through `flightdeck-session start --kind workflow --harness shell`, registers `.entries.flightdeck-dashboard`, and skips cleanly outside tmux, when `FLIGHTDECK_DASHBOARD=0`, or when tmux idempotency probes fail (to avoid duplicate windows). By default it leaves wake delivery to the canonical TypeScript daemon; set `FLIGHTDECK_DAEMON_RUST=1` to have launch start the Rust dashboard daemon, or pass `--no-daemon` for file-mode only.

`skills/flightdeck/scripts/flightdeck-dashboard tui --demo[=NAME]` runs compiled demo fixtures (`empty`, `one-adhoc`, `one-issue`, `mixed`, `terminated`, `paused`, `observer`, `conversations`, `no-issue`, `decisions`). `tui --state-file <path>` reads a concrete master-state JSON file, and `tui --session <name>` resolves `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<name>.json` (default state dir `tmp/`) with terminated-archive fallback. With neither flag inside tmux, the dashboard uses the current tmux session. Live runs watch the state directory with debounced reloads, show stale/archive/pre-purge chips and banners, and populate the Activity tab from daemon/wake JSONL tailers.

Build a prebuilt binary with:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard
cargo build --release
```

The script prefers `lib/flightdeck-dashboard/target/release/flightdeck-dashboard` and falls back to `cargo run --release` when the binary is absent.

## Pi dashboard (optional)

New sessions should prefer the Rust dashboard above. If your master agent runs in Pi and you still want in-editor mission control, the deprecated [`pi-flightdeck`](../../pi-extensions/pi-flightdeck/README.md) extension remains available as a read-only overlay — pause banner, persistent dashboard above the editor, `/flightdeck` popup with six tabs. The skill works identically with or without it.

```bash
vstack add vanillagreencom/vstack --pi-extension pi-flightdeck --harness pi -y
```

## Settings worth knowing

Most users never touch these. The ones that occasionally matter:

| Variable | What it does |
| --- | --- |
| `FLIGHTDECK_AUTO_MERGE` | Set to `0` to require a human OK on every merge instead of auto-handling the obvious case. Useful for compliance-sensitive repos or big-blast-radius PRs. |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | How long flightdeck waits before force-merging a PR that's approved + green but stuck in GitHub's `UNKNOWN` merge state (default 4 minutes). |
| `FLIGHTDECK_LAUNCH_MODEL` / `FLIGHTDECK_LAUNCH_EFFORT` | Default model + thinking level for spawned agents when the user doesn't pass them explicitly. |
| `FLIGHTDECK_STATE_DIR` | Where flightdeck writes its session state file inside the project. Defaults to `tmp/`. |
| `FLIGHTDECK_DASHBOARD` | Set to `0` to disable the Rust dashboard launch hook silently. |
| `FLIGHTDECK_DASHBOARD_WINDOW` | Tmux window name for the Rust dashboard launch hook. Defaults to `flightdeck`. |
| `FLIGHTDECK_DASHBOARD_MOTION` | Rust dashboard motion level: `full`, `reduced`, or `off`. `NO_MOTION` and `NO_COLOR` also disable motion. |
| `FLIGHTDECK_DAEMON_RUST` | Set to `1` to let `flightdeck-dashboard launch` start the Rust daemon; unset/`0` defers daemon ownership to the canonical TypeScript path. |
| `FLIGHTDECK_DASHBOARD_BELL` | Set to `0` to suppress the terminal bell on a new pause-for-user edge. The dashboard never auto-focuses tmux windows. |
| `FLIGHTDECK_DASHBOARD_STALE_WARN_SECS` | Rust dashboard stale-warning threshold in seconds (default `30`). |
| `FLIGHTDECK_DASHBOARD_STALE_DEAD_SECS` | Rust dashboard stale/dead threshold in seconds (default `300`). |

Daemon-private files live outside your project under `$XDG_RUNTIME_DIR/flightdeck` (fallback `/tmp/flightdeck-$UID`) so they don't show up in commits.

Daemon tuning (`FD_*` env vars) is documented in [`DEVELOPMENT.md`](./DEVELOPMENT.md). Defaults work for normal use.

## Out of scope

- Flightdeck does not abort issues for you — only you can.
- Flightdeck does not respawn dead panes.
- Flightdeck operates within one tmux session at a time. Multiple sessions are independent.
- Flightdeck does not bypass the parallel-safety check that orchestration runs before spawn. If that check says no, flightdeck doesn't override.
