# Tmux monitoring patterns

Pane targeting, bell handling, and capture-pane idioms for safely observing the per-issue panes spawned by orchestration.

## Pane-0 rule

**Always target the explicit pane index `<session>:<window>.0` for orchestrator-pane reads.**

`tmux capture-pane -t <session>:<window>` (no `.<pane>` suffix) defaults to the **currently active pane** of that window. When the per-issue agent inside a spawned window has itself spawned sub-agent panes (e.g., opencode's `Iced Task` sub-agent, claude code's parallel sub-agent panes, codex worker panes), the active pane is often one of those sub-agent panes — NOT the per-issue orchestrator's main TUI.

Capturing the wrong pane misses the per-issue orchestrator's prompt. Symptom: flightdeck thinks the issue is idle when it's actually waiting for a response.

### The rule

```bash
# WRONG — captures whatever pane happens to be active
tmux capture-pane -t HT:cc-463 -p

# RIGHT — captures the orchestrator pane explicitly
tmux capture-pane -t HT:cc-463.0 -p -S -200
```

### When pane 0 isn't the orchestrator

Pane indices follow tmux's `pane-base-index` option — commonly `0`, but some configs use `1`. `pane-registry init` queries the option and uses it as the default index, so the registry entry is correct on first try when the orchestrator is in the default position.

Some TUIs lay out their main UI on a non-default pane regardless. At registry init, fingerprint each window's panes:

```bash
for pane_idx in $(tmux list-panes -t <session>:<window> -F '#{pane_index}'); do
  buf=$(tmux capture-pane -t <session>:<window>.$pane_idx -p -S -50)
  if echo "$buf" | grep -qE '(❯ |claude code|opencode|codex>|■■■)' ; then
    orchestrator_pane=$pane_idx
    break
  fi
done
```

Persist the resolved index per issue as `pane_target` in master state (e.g., `"pane_target": "HT:cc-463.0"`). Use it for every subsequent capture-pane and send-keys call on that issue.

If fingerprinting fails (no sentinel matches on any pane), default to pane 0 and log a warning. Pane 0 is right for opencode and claude code in standard layouts.

### Capture-pane scrollback depth

Use `-S -200` for prompt classification. This captures the last 200 lines, enough to see the full prompt (most TUI prompts are <30 lines) plus surrounding context. Going deeper is wasteful; going shallower can miss multi-screen prompts (e.g., multi-issue audit prompts).

```bash
tmux capture-pane -t <session>:<window>.0 -p -S -200
```

## Atomic bell clearing

After every response sent to a pane, clear the window's bell flag. Otherwise the user's tmux status bar continues to show "needs attention" for a prompt the master already handled.

### The chained-command idiom

```bash
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

The `\;` chains both `select-window` calls in a single tmux command. The client coalesces them; the intermediate state is never rendered. Result: the bell flag clears (because tmux clears flags on window-view) but the user sees no flicker, even if attached.

### Standard pattern after every response

```bash
# 1. Send the response
tmux send-keys -t <session>:<window>.0 "<RESPONSE>" Enter

# 2. Clear the bell atomically
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

Encoded in `scripts/pane-clear-bell` and called automatically by `scripts/pane-respond` after every send-keys.

## Window state flags reference

Built-in flags from `tmux list-windows`:

| Flag | Per-window field | Meaning |
|------|------------------|---------|
| `*` | `window_active` | Currently focused (only useful for "which is the user looking at") |
| `-` | `window_last_flag` | Last-focused (previous nav) |
| `#` | `window_bell_flag` | Bell character received → likely needs attention |
| `!` | `window_activity_flag` | Output activity since last view (requires `monitor-activity on`) |
| `~` | `window_silence_flag` | No output for N seconds (requires `monitor-silence N`) |

Flightdeck's primary signal is `window_bell_flag`. If a project has `monitor-silence` enabled, `window_silence_flag` is a useful secondary signal for detecting stuck panes.

Quick scan command:

```bash
tmux list-windows -t <session> -F '#{window_index}:#{window_name} bell=#{window_bell_flag} activity=#{window_activity_flag} silence=#{window_silence_flag}'
```

## Send-keys quirks to be aware of

- **Bracketed paste vs typing**: long inputs (rebase guidance payloads) should use `tmux load-buffer + paste-buffer` or `send-keys -l` to avoid keybinding interpretation in the receiving TUI.
- **Enter key**: `tmux send-keys ... Enter` is portable. `\n` in the payload string does NOT submit; the literal `Enter` token does.
- **Multi-line payloads**: prefer `load-buffer` + `paste-buffer` for anything over ~200 chars; long send-keys can be misinterpreted by some TUIs as paste-bracketed input.

## Per-harness signals

Some pane signals are harness-specific. Adapters live in scripts (e.g., `pane-respond` for option-pick mechanics) and in handler workflows (e.g., `close-issue.md` for terminal-state recognition). Document each harness's contract here as it's wired up.

### Idle / quiescent indicator (handler: `close-issue.md` § 1)

| Harness | Signal |
|---------|--------|
| Claude Code | `* Idle` line near buffer end, no input cursor waiting |
| codex | (TBD — add when first wired) |
| opencode | (TBD — add when first wired) |

### Destroyed-CWD failure pattern (handler: `close-issue.md` § 1)

Inner pane's shell is dead because the worktree was removed mid-session. After that, every Bash call fails to set cwd.

| Harness | Signal |
|---------|--------|
| Claude Code | `Path does not exist` in tool error AND a worktree path in the line; OR explicit `SESSION CWD DESTROYED` message |
| codex | (TBD) |
| opencode | (TBD) |

### Option-pick mechanic (script: `pane-respond` `--option` mode)

| Harness | Mechanic |
|---------|----------|
| Claude Code | `(N-1) × Down` then `Enter`. Numbers are NOT shortcuts; they're buffered as text. |
| codex | (TBD — verify before wiring; do not assume Claude Code's mechanic.) |
| opencode | (TBD — verify before wiring. Workaround callers have used: `--keys Enter,Tab,Enter` to confirm the default-highlighted option, but this is fragile and only works when the desired option is the default. Real adapter needed.) |

To add an adapter for a new harness:
1. Verify the actual keystroke contract by inspecting the harness's TUI in interactive use.
2. Add a `<harness>_select_option` function in `scripts/pane-respond` next to `claude_select_option`.
3. Register it in the `select_option_for_harness` dispatch case.
4. Update this table with the mechanic.
5. Smoke-test against the harness with options 1, 2, and 3 to confirm correct routing.

### Capture viewport (script: `pane-poll` `--harness` flag)

| Harness | Strategy | Why |
|---------|----------|-----|
| Claude Code | `tmux capture-pane -p -S -200` (history) | Default; scrollback is stable. |
| codex | `tmux capture-pane -p -S -200` (history) | Same. |
| opencode | `tmux capture-pane -p` (visible viewport only) | TUI sometimes scrolls the rendered buffer above the viewport, so `-S -200` returns stale middle content and misses the live prompt. |

When adding a new harness, add its row in each table above and wire the matching adapter in the relevant script/workflow. Do not blanket-apply Claude Code's mechanic to other harnesses without verification.
