# pi-agents-tmux

https://github.com/user-attachments/assets/36192e57-a6e4-47f9-b47c-dd26920906ae

Pi package for delegating work to specialized agents from a running Pi session.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-agents-tmux):

```bash
pi install npm:@vanillagreen/pi-agents-tmux
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-agents-tmux --harness pi -y
```

Restart Pi after installation.

## What it provides

- `subagent` tool for one-off delegation, parallel delegation, or sequential chains.
- Ships `instructions.md` so vstack/npm install adds `subagent`/`steer_subagent`/`get_subagent_result`/`stop_subagent` usage rules to the scope's `APPEND_SYSTEM.md`, removed on uninstall or disable.
- Project/user agent discovery from `.pi/agents`, `.claude/agents`, and `~/.pi/agent/agents`.
- Persistent tmux panes for agents with `pane: true` frontmatter.
- Grouped, themed completion notifications for persistent pane results.
- Durable task registry plus `get_subagent_result` recovery by `taskId` or latest agent task.
- `steer_subagent` for bridge-based mid-run steering, and `stop_subagent` for killing panes and clearing active registry/dashboard state.
- Session-scoped inbox/outbox handoff, transcript artifacts, and pane registries under `~/.pi/agent/vstack/pi-agents-tmux/sessions/<session-id>/`.
- Auto-sized grid tmux layout for pane agents, reflowed on every spawn, with pane titles like `agent:iced`.

## Tool modes

Single task:

```json
{ "agent": "rust", "task": "Inspect error handling and summarize findings." }
```

Parallel tasks:

```json
{
  "tasks": [
    { "agent": "iced", "task": "Review the widget layout." },
    { "agent": "reviewer-test", "task": "Check test coverage gaps." }
  ]
}
```

Sequential chain:

```json
{
  "chain": [
    { "agent": "scout", "task": "Map the relevant files." },
    { "agent": "planner", "task": "Turn this into a plan: {previous}" }
  ]
}
```

Useful options:

- `agentScope`: `project` (default), `user`, or `both`.
- `cwd`: override working directory for a single task.
- `confirmProjectAgents`: prompt before using project-local agents.

Persistent pane delegations return a `taskId`. Keep it if you need to retrieve or steer the task later.

### Resuming bg agents

Bg (non-pane) agents resume by default per parent session: omitting `sessionKey` uses that agent's `default` lane. Pass `sessionKey: "<stable-id>"` when you want a separate named memory lane:

```json
{ "agent": "reviewer-arch", "task": "Re-review with the new diff.", "sessionKey": "review-PROJ-123" }
```

The extension routes pi at `runtime/sessions/bg-<agent>-<key>.jsonl`. Same `agent + sessionKey` across delegations resumes the same pi session and retains memory; different keys keep separate histories.

Pane agents persist via their own pane session file, so `sessionKey` is ignored when the agent has `pane: true`. Default start/send resumes or reuses that session. To start fresh after stopping a pane, pass `forceSpawn: true` or run `/agents:new <name>`; if a live pane exists, stop it first.

## Commands

| Command | Action |
| --- | --- |
| `/agents` | Open the browser using project scope. |
| `/agents project\|user\|both` | Open the browser with an explicit scope. |
| `/agents show <name> [scope]` | Inspect an agent. |
| `/agents:start <name>` | Start/reuse a live pane or resume the saved pane session. |
| `/agents:new <name>` | Stop any live pane and start with a fresh session file. |
| `/agents:send <name> <task>` | Queue a task for a persistent pane. |
| `/agents:attach <name>` | Focus an existing pane. |
| `/agents:stop <name>` | Stop a persistent pane. |
| `/agents status` | Show pane status. |
| `/agents collect` | Collect completed pane results. |
| `/agents:trace <ref>` | Open/show one trace by task id, short id, or trace ref. |
| `/agents:toggle` | Toggle the persistent dashboard. |

Arguments support autocomplete, including known agent names for `show`, `start`, `new`, `send`, `attach`, and `stop`.

## Browser keys

