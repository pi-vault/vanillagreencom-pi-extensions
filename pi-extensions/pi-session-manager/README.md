# pi-session-manager

Polished session manager overlay for Pi. It complements Pi's built-in `/resume` picker with vstack-style package settings, inline management actions, and guarded rendering for long or control-character-heavy session text.

## Features

- Browse current-project sessions or all sessions.
- Search by fuzzy tokens, quoted phrases, or `re:<regex>` across session titles, IDs, paths, cwd, and transcript text.
- Threaded lineage view that follows Pi `parentSession` relationships when there is no active search.
- Resume via the current `ctx.switchSession()` lifecycle API.
- Rename any session using `SessionManager` session-info entries; current-session renames go through `pi.setSessionName()`.
- Delete with inline confirmation, current-session protection, and optional `trash` CLI fallback before permanent unlink.
- Clean one-line rendering for names/prompts/paths to prevent multiline or control text from breaking the TUI.
- Status badge for named current sessions.

No SQLite, FTS, or native runtime dependencies are used; Pi's `SessionManager.list()` / `listAll()` APIs provide the index data.

## Commands

| Command | Description |
| --- | --- |
| `/sessions` | Open the manager using the configured default scope. |
| `/sessions current` | Open current-project sessions. |
| `/sessions all` | Open all sessions. |
| `/session-manager` | Alias for `/sessions`. |

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection. |
| `PageUp` / `PageDown` | Page the list. |
| `Home` / `End` | Jump to first/last result. |
| `Enter` | Resume selected session. |
| `Ctrl+R` or `r` with an empty search | Rename selected session inline. |
| `Ctrl+D` or `d` with an empty search | Delete selected session after confirmation. |
| `Tab` | Toggle current/all scope. |
| `Ctrl+S` | Cycle threaded/recent/relevance sort. |
| `Ctrl+N` | Toggle named-only filter. |
| `Ctrl+P` | Toggle full session path in row metadata. |
| `Esc` / `Ctrl+C` | Clear search, cancel rename/delete, or close. |

The global shortcut defaults to `Ctrl+Shift+R` and can be disabled by setting `shortcutKey` to `none`.

## Settings

Settings are exposed through `pi-extension-manager` under `vstack.extensionManager.config.pi-session-manager`.

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Registers commands, status badge, and shortcut after reload. |
| `shortcutKey` | `ctrl+shift+r` | Opens `/sessions` when Pi is idle; set to `none` to disable. |
| `defaultScope` | `current` | `current` or `all`. |
| `defaultSort` | `threaded` | `threaded`, `recent`, or `relevance`. |
| `visibleRows` | `12` | List rows before scrolling. |
| `overlayWidth` | `112` | Preferred overlay width in terminal columns. |
| `showStatus` | `true` | Footer/status badge for named current sessions. |
| `deleteUsesTrash` | `true` | Try `trash` before `unlink` when deleting. |

## Notes

- Session titles intentionally mirror Pi `/resume`: explicit session name first, then first user message, then the session filename.
- If `sessionDir` or `PI_CODING_AGENT_SESSION_DIR` is configured, the manager respects it. Current scope filters that shared directory by session `cwd`; all scope shows every session in that directory.
- Pi's built-in `/resume`, `/tree`, `/fork`, `/clone`, and `/name` remain available.
