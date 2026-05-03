# pi-prompt-stash

![Prompt stash workflow](./assets/prompt-stash-workflow.gif)

Per-session prompt stash history for Pi.

## Commands

| Command | Action |
| --- | --- |
| `/prompt-stash` | Open the stash popup. |

## Keys

- `Alt+S` with editor text: stash the current prompt and clear the editor.
- `Alt+S` with an empty editor: open the stash popup.

Popup controls:

| Key | Action |
| --- | --- |
| Type | Search stashed prompts. |
| `↑` / `↓`, `j` / `k` | Move selection. |
| `Enter` | Pop the selected prompt into the editor and remove it from the stash. |
| `Ctrl+D` or `Delete` | Delete the selected prompt. |
| `Ctrl+X`, then `y` | Delete all stashed prompts. |
| `Esc` | Close. |

## Storage

Stashes are stored per Pi session under `~/.pi/agent/vstack/prompt-stash/sessions/<session-id>/prompt-stash.json`, even when the package is enabled by project settings. Legacy manager config under `prompt-stash` is still read, and legacy `.pi/prompt-stash.json` files are imported into the current session and removed on load/use.