- Type to search by name, description, source, path, model, tools, or pane status.
- `Tab` / `Shift+Tab` switches scope tabs: project, user, both.
- `↑/↓`, `-/=`, `Home/End` navigate the list; `←/→` switches focus between list and inspector.
- In the inspector, `↑/↓`, `-/=`, `Home/End` scroll the system prompt preview.
- `Enter` inserts `Use agent <name> to: ` into the editor.
- `Alt+M` edits the selected agent's frontmatter (`model`, `deny-tools`, `tools`, `color`). For vstack-managed project agents, changes are written to `[agent-frontmatter.pi]` in `vstack.toml`, the agent is regenerated immediately, and a confirmation dialog shows the updated files.
- For `pane: true` agents, `Ctrl+P` starts/reuses a pane, `Ctrl+O` attaches, and `Ctrl+X` stops it.
- `Esc` clears search or closes.

Agent status legend (Nerd Font glyphs): `` live pane, `` pane-ready/startable, `` stale pane, `·` background. Background-mode agents (no `pane: true`) display as `bg` in user-facing labels; the internal kind is still `oneshot`.

Dashboard row status: `` queued, `` working, `` waiting (idle pane, ready for next task), `` done (background only), `` needs completion, `` failed / blocked. Live panes that finish a task transition to `waiting`, not `done`, since the pane stays alive for the next delegation.

Non-interactive mode emits inline list/show output. Management commands remain available.

## Dashboard widget

The inline agents widget (default toggle `Alt+A`, popup `Alt+Shift+A`; `F3` also opens the popup) shows live state for every spawned agent. Each row carries the agent name, its kind (`pane` or `bg`), and live usage stats refreshed from the transcript jsonl every poll cycle: ` N` (turns), `↑in ↓out` (tokens), and `$cost`. Compact mode aggregates totals across all agents on the trailing line. Expanded mode adds a `Total · ...` line at the bottom. Rows sort by start time so the order is stable while live updates patch usage in place.

Rendering contract: the dashboard/popup owns live lifecycle (`queued`, `working`, `waiting`, `done`, `needs completion`). Inline tool output stays quieter when the dashboard is enabled: pane calls render as launch breadcrumbs, while bg/one-shot calls render the useful result preview without repeating the dashboard's lifecycle row.

## Persistent pane agents

Agents with `pane: true` frontmatter use a persistent tmux pane instead of one-shot JSON mode:

```yaml
---
name: iced
description: Iced UI specialist
tools: read, grep, find, ls, bash, edit, write
deny-tools: bash
model: openai-codex/gpt-5.5:xhigh
color: cyan
pane: true
---
```

Supported agent frontmatter fields:

