## pi-agents-tmux — `subagent`, `steer_subagent`, `get_subagent_result`, `stop_subagent`

`subagent` delegates work to a project-defined agent (loaded from `.pi/agents`, with `.claude/agents` as a compatibility source). Agents with `pane: true` run in persistent tmux panes and survive across turns; others are one-shot. Child tools default to the parent's active tools minus the agent's `deny-tools:`.

Use when: isolated context for a focused task; specialist review (security, performance, design); reconnaissance/planning/read-only investigation that can run in parallel; multiple independent investigations via `tasks: [...]` (parallel) or `chain: [...]` (sequential, with `{previous}` placeholder).

Do not use for: trivial work the parent can do directly with read/grep/find; anything where you need streaming tool output to make decisions (results return as a final summary).

Calling rules:
- One self-contained `task` string per delegation — the subagent cannot ask follow-ups.
- Default `agentScope` is `"project"`. Pass `"both"` only when user-level agents at `~/.pi/agent/agents` are explicitly needed.
- Persistent-pane (`pane: true`) dispatches return immediately with a `taskId`. **End your turn after dispatching.** The completion arrives as a follow-up message that wakes you in a new turn — do not call `get_subagent_result` with `wait: true` to block, unless the user asked.
- Save the `taskId`; use `get_subagent_result` only if you suspect a missed wake event. Use `steer_subagent` for mid-run correction, `stop_subagent` to kill/close a pane.
- Stopping kills the tmux process but preserves the session file; the next default `subagent` call resumes it. Pass `forceSpawn: true` only when the user wants a fresh session.
- `confirmProjectAgents: true` gates project-defined agents behind explicit user approval.
