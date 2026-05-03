# pi-qol

![QOL session search](./assets/qol-session-search.png)

![QOL session prompt picker](./assets/qol-session-prompts.png)

![QOL session actions](./assets/qol-session-actions.png)

Quality-of-life extension for Pi.

## What it provides

- Reliable multiline input: `Shift+Enter` / `Shift+Return` inserts a newline when the terminal reports it distinctly; `ctrl+j` is the default fallback newline key. `Alt+Enter` is reserved for Pi follow-up messages.
- Compact image placeholders: existing pasted image paths can collapse to `[Image #N]` aliases and are attached on submit.
- Session naming: `/rename [name]` sets or shows the friendly session name; automatic first-prompt naming is enabled by default.
- Context usage: `/context` prints an inline Claude-style context-window visualization with estimated Pi/model category breakdowns.
- Previous-session search: `/search` and optional `F3` overlay search prior sessions, preview snippets, resume, inject summarized context, or start a new session with summarized context.
- Handoff: `/handoff <goal>` drafts a focused prompt for a new session, preserving the latest compaction summary plus retained branch entries.
- Optional permission gate: when enabled, prompts before configured `bash` tool command fragments run; default match is `rm -Rf`.
- Notifications: terminal/tmux/native notifications for ready-for-input, questions, direction needed, task completion, and critical/blocked states.
- Optional custom compaction and idle compaction; disabled by default so Pi's compaction behavior is unchanged until enabled.
- Thinking timer next to collapsed `Thinking...` labels; enabled by default and falls back to Pi defaults if internals change.

## Commands

| Command | Action |
| --- | --- |
| `/qol status` | Show QOL status and key settings. |
| `/qol notify-test` | Send a test notification. |
| `/qol rename` | Regenerate the current session name from the first user prompt. |
| `/qol rename full` | Regenerate the session name from the full conversation. |
| `/rename [name]` | Set or show the current session's friendly name. |
| `/context` | Show inline context-window usage, model/context limit, and estimated category breakdowns. |
| `/search [query]` | Open previous-session search, optionally prefilled with a query. |
| `/search refresh` | Refresh the session search cache. |
| `/handoff <goal>` | Draft a focused handoff prompt for a new session. |

`/qol` and `/search` arguments support autocomplete.

## Settings

Settings are exposed through `pi-extension-manager` under **QOL**.

### Session auto-rename

- `sessionAutoRename.enabled`: automatically name unnamed sessions after the first prompt/agent turn; default on.
- `sessionAutoRename.model`: naming model (`provider/model`, `current`, or `cheapest`); default `openai-codex/gpt-5.4-mini`.
- `sessionAutoRename.fallbackModel`: fallback model; default `current`, or `none`/`off` to skip.
- `sessionAutoRename.fallback`: deterministic fallback when model naming fails: `words`, `truncate`, or `none`.
- Advanced knobs: `prefix`, `maxInputChars`, `maxNameChars`, `maxTokens`, `timeoutMs`, `prompt`, `notify`, and `debug`.

### Session search

- `sessionSearch.enabled`: register `/search` and the overlay.
- `sessionSearch.shortcutKey`: shortcut to open search; default `f3`, set `none` to disable.
- `sessionSearch.sortMode`: `relevance` or `recent`.
- Result/layout knobs: `resultLimit`, `maxVisible`, `messageMaxVisible`, `previewSnippets`, `overlayWidth`, `cacheTtlSeconds`.
- Summary knobs: `summaryModel`, `summaryMaxTokens`, `summaryInputMaxChars`.

Search rows use Pi's `/resume`-style title: explicit session name, otherwise first user prompt, otherwise filename. The session cache is warmed on session start/first use and, by default, kept until `/search refresh`; set `cacheTtlSeconds` above `0` if you want automatic time-based refreshes.

### Context usage

- `enableContextCommand`: register `/context`; default on. The display uses Pi's `ctx.getContextUsage()` for total tokens/context window, then estimates the category split from the current system prompt, active tool definitions, session messages, compact summaries, context files, skills, and custom agents when Pi exposes that structured data.

### Notifications

- Master and trigger toggles: `notification.enabled`, `onAgentReady`, `onDirectionNeeded`, `onQuestion`, `onTaskComplete`, `onCritical`.
- Channels: BEL, native terminal notifications, tmux client TTY writes, tmux messages, optional tmux window marking, and Pi UI notifications.
- `notification.oscProtocol`: `auto`, `osc777`, `osc99`, or `off`; `auto` uses Kitty OSC 99 when available, otherwise OSC 777.
- Tuning: `cooldownSeconds`, `title`, `readyMessage`, `bodyMaxChars`, `tmuxMessageDurationMs`, and tmux mark text/duration.

Use `/qol notify-test` to verify your terminal/tmux notification path.

### Permission gate

- `permissionGate.enabled`: ask before matching `bash` tool calls; default off. When enabled, non-interactive matches are blocked.
- `permissionGate.commands`: comma-separated literal fragments or `/pattern/flags` regexes; default `rm -Rf`.
- `permissionGate.previewLines` / `permissionGate.previewChars`: cap the approval prompt preview; long commands show a compact head/tail preview while the full command still runs only if approved.

### Compaction

- `compaction.customEnabled`: use QOL custom summaries for Pi compaction events; default off.
- `compaction.model`: summarizer model; default `google/gemini-2.5-flash`.
- `compaction.profile`: `concise`, `balanced`, or `exhaustive`.
- `compaction.remoteEnabled` / `compaction.remoteEndpoint`: call a remote summarizer with `{ systemPrompt, prompt, maxTokens }` and expect `{ summary }`.
- `compaction.branchSummaryEnabled`: use the same summarizer for requested `/tree` branch summaries.
- `compaction.idleEnabled` and related thresholds: extension-managed idle compaction trigger.

### Thinking timer

- `thinkingTimer.enabled`: show elapsed time next to collapsed `Thinking...` labels when the model emits thinking blocks.

## Notes

Pi owns native pending image attachment state and does not expose it to extensions. QOL can attach image paths it collapses itself; native Pi paste/drag attachments remain Pi-owned.
