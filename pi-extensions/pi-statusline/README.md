# pi-statusline

Pi package that replaces the default footer/editor chrome with a compact Claude-style status line and single-line prompt.

## What it does

- Shows project/repo name, branch/worktree badge, model, thinking level, context-window size, and remaining context percent.
- Uses a compact prompt prefixed with `π` and wraps long input cleanly.
- Adds one blank padding line below the prompt.
- Keeps autocomplete visible under the prompt.
- Hides Pi's default footer because the status line lives directly above the prompt.

## Install via vstack

```bash
vstack add --agent pi
```

The vstack TUI surfaces this package under the **Pi Extensions** tab. Selecting it copies the package into the Pi packages directory and registers it in Pi's `settings.json` `packages` array.

For a manual install instead:

```bash
pi install /path/to/pi-extensions/pi-statusline       # global
pi install -l /path/to/pi-extensions/pi-statusline    # project
```

## Updating

Edit files under `pi-extensions/pi-statusline/` in the vstack repo, then run `vstack refresh` (or `vstack add` again) so installed Pi scopes pick up the change.

## Package shape

```text
pi-statusline/
├── package.json
├── extensions/
│   └── statusline.ts
└── README.md
```

`package.json` declares:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/statusline.ts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  }
}
```

## Mode behavior

- This extension is meaningful only in interactive Pi TUI mode.
- In RPC/JSON/print modes, the TUI-specific UI methods are no-ops or degrade silently — the package is safe to leave installed.
- Git metadata is best-effort and intentionally degrades to the current directory name if Git commands fail.
