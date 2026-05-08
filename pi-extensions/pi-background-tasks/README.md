# pi-background-tasks

![Spawning background tasks](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-background-tasks/assets/spawn-tasks.png)
![Task summary](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-background-tasks/assets/task-summary.png)
![Inline mini-dashboard](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-background-tasks/assets/inline-dashboard.png)
![Full dashboard](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-background-tasks/assets/dashboard.png)
Pi package for explicit, non-blocking background shell tasks.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-background-tasks):

```bash
pi install npm:@vanillagreen/pi-background-tasks
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-background-tasks --harness pi -y
```

Restart Pi after installation.

## What it provides

- `bg_task` tool for spawning, listing, tailing logs, stopping, and clearing tracked tasks.
- Ships `instructions.md` so vstack/npm install adds `bg_task`/`bg_status` usage rules to the scope's `APPEND_SYSTEM.md`, removed on uninstall or disable.
- `bg_status` compatibility tool for list/log/stop by PID.
- `/bg` dashboard and task-control command.
- `Alt+.` arms a one-shot diversion so the next not-yet-started bash command runs as a background task instead of blocking the turn.
- `Alt+H` toggles the inline mini-dashboard shown/hidden; `Alt+Shift+H` and `F5` open the full dashboard.
- Automatic diversion of clearly long-running bash monitors such as `watch`, `tail -f`, `journalctl -f`, and session/tmux polling loops.
- Persistent log files under `${PI_BG_TASK_DIR:-$TMPDIR/vstack-pi-bg}`; truncated log output includes the full log path.
- Wakeups when a task exits, and optional wakeups when output matches a substring or `/regex/flags` pattern.

## Commands

| Command | Action |
| --- | --- |
| `/bg` | Open the dashboard. |
| `/bg:next` | Arm the same one-shot diversion as `Alt+.` for the next bash command. |
| `/bg:run <command>` | Spawn a background shell task. |
| `/bg:list` | Show tracked tasks. |
| `/bg log <id\|pid>` | Show a task log tail. |
| `/bg watch <id\|pid>` | Open the dashboard focused on a task. |
| `/bg:stop <id\|pid>` | Terminate a running task. |
| `/bg:clear` | Remove finished tasks. |

Arguments support autocomplete, including task IDs for `log`, `watch`, and `stop`.

## Bash auto-backgrounding

The extension intercepts bash commands before they start. When a command is clearly a monitor or polling loop, it is spawned through the same background-task manager and the foreground bash tool is replaced with a short acknowledgement that includes the background task id, PID, and log path. This keeps the agent turn moving while the command continues to run.

Built-in auto-background matches are intentionally conservative:

- `watch ...`
- `tail -f ...` and `journalctl -f ...`
- delayed Pi session/tmux monitors such as `sleep 50; pi-bridge history ...`
- shell loops with `sleep` that appear to monitor Pi session bridge, tmux panes, agent/delegate state, or long finite/open-ended polling loops

Use `Alt+.` or `/bg:next` when you know the next bash command should be backgrounded even if it does not match the conservative patterns. The shortcut cannot detach a bash process that has already started, because Pi's built-in bash tool does not expose a public process handle to extensions. If pressed while a tool is already running, it applies to the next bash command that has not yet started.

Settings:

- `autoBackgroundBash` toggles built-in automatic diversion.
- `autoBackgroundPatterns` adds newline-separated regular expressions for project-specific monitor commands.
- `backgroundBashShortcut` changes the default `Alt+.` binding, or set it to `none` to disable.
- `dashboardShortcut` changes the default `Alt+Shift+H` full-dashboard binding; `F5` is also registered as an additional dashboard shortcut.
- `forcedBackgroundNotifyOnOutput` optionally wakes the agent on output from shortcut-forced background tasks. Exit wakeups are always enabled for forced tasks.
- `forcedBackgroundWindowSeconds` controls how long `Alt+.`/`/bg:next` stays armed.

## Tool usage

```json
{"action":"spawn","command":"sleep 20; echo done","notifyOnExit":true}
```

Useful `spawn` options:

- `notifyOnExit`: defaults to `true`.
- `notifyOnOutput`: defaults to `false`.
- `notifyPattern`: substring or `/regex/flags` gate for output wakeups.
- `timeoutSeconds`: defaults to `0` (no timeout).
- `title`: optional display label.

## Notes

Tasks are scoped to the current Pi runtime and are stopped on session shutdown. On Unix, shells start in their own process group so `/bg:stop` and shutdown terminate child processes as well as the shell. For Pi bridge, session monitoring, and tmux/agent pane monitoring, prefer `bg_task`, `/bg:run`, or the built-in auto-backgrounding over raw foreground polling loops.

Background tasks inherit Pi's current process environment and working directory. The extension also prepends `${PI_CODING_AGENT_DIR:-~/.pi/agent}/bin` to `PATH` when that directory exists, so installed Pi package CLIs such as `pi-bridge` are available. Project env files such as `.env.local` are not sourced by the shell automatically; they are available only when the invoked framework/tool loads them, or when the command explicitly sources them.

## Attribution

This package is locally owned by vstack and is based on ideas and portions of the MIT-licensed `@ifi/pi-background-tasks` package from `ifiokjr/oh-pi`. See `THIRD_PARTY_NOTICES.md`.
