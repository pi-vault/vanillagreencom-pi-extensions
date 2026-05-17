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

## Dashboard

Flightdeck ships a ratatui terminal dashboard that opens automatically in its own tmux window when you run `flightdeck start`. It shows:

- Tracked sessions with state, kind (adhoc / issue / workflow), harness, title, PR/branch, age, last decision.
- Pause-for-user banner above the table when flightdeck is waiting on you.
- Cross-harness cost and token totals, with a per-source breakdown popup.
- Activity feed, conversations, decisions log, conflict/merge planning, and daemon health, each on its own tab.
- Themes (`moon`, `dawn`, `pantera`, `system`) selectable from the picker (`T`) or `--theme`.

Most actions are read-only. The only writes are confirmation-gated: prune a stale registry entry (`D`), or focus a tmux window (`g`).

Manual invocations a power user might want:

```bash
flightdeck-dashboard tui                            # current tmux session, live
flightdeck-dashboard tui --session <name>           # any past or current session
flightdeck-dashboard tui --demo                     # try it without a live session
```

Rebuild the release binary after pulling changes:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard && cargo build --release
```

The trampoline falls back to `cargo run --release` if no release binary is present.

## Settings worth knowing

Most users never touch these. The ones that occasionally matter:

| Variable | What it does |
| --- | --- |
| `FLIGHTDECK_AUTO_MERGE` | Set to `0` to require a human OK on every merge instead of auto-handling the obvious case. Useful for compliance-sensitive repos or big-blast-radius PRs. |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | How long flightdeck waits before force-merging a PR that's approved + green but stuck in GitHub's `UNKNOWN` merge state (default 4 minutes). |
| `FLIGHTDECK_LAUNCH_MODEL` / `FLIGHTDECK_LAUNCH_EFFORT` | Default model + thinking level for spawned agents when the user doesn't pass them explicitly. |
| `FLIGHTDECK_STATE_DIR` | Where flightdeck writes its session state file inside the project. Defaults to `tmp/`. |
| `FLIGHTDECK_ACTIVITY_FILE` | Override the activity JSONL sidecar path for wrapper/workflow emitters and `flightdeck-state activity append`. |
| `FLIGHTDECK_DASHBOARD` | Set to `0` to disable the dashboard launch hook silently. |
| `FLIGHTDECK_DASHBOARD_WINDOW` | Tmux window name for the dashboard launch hook. Defaults to `flightdeck`. |
| `FLIGHTDECK_DASHBOARD_THEME` | Dashboard theme: `moon` (default), `dawn`, `pantera`, or `system`. |
| `FLIGHTDECK_DASHBOARD_MOTION` | Dashboard motion level: `full`, `reduced`, or `off`. `NO_MOTION` and `NO_COLOR` also disable motion. |
| `FLIGHTDECK_DASHBOARD_BELL` | Set to `0` to suppress the terminal bell when flightdeck pauses for you. |
| `FLIGHTDECK_DASHBOARD_QUICK_FOCUS` | Set to `1` to make `g` focus a tmux window without the confirmation popup. Prune always confirms. |
| `FLIGHTDECK_DASHBOARD_PRICING_FILE` | Path to a pricing TOML override for dashboard cost calculations. |

Activity history lives beside the master state as `<FLIGHTDECK_STATE_DIR>/flightdeck-activity-<session>.jsonl`. The dashboard's Activity tab reads it; you can also tail or export it with `flightdeck-state activity tail|export`.

Daemon-private files live outside your project under `$XDG_RUNTIME_DIR/flightdeck` (fallback `/tmp/flightdeck-$UID`) so they don't show up in commits.

Daemon tuning (`FD_*` env vars) and contributor-only knobs are documented in [`DEVELOPMENT.md`](./DEVELOPMENT.md). Defaults work for normal use.

## Out of scope

- Flightdeck does not abort issues for you — only you can.
- Flightdeck does not respawn dead panes.
- Flightdeck operates within one tmux session at a time. Multiple sessions are independent.
- Flightdeck does not bypass the parallel-safety check that orchestration runs before spawn. If that check says no, flightdeck doesn't override.
