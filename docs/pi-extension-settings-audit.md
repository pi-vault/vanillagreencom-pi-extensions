# Pi Extension Settings Audit

This audit covers every local vstack Pi package under `pi-extensions/`. Each package now declares `vstack.extensionManager.settings` metadata so `pi-extension-manager` can show useful controls. Every package exposes an `enabled` boolean or equivalent feature toggle; package/module filter toggles in the manager remain available separately and require `/reload` or restart because Pi cannot unload extension modules live.

## Runtime constraints

Pi's public extension API does not currently expose a native API to inject a third-party tab into the built-in `/settings` UI or to unload already-loaded extension modules. `pi-extension-manager` therefore provides a full Pi-styled settings shell through `/extensions`, quick inline settings through `/extension-settings`, plus a best-effort `/settings` wrapper when explicitly enabled.

Settings persist under `vstack.extensionManager.config.<packageName>` in Pi `settings.json` files to avoid colliding with Pi's own top-level `extensions` resource array.

## Package coverage

### `pi-extension-manager`

- Toggle: `enabled` disables the full manager UI after reload; `/extensions enable` remains as recovery.
- Useful settings: show/hide built-in tools, default save scope, best-effort `/settings` wrapper.
- Apply semantics: inventory settings are live; command registration changes need reload/restart.

### `pi-skills-manager`

- Toggle: `enabled` registers/unregisters `/skills`, marker expansion, startup skill-list hiding, and skills management UI after reload; `/skills enable` remains as recovery.
- Useful settings: hide native `/skill:*` commands, hide startup `[Skills]` block, cleanup partial markers, AI skill generation, default create location, popup dimensions, visible list rows.
- Apply semantics: search/toggle/create UI settings are live; command registration, native skill-command hiding, and startup-block hiding need reload. Skill enable/disable writes Pi resource filters and requires `/reload` to fully affect model prompt resources.

### `pi-background-tasks`

- Toggle: `enabled` registers/unregisters `bg_task`, `bg_status`, `/bg`, dashboard shortcut, and widgets after reload.
- Useful settings: default timeout, output settle delay, force-kill grace, output/log caps, widget visibility/placement, dashboard shortcut, task log directory.
- Apply semantics: task/runtime settings are read at use time; shortcut registration needs reload/restart.

### `pi-questions`

- Toggle: `enabled` registers/unregisters the `question` tool, `/question-demo`, popup UI, and bridge question service after reload.
- Useful settings: popup width/max-height, visible option rows, default header, bridge reply enablement. Large free-form answer results use Pi default tool-result truncation with temp-file preservation.
- Apply semantics: popup and bridge settings are live.

### `pi-session-bridge`

- Toggle: `enabled` starts/stops registration of the Unix-socket bridge, registry, event stream, and bridge commands after reload/restart.
- Useful settings: bridge directory, event history limit, max request line bytes, heartbeat interval, startup notification, status badge.
- Apply semantics: notification/status are live; socket/protocol settings require restart/reload.

### `pi-subagents-tmux`

- Toggle: `enabled` registers/unregisters the `subagent` tool, `/agents` command, and persistent pane polling after reload.
- Useful settings: max parallel tasks, max one-shot concurrency, collapsed result size, result truncation/full-output preservation, parent/child poll intervals.
- Apply semantics: execution/render/output limits are live; polling interval changes need reload/session restart.

### `pi-statusline`

- Toggle: `enabled` installs/removes the status line UI after reload/session start.
- Useful settings: footer replacement, compact prompt, input padding, git refresh timeout, dirty marker display.
- Apply semantics: git/dirty settings are live-ish; editor/footer changes need reload/session restart.

### `pi-prompt-stash`

- Toggle: `enabled` registers/unregisters `/prompt-stash` and the stash/pop shortcut after reload.
- Useful settings: per-session store file name, shortcut, popup width/max-height, visible stash rows, deduplication.
- Apply semantics: popup/storage settings are live; shortcut registration needs reload.

### `pi-qol`

- Toggle: `enabled` installs/removes QOL editor helpers, `/qol`, and QOL compaction hooks after reload.
- Useful settings: Shift+Enter newline, fallback newline key, image chip rendering, attachment count badge, session commands, terminal/tmux notification triggers/channels (including active-window bell suppression and tmux client-TTY native notifications for Ghostty), custom compaction model/profile/remote endpoint, branch summary override, idle compaction thresholds, hidden-thinking placeholder preference.
- Apply semantics: image/status, notification, and compaction behavior settings are live; editor and command registration need reload. Hidden-thinking is a settings contract only until Pi exposes an assistant-message renderer hook.

### `pi-session-manager`

- Toggle: `enabled` registers/unregisters `/sessions`, the status badge, and the optional shortcut after reload.
- Useful settings: shortcut key, default scope, default sort, visible rows, overlay width, named-session status badge, trash-before-unlink deletion.
- Apply semantics: browse/render/delete settings are live; command and shortcut registration need reload.

### `pi-output-policy`

- Toggle: `enabled` applies/skips tool-result minimization/truncation live.
- Useful settings: spill threshold, inline tail budget, max text block/line count/line width, per-session full-output preservation, shell minimizer controls.
- Apply semantics: live.

### `pi-tool-renderer`

- Toggle: `enabled` registers/unregisters compact built-in tool renderers after reload.
- Useful settings: command preview chars, bash/read/search/edit/write preview lines, preferred `tool_batch` composite tool and max batch calls, legacy native-tool stacking, max render line width.
- Apply semantics: preview and batch-limit settings are live; renderer/batch-tool registration needs reload.

### `pi-task-panel`

- Toggle: `enabled` registers/unregisters `todo_write`, `/todo`, panel widget, reminders, and shortcuts after reload.
- Useful settings: default panel state, Ctrl+T takeover, Alt+T tri-state toggle, compact task count, active-task auto-advance/hide, expanded notes, auto-show, sequential task updates, model-facing workflow context/reminders, incomplete-task reminders.
- Apply semantics: panel/reminder settings are live; shortcut registration needs reload.

### `pi-caveman`

- Toggle: `enabled` controls whether sessions start in caveman mode by default; `/caveman off` remains a session override.
- Useful settings: default mode, status badge, clarity escape, resume policy, session override permission, normal-code/commit/review boundaries, custom prompt suffix.
- Apply semantics: prompt-injection settings are live per turn; default startup mode applies at session start.

## Manager behavior

- Tool toggles can apply live through `pi.setActiveTools()`.
- Package/module toggles edit Pi package filters or manager disabled lists and require `/reload` or restart because Pi cannot unload loaded modules live.
- Extension `enabled` settings are schema-driven feature toggles. For most packages they are checked at extension load, so changing them usually requires `/reload`.
