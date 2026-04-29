# prompt-stash

Project-local prompt stash history for Pi.

## Usage

- `Ctrl+S` with editor text: stash the current prompt and clear the editor.
- `Ctrl+S` with an empty editor: open the stash popup.
- `/prompt-stash`: open the stash popup.

Popup controls:

- Type to search.
- `↑/↓` or `j/k` to select.
- `Enter` to pop the selected prompt into the editor and remove it from the stash.
- `Ctrl+D` or `Delete` to delete the selected prompt.
- `Ctrl+X` to delete all stashed prompts, then `y` to confirm.
- `Esc` or `Ctrl+C` to close.

Stashes are stored per project in `.pi/prompt-stash.json`.
