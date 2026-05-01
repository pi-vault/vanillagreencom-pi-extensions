# pi-qol

Quality-of-life extension for Pi.

Features:

- Intercepts distinguishable `Shift+Enter` / `Shift+Return` in the prompt editor and inserts a newline.
- Provides a configurable fallback newline key (`ctrl+j` by default) for terminals/tmux setups that collapse modified Enter into plain Enter. If a terminal reports Shift+Enter as Alt+Enter, move `app.message.followUp` to another key and bind `alt+enter` to `tui.input.newLine` in Pi keybindings.
- Styles `[Image #1]`, `[Image #2]`, ... placeholders as compact filled chips in the editor using the active theme's `accent` color.
- Collapses existing pasted image file paths to `[Image #N]` aliases and attaches those images on submit.
- Adds `/session-name [name]` to set or show the current session's friendly name in Pi's session selector (toggle with `enableSessionNameCommand`, default on).
- Adds `/handoff <goal>` to generate a focused handoff prompt, optionally review it, and open a new session with that prompt as a draft (toggle with `enableHandoffCommand`, default on; review with `handoffReviewPrompt`, default on).
- Prompts before configured bash command fragments run through the agent `bash` tool. Default prompt list is `rm -Rf` only.
- Sends external terminal/tmux notifications when Pi is ready for input, asks a structured question, appears to need direction, completes a full task list, or reports critical/blocked information. Channels include BEL, OSC 777/OSC 99, Windows Terminal toast, and optional tmux `display-message`.
- Optionally overrides Pi compaction summaries with a custom summarizer modeled after Pi's `custom-compaction.ts` example. It can use a configured model (default `google/gemini-2.5-flash`) or a remote HTTP endpoint, supports concise/balanced/exhaustive summary profiles, and can also override requested `/tree` branch summaries.
- Optionally triggers idle compaction after a configurable idle delay and token threshold, inspired by oh-my-pi's idle compaction settings. Pi's built-in compaction settings still control normal automatic overflow/threshold compaction.
- Shows a live elapsed timer next to collapsed `Thinking...` labels and leaves the final duration when thinking ends (toggle with `thinkingTimer.enabled`, default on). This uses a defensive internal renderer patch and fails back to Pi's default label if Pi internals change.

Commands:

- `/qol status`
- `/qol notify-test`
- `/qol attachments`
- `/qol collapse`
- `/qol reset`
- `/session-name [name]`
- `/handoff <goal>`

## Notification settings

All are exposed through `pi-extension-manager` under **QOL**:

- `notification.enabled`: master toggle.
- Trigger toggles: `notification.onAgentReady`, `notification.onDirectionNeeded`, `notification.onQuestion`, `notification.onTaskComplete`, `notification.onCritical`.
- Channel toggles: `notification.bell`, `notification.bellWhenActive`, `notification.native`, `notification.tmuxNativeClientTty`, `notification.tmuxWindowMark`, `notification.tmux`, `notification.tmuxPassthrough`, `notification.piUi`.
- Terminal protocol: `notification.oscProtocol` (`auto`, `osc777`, `osc99`, `off`). `auto` uses Kitty OSC 99 when available, otherwise OSC 777; Windows Terminal/WSL uses a toast via PowerShell.
- tmux notes: BEL resolves `$TMUX_PANE` to `#{pane_tty}` and writes raw `\a` to that source pane, matching Claude-style tmux bell hooks so tmux can apply your normal `window_bell_flag` styling. BEL and optional tmux window marking are skipped when the source tmux window is already active unless `notification.bellWhenActive` is enabled, reducing noise while you are looking at Pi. OSC terminal notifications default to direct writes to attached tmux client TTYs (`notification.tmuxNativeClientTty`) so Ghostty/system notifications can appear even when the source Pi window is inactive; passthrough remains a fallback. `pi-questions` notifies before the prompt takes over input. Optional `tmuxWindowMark` can additionally prefix the source window name (default off); clear happens on next input/agent start/reset, or by `notification.tmuxWindowMarkDurationMs` if nonzero.
- Tuning: `notification.cooldownSeconds`, `notification.title`, `notification.readyMessage`, `notification.bodyMaxChars`, `notification.tmuxMessageDurationMs`, `notification.tmuxWindowMarkText`, `notification.tmuxWindowMarkDurationMs`.

Use `/qol notify-test` to verify your terminal/tmux notification path.

## Permission gate settings

All are exposed through `pi-extension-manager` under **QOL**:

- `permissionGate.enabled`: ask before matching bash tool calls. In non-interactive mode, matches are blocked.
- `permissionGate.commands`: comma-separated command fragments to confirm before running. Default: `rm -Rf`. Literal entries are case-insensitive and whitespace-tolerant; regex entries may use `/pattern/flags`.

## Thinking settings

All are exposed through `pi-extension-manager` under **QOL**:

- `thinkingTimer.enabled`: show live elapsed time next to collapsed `Thinking...` labels. Requires thinking blocks to be collapsed (`hideThinkingBlock` / Ctrl+T) and a model/thinking level that emits thinking blocks. Default on.

## Compaction settings

All are exposed through `pi-extension-manager` under **QOL**:

- `compaction.customEnabled`: use QOL custom summary generation for Pi compaction events. Default off, so Pi behavior is unchanged until enabled.
- `compaction.model`: summarizer model (`provider/model`, bare model id, or `current`). Default: `google/gemini-2.5-flash`.
- `compaction.profile`: `concise`, `balanced`, or `exhaustive` summary detail.
- `compaction.maxTokens`, `compaction.includePreviousSummary`, `compaction.fallbackToDefault`, `compaction.notify`.
- `compaction.remoteEnabled` / `compaction.remoteEndpoint`: POST `{ systemPrompt, prompt, maxTokens }`; expects `{ summary }`.
- `compaction.branchSummaryEnabled`: use the same summarizer for requested `/tree` branch summaries.
- `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds`, `compaction.thresholdTokens`, `compaction.thresholdPercent`: extension-managed idle compaction trigger inspired by oh-my-pi.

Known limitation: Pi owns native pending image attachment state and does not expose it to extensions. This package can attach image paths it collapses itself, but native Pi paste/drag attachments remain Pi-owned.
