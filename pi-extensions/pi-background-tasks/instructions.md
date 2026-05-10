## pi-background-tasks — `bg_task` and `bg_status`

`bg_task` runs shell commands without blocking the conversation; `bg_status` inspects/stops them. Use these instead of `nohup`, `&`, `disown`, or foreground polling loops.

Use `bg_task action: "spawn"` for long-running processes that should outlive the turn: dev servers, watchers, log tails, build daemons, agent panes — anything you'd otherwise background with `&`. Foreground monitor loops (`while true; do …; sleep N; done`) auto-divert into a background task; continue the turn and inspect later, do not wait on the foreground bash.

`bg_status` actions: `list`, `log` (by pid/id), `stop` (SIGTERM to process group). `bg_task` adds `clear` to drop finished entries.

Spawn parameters worth knowing:
- `notifyOnExit` (default true) wakes you when the task exits.
- `notifyOnOutput` + `notifyPattern` wake on substring or `/regex/flags` matches in new output.
- `timeoutSeconds` defaults to 0 (disabled); set only when you actually want a timeout.

Rules:
- Never spawn a task and then wait on its output in foreground — that defeats the point.
- Stop tasks you started for a turn-scoped purpose before finishing the turn.
