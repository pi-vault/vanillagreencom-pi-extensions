# pi-background-tasks

![Background tasks dashboard](./assets/background-tasks-dashboard.gif)

Pi package for explicit, non-blocking background shell tasks.

## What it provides

- `bg_task` tool for spawning, listing, tailing logs, stopping, and clearing tracked tasks.
- `bg_status` compatibility tool for list/log/stop by PID.
- `/bg` dashboard and task-control command.
- `Ctrl+Shift+B` dashboard shortcut in interactive Pi.
- Persistent log files under `${PI_BG_TASK_DIR:-$TMPDIR/vstack-pi-bg}`; truncated log output includes the full log path.
- Wakeups when a task exits, and optional wakeups when output matches a substring or `/regex/flags` pattern.

## Commands

| Command | Action |
| --- | --- |
| `/bg` | Open the dashboard. |
| `/bg run <command>` | Spawn a background shell task. |
| `/bg list` | Show tracked tasks. |
| `/bg log <id\|pid>` | Show a task log tail. |
| `/bg watch <id\|pid>` | Open the dashboard focused on a task. |
| `/bg stop <id\|pid>` | Terminate a running task. |
| `/bg clear` | Remove finished tasks. |

Arguments support autocomplete, including task IDs for `log`, `watch`, and `stop`.

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

Tasks are scoped to the current Pi runtime and are stopped on session shutdown. On Unix, shells start in their own process group so `/bg stop` and shutdown terminate child processes as well as the shell.

## Attribution

This package is locally owned by vstack and is based on ideas and portions of the MIT-licensed `@ifi/pi-background-tasks` package from `ifiokjr/oh-pi`. See `THIRD_PARTY_NOTICES.md`.
