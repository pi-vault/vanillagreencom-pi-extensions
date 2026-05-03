---
name: tui-screenshot
description: "Terminal/TUI screenshots and GIFs. Load when capturing tmux panes, terminal apps, CLI/TUI popups, modal overlays, progress states, README images, or animated terminal demos. Supports static PNGs, animated GIFs, full-window pixel screenshots, tmux ANSI captures, popup/frame cropping, and scripted multi-state captures."
license: MIT
user-invocable: true
argument-hint: "static|gif|record [tmux target] [output path]"
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# TUI Screenshot

Capture terminal/TUI screens as static images or animated GIFs. Prefer this skill for terminal apps, tmux panes, Pi/Claude/Codex/OpenCode TUIs, modal popups, dashboards, command palettes, and README/demo assets.

## Mandatory execution rules

- If the user says the request is fully specified, says not to ask questions, or provides output/target/fidelity/crop/destination, **do not call a question tool, do not open a wizard, and do not ask a clarification**. Run the capture.
- Only use an interactive question flow when the user explicitly asks for a wizard/flow or when a missing choice would make the capture impossible.
- Prefer one direct command with `scripts/tui-screenshot snap`, `gif`, or `record` over exploratory filesystem searches.
- Do not emit a preliminary "What should I capture?" message when the request is already specified; go straight to the capture command.
- Use `--pad 0` for cropped popup/documentation assets unless the user asks for padding outside the crop.
- Outputs are scaled down to a maximum width/height of 2000 px by default. Keep this default for README/docs assets; use `--max-dimension 0` only if the user explicitly wants full native resolution.
- For README/demo assets of an existing TUI, capture the real app/extension in a temporary/mock project. Do not hand-recreate UI with custom ANSI unless the user explicitly asks for illustrative mockups.

Bundled helper:

```bash
scripts/tui-screenshot <command> [options]
```

Resolve `scripts/tui-screenshot` relative to this `SKILL.md` location. Use an absolute path when running it from another working directory. The script is inside the skill directory, not in a top-level `scripts/` folder.

Common installed locations include:

- Pi global: `~/.pi/agent/skills/tui-screenshot/scripts/tui-screenshot`
- Shared/global: `~/.agents/skills/tui-screenshot/scripts/tui-screenshot`
- Project-local: `.agents/skills/tui-screenshot/scripts/tui-screenshot`
- Claude Code project-local: `.claude/skills/tui-screenshot/scripts/tui-screenshot`

## Start with intent

First decide whether the request already contains enough information to proceed. **Do not open a question/clarification flow when the user has specified output, target, fidelity, crop, and destination, or when the user says not to ask clarifying questions.** In that case, proceed directly and infer any harmless defaults.

Fast-path defaults when the user asks for a simple TUI capture:

- Output: PNG unless they ask for GIF/animation/recording.
- Target: current tmux pane (`:.`) when running inside tmux.
- Fidelity: tmux ANSI render for remote/headless/task automation; exact OS screenshot only when they ask for pixel-perfect local terminal rendering.
- Crop: `auto` for popup/modal requests, `none` for full-pane/window requests.
- Padding: `--pad 0` unless they ask for outside breathing room.
- Max size: keep default `--max-dimension 2000`; use a smaller value for compact docs or `0` only when full native resolution is requested.

For genuinely ambiguous human-facing requests, ask at most one compact clarification covering only the missing choices. A multi-step question wizard is optional and should be used only when the user asked for an interactive flow.

Choices to clarify only when missing and important:

1. **Output:** static PNG or animated GIF?
2. **Target:** full terminal/window, current tmux pane, a specific tmux pane, or a popup/modal inside a pane?
3. **Fidelity:** exact pixel screenshot of the user's terminal, or portable ANSI render that works headlessly?
4. **Crop:** full pane/window, auto-cropped popup frame, tight content crop, or manual crop?
5. **Destination:** where should the file be saved and should it be linked from docs/README?

## Choose the capture method

### A. Exact pixel screenshot (highest visual fidelity)

Use when the user wants the image to match their terminal exactly: font antialiasing, ligatures, transparency, compositor effects, window padding, and terminal-specific rendering.

Typical commands:

| Platform | Full/window capture options |
| --- | --- |
| macOS | `screencapture -i out.png`, `screencapture -W out.png`, or `screencapture -l <window-id> out.png` |
| Linux Wayland | `grim out.png`, `grim -g "$(slurp)" out.png` |
| Linux GNOME | `gnome-screenshot -w -f out.png`, `gnome-screenshot -a -f out.png` |
| Linux X11 | `import out.png`, `import -window root out.png`, `scrot out.png`, `xwd` |