| Field | Required | Values |
| --- | --- | --- |
| `name` | yes | Unique agent name used in `subagent`, `/agents`, pane title, and task ids. |
| `description` | yes | Short description shown in `/agents` and completions. |
| `tools` | no | Comma-separated Pi tool allowlist, for example `read, grep, find, ls, bash, edit, write, web_research`. This is used only when `subagentToolAccess=frontmatter`; default `all` inherits active parent tools instead. Recursive/prompt tools (`subagent`, `get_subagent_result`, `steer_subagent`, `stop_subagent`, `question`) are stripped even if listed. |
| `deny-tools` | no | Comma-separated Pi tools to subtract from inherited active tools or the strict `tools` allowlist. Prefer this for maintainable restrictions; future parent tools are inherited unless explicitly denied. |
| `model` | no | Pi model id. Shorthands are accepted: `sonnet` → `claude-sonnet-4-5`, `opus*` → `claude-opus-4-5`, `haiku` → `claude-haiku-4-5`. Other values pass through unchanged, including provider ids like `openai-codex/gpt-5.5:xhigh`. |
| `pane` | no | `true`, `yes`, `1`, or `pane` starts/reuses a persistent tmux pane. Omit or use `false` for background one-shot mode. |
| `persistentPane` | no | Legacy alias for `pane`. |
| `color` | no | Statusline badge color for child panes. Valid values: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`. Aliases: `orange` → `yellow`, `purple`/`violet` → `magenta`, `teal` → `cyan`. Unknown/empty values fall back to automatic color cycling. |

Everything after the frontmatter is the agent's system prompt.

The parent Pi session writes tasks to `inbox/<agent>/` and polls `outbox/<agent>/` under the session runtime directory. Sessions, prompt copies, launcher scripts, inbox/outbox, processed files, and pane registries are isolated by Pi session ID and never stored under the project's `.pi/` directory. Completions are surfaced back into the main conversation automatically.

Persistent panes require running Pi inside tmux. Completion files are collected in polling batches and shown as one grouped notification when multiple agents finish together. The notification includes summary, files changed, validation, source/archive paths, and the pane session transcript path.

Pane tasks move through `queued → running → completed|blocked|failed`. If a child pane ends a turn without a valid completion record, the task is kept active and marked `needs_completion` instead of silently remaining queued; the child pane shows a warning asking it to call `complete_subagent`. `get_subagent_result({ "verbose": true })` includes artifact diagnostics for the expected outbox, inbox, processing, done, archive, and transcript paths, and malformed completion JSON is surfaced there instead of being swallowed by the poller.

## Result retrieval and steering

```json
{ "taskId": "iced-...", "wait": true }
```

Use `get_subagent_result` with either `taskId` or `agent` (latest task for that agent). It reads the durable `tasks.json` registry and can poll pending outbox files until a task reaches `completed`, `blocked`, `failed`, or diagnostic `needs_completion`. This is a recovery/status reader for persistent pane tasks; it does not create panes, steer agents, or change Flightdeck/Orchestration ownership rules.

```json
{ "taskId": "iced-...", "message": "Prioritize the failing layout test.", "deliverAs": "steer" }
```

Use `steer_subagent` for mid-run correction. It targets `pi-session-bridge` (`steer`, `send --auto`, or `follow-up`) only when `pi-bridge list --json` contains an exact match for the child pane's registered `sessionFile` under this parent session runtime. It never falls back to matching by cwd. If the exact bridge target is unavailable, it queues a clear steering note in the pane inbox; that fallback is read only when the pane is idle.

Use `stop_subagent` to kill a persistent pane from the parent agent. It removes the pane registry/dashboard row and marks any non-terminal active task as blocked.

## Artifacts and events

- One-shot JSON-mode agents write JSONL transcripts under `transcripts/<agent>/`.
- Persistent panes expose the full visible Pi session JSONL as their transcript path.
- Oversized one-shot final output can still be preserved under `outputs/<agent>/`.
- The extension emits best-effort in-process lifecycle events with legacy `subagents:*` names for compatibility: `subagents:ready`, `subagents:created`, `subagents:queued`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:needs_completion`, `subagents:steered`, and stop events via registry/dashboard cleanup.

## In-process one-shot sessions (not implemented)

A future backend could use Pi SDK `createAgentSession()` for non-pane one-shot agents to reduce process overhead, get direct session events, improve cancellation, and simplify transcript collection. Persistent `pane: true` agents should remain external visible Pi processes because they are intentionally tmux-observable, long-lived, steerable through the session bridge, and inspectable outside the parent turn.

## Settings

`pi-extension-manager` exposes:

- `maxParallelTasks` and `maxConcurrency` for one-shot delegation limits.
- Dashboard controls: `dashboard`, `quietInlineWhenDashboard`, `dashboardMaxItems`, `dashboardCollapsed`, `dashboardShortcut` (default `alt+a` cycles dashboard mode), `popupShortcut` (default `alt+shift+a` opens the full `/agents` browser; `F3` is an additional popup shortcut), and `treeStyle`.
- `collapsedItemCount` for compact result rendering.
- `truncateResults`, `resultMaxBytes` (default 102400), `resultMaxLines` (default 4000), and `preserveFullOutput` for result truncation. Oversized one-shot outputs are saved under `~/.pi/agent/vstack/pi-agents-tmux/sessions/<session-id>/outputs/` when preservation is enabled.
- `completionPollMs` and `childInboxPollMs` for persistent pane polling intervals.
- `forceSessionBridgeForPanes` (default `true`) explicitly loads `pi-session-bridge` in new pane launchers so steering continues to work if settings drift.
- `subagentToolAccess` (default `all`) controls whether child Pi sessions inherit all active Pi tools or receive only the agent `tools:` allowlist. `deny-tools:` and recursive/prompt tool stripping are always applied.
- `subagentModelSource` (default `frontmatter`) controls whether child Pi sessions use the agent `model:` value or inherit the parent session model.
