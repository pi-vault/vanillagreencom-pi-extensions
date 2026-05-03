# pi-session-manager

![Session manager browser](./assets/session-manager-browser.gif)

Polished session manager overlay for Pi. It complements Pi's built-in `/resume` picker with vstack settings, inline management actions, and guarded rendering for long or control-character-heavy session text.

## What it provides

- Browse current-project sessions or all sessions.
- Search by fuzzy tokens, quoted phrases, or `re:<regex>` across titles, IDs, paths, cwd, and transcript text.
- Threaded lineage view using Pi `parentSession` relationships when there is no active search.
- Resume through `ctx.switchSession()`.
- Rename sessions using Pi session-info entries; current-session renames go through `pi.setSessionName()`.
- Delete with confirmation, current-session protection, and optional `trash` CLI fallback.
- Clean one-line rendering for names, prompts, and paths.

No SQLite, FTS, or native runtime dependencies are used; Pi's `SessionManager.list()` / `listAll()` APIs provide the index data.

## Commands

| Command | Action |
| --- | --- |
| `/sessions` | Open the manager using the configured default scope. |
| `/sessions current` | Open current-project sessions. |
| `/sessions all` | Open all sessions. |

Arguments support autocomplete.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection. |
| `PageUp` / `PageDown` | Page the list. |
| `Home` / `End` | Jump to first/last result. |
| `Enter` | Resume selected session. |
| `Ctrl+R` or `r` with empty search | Rename selected session inline. |
| `Ctrl+D` or `d` with empty search | Delete selected session after confirmation. |
| `Tab` | Toggle current/all scope. |
| `Ctrl+S` | Cycle threaded/recent/relevance sort. |
| `Ctrl+N` | Toggle named-only filter. |
| `Ctrl+P` | Toggle full session path in row metadata. |
| `Esc` / `Ctrl+C` | Clear search, cancel rename/delete, or close. |

The global shortcut defaults to `Ctrl+Shift+R`; set `shortcutKey` to `none` to disable it.

## Settings

Settings are exposed through `pi-extension-manager` under `vstack.extensionManager.config.pi-session-manager`.

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Registers commands and shortcut after reload. |
| `shortcutKey` | `ctrl+shift+r` | Opens `/sessions` when Pi is idle; set to `none` to disable. |
| `defaultScope` | `current` | `current` or `all`. |
| `defaultSort` | `threaded` | `threaded`, `recent`, or `relevance`. |
| `visibleRows` | `12` | List rows before scrolling. |
| `overlayWidth` | `112` | Preferred overlay width in terminal columns. |
| `deleteUsesTrash` | `true` | Try `trash` before `unlink` when deleting. |

## Notes

- Session titles mirror Pi `/resume`: explicit session name, first user message, then filename.
- If `sessionDir` or `PI_CODING_AGENT_SESSION_DIR` is configured, current scope filters by session `cwd`; all scope shows every session in that directory.
- Pi's built-in `/resume`, `/tree`, `/fork`, `/clone`, and `/name` remain available.