Use OS/window capture for exact pixels. Use the bundled script below when the session is remote/headless, inside tmux, or when you need deterministic popup cropping/GIF frames.

### B. tmux ANSI capture + render (portable/headless)

Use when the target is available in tmux or a headless environment. This captures the pane's ANSI output and renders it to PNG/GIF. It is excellent for docs and automation, but it approximates terminal rendering; exact Ghostty/iTerm/WezTerm antialiasing requires method A.

```bash
# Capture and render current tmux pane to a cropped PNG.
scripts/tui-screenshot snap --target :. --output screenshot.png --crop auto --pad 0

# Capture raw ANSI for later rendering/debugging.
scripts/tui-screenshot capture --target :. --output frame.ansi

# Render a saved ANSI frame.
scripts/tui-screenshot render --input frame.ansi --output frame.png --crop popup --pad 0
```

Crop modes:

| Mode | Behavior |
| --- | --- |
| `popup` | Crop exactly to the first box-drawn popup/frame (`┏...┓` through matching `┗...┛`). No outside padding unless `--pad` is set. |
| `auto` | Use `popup` when a frame is found, otherwise `tight`. |
| `tight` | Crop to non-empty/non-background cells. |
| `none` | Keep the whole captured pane. |

Sizing:

| Flag | Behavior |
| --- | --- |
| `--max-dimension 2000` | Default. Scale down so neither width nor height exceeds 2000 px. |
| `--max-dimension 0` | Disable scaling. Use only when the user explicitly wants native/full resolution. |

**Cropping rule:** For popup/documentation assets, default to `--crop popup --pad 0` or `--crop auto --pad 0` so the image does not include blank space outside the border. Add padding only when the user asks for breathing room.

## Static screenshot workflow

1. Prepare the target state in the TUI.
2. Prefer exact pixel screenshot if the user cares about terminal-perfect rendering.
3. Otherwise use tmux ANSI rendering:

```bash
scripts/tui-screenshot snap \
  --target '<tmux-target>' \
  --output path/to/screenshot.png \
  --crop auto \
  --pad 0
```

Useful tmux targets:

| Target | Meaning |
| --- | --- |
| `:.` | current pane in current tmux session/window |
| `session:` | active pane in session |
| `session:window.pane` | explicit pane |
| `%pane_id` | exact pane id from `tmux list-panes` |

For a full pane screenshot, use `--crop none`. For a popup/modal, use `--crop popup`.

## README/demo asset workflow

When documenting an existing TUI or extension:

1. Launch the real app in a safe temporary/mock project with representative data.
2. Exercise real UI states with keys/commands/tools, then capture those states.
3. Prefer up to 4 vertically stacked PNG/GIF assets over one overloaded animation when showing different UI modes.
4. Keep each asset focused: one popup, one dashboard, one pane, or one result state.
5. Avoid shipping synthetic UI mockups unless the user explicitly requests them.

For Pi package/extension screenshots, create the temp Pi home so settings can resolve packages and themes:

```bash
TMP_PI_HOME=/tmp/pi-demo-home
mkdir -p "$TMP_PI_HOME"
cp ~/.pi/agent/settings.json "$TMP_PI_HOME/settings.json"
ln -s ~/.pi/agent/themes "$TMP_PI_HOME/themes"     # required when settings.json names a theme
ln -s ~/.pi/agent/packages "$TMP_PI_HOME/packages" # or symlink/copy the package under test
```

If testing a local package version, point only that package symlink at the working tree and keep other packages from the current Pi home so the capture matches the user's session.

## GIF workflow: scripted states

Use this when demonstrating discrete states: tabs, dialogs, settings panes, validation errors, etc.

```bash
# 1. Capture each state as ANSI.
scripts/tui-screenshot capture --target '<tmux-target>' --output frame-01.ansi
# send keys or otherwise change state...
scripts/tui-screenshot capture --target '<tmux-target>' --output frame-02.ansi
# send keys or otherwise change state...
scripts/tui-screenshot capture --target '<tmux-target>' --output frame-03.ansi

# 2. Render frames into an animated GIF.
scripts/tui-screenshot gif \
  --input frame-01.ansi --delay 1400 \
  --input frame-02.ansi --delay 1700 \
  --input frame-03.ansi --delay 1400 \
  --output demo.gif \
  --crop popup \
  --pad 0
```

Delays are milliseconds. If one `--delay` is provided, it applies to all frames. If multiple are provided, they map to inputs in order.

## GIF workflow: timed recording

Use this for short live animations such as spinners, progress updates, menus opening, or scrolling.

```bash
scripts/tui-screenshot record \
  --target '<tmux-target>' \
  --output demo.gif \
  --duration 4 \
  --fps 4 \
  --crop auto \
  --pad 0
```

Keep terminal GIFs short. Prefer 2-6 seconds at 3-8 FPS unless the user asks otherwise.

## Dependency handling

Run a preflight when unsure:

```bash
scripts/tui-screenshot doctor
```

Required for tmux ANSI capture/render:

- `tmux` for `capture`, `snap`, and `record`
- `python3`
- Python `Pillow` (`PIL`) for PNG/GIF rendering
- A monospace font visible to fontconfig on Linux (`fc-match`) improves matching, but the script has fallbacks

If dependencies are missing, do not fail silently. Tell the user what is missing and ask before installing. Suggested install commands:

| System | Commands |
| --- | --- |
| macOS | `brew install tmux python` then `python3 -m pip install --user pillow` |
| Debian/Ubuntu | `sudo apt-get install tmux python3 python3-pil fontconfig` |
| Fedora | `sudo dnf install tmux python3-pillow fontconfig` |
| Arch | `sudo pacman -S tmux python-pillow fontconfig` |

For exact pixel screenshots, check platform tools (`screencapture`, `grim`, `slurp`, `gnome-screenshot`, `import`, `scrot`) and ask before installing.

## Terminal/theme matching tips

For tmux ANSI render:

- Pass a terminal config when available, especially Ghostty:
  `--terminal-config ~/.config/ghostty/config`
- Pass Pi settings for Pi screenshots:
  `--pi-settings ~/.pi/agent/settings.json`
- Ensure `--pi-settings` can resolve its active theme. If `settings.json` has `"theme": "name"`, then `themes/name.json` must exist relative to that settings file. In temp homes, symlink/copy `~/.pi/agent/themes`; otherwise rendering may silently fall back to built-in colors.
- Override font if needed:
  `--font-family "JetBrainsMono Nerd Font" --font-size 17`
- If the generated image has too much area outside the popup, use `--crop popup --pad 0`.
- If exact text antialiasing matters, use an OS/window pixel screenshot instead of ANSI rendering.
- If text appears unreadable, inspect whether an ANSI background span ended before wrapped lines. Re-capture a better state/crop or omit the problematic message block; do not ship low-contrast screenshots.

## Common recipes

### Current tmux popup to README image

```bash
scripts/tui-screenshot snap \
  --target :. \
  --output docs/assets/popup.png \
  --crop popup \
  --pad 0 \
  --terminal-config ~/.config/ghostty/config \
  --pi-settings ~/.pi/agent/settings.json
```

Then link it:

```md
![Popup screenshot](./docs/assets/popup.png)
```

### Three-state tab GIF

```bash
scripts/tui-screenshot capture --target mysession:0.0 --output /tmp/state-1.ansi
tmux send-keys -t mysession:0.0 Tab
scripts/tui-screenshot capture --target mysession:0.0 --output /tmp/state-2.ansi
tmux send-keys -t mysession:0.0 Tab
scripts/tui-screenshot capture --target mysession:0.0 --output /tmp/state-3.ansi

scripts/tui-screenshot gif \
  --input /tmp/state-1.ansi --delay 1200 \
  --input /tmp/state-2.ansi --delay 1200 \
  --input /tmp/state-3.ansi --delay 1200 \
  --output docs/assets/tabs.gif \
  --crop popup \
  --pad 0
```

### Full tmux pane PNG

```bash
scripts/tui-screenshot snap --target mysession:0.0 --output pane.png --crop none --pad 0
```

## Quality checklist

Before finalizing:

- Open/read the image or GIF to verify the crop and state.
- Confirm the output path is linked correctly if adding it to docs.
- For popup crops, ensure the border touches or nearly touches the image edge when `--pad 0` is used.
- For GIFs, verify frame count, dimensions, and loop behavior.
- For themed Pi captures, compare rendered colors against the active theme, especially `borderAccent`, `accent`, `selectedBg`, `text`, `muted`, `dim`, and `userMessageBg`.
- Check readability of wrapped/continued lines; background-color spans can render incorrectly in ANSI captures.
- Remove temporary ANSI/PNG frames unless the user wants them kept.
- Mention whether the result is an exact pixel screenshot or an ANSI-rendered approximation.
