# pi-flightdeck

> ⚠️ **WIP — not production ready.** APIs, settings, and UI are subject to breakage without notice. Use for experimentation only.

Read-only mission-control dashboard for the [`flightdeck`](../../skills/flightdeck) skill.

When Pi is running as the flightdeck **master agent** in a tmux session, this extension surfaces the same on-disk state the daemon and master already maintain — issues, daemon health, decisions, conflicts, and (most importantly) any pending pause-for-user state — without ever mutating it.

## What it shows

- **Pause banner** — when flightdeck master sets `paused_for_user`, a high-contrast yellow-framed banner appears above the editor with the issue id, reason, and prompt excerpt. Clears automatically when master resumes.
- **Persistent dashboard widget** — compact tree of tracked issues with state badges, harness chip, launch model/effort when available, PR number, last decision, age, and per-pane cost/turns/tokens (sourced from pi-agents-tmux via the `vstack.pi.agents` bridge when both extensions are installed). Rendered only in the master/coordinator pane; suppressed in child subagent panes (detected via `PI_SUBAGENT_CHILD_AGENT`) so the same project state isn't echoed inside each agent. Daemon health collapses into a single dot+label chip — only shown explicitly when stale (≥ 30s) or dead. If the daemon is gone AND the most recent issue poll is older than `dashboardStaleAfterMin` minutes (default `5`), the issue tree is replaced by a single-line hint inviting the operator to restart flightdeck or archive the leftover state file — prevents a dead session's state file from rendering a phantom dashboard a day later. Set `dashboardStaleAfterMin` to `0` to disable the stale check.
- **`/flightdeck` popup** (F6) — full mission-control view with six tabs:
  - **Overview** — one row per tracked issue with `STATE / PROMPT` (combined), harness, PR, cost/turns/tokens, and age; detail block for the selected issue includes usage + model.
  - **Live feed** — chronologically sorted daemon log + pending events + adapter wake events + decisions, with consecutive `[heartbeat]` lines folded into a single summary row and `↑/↓` scrollback through the full backlog.
  - **Conversations** — last assistant turn per inner pane, captured from adapter wake events.
  - **Conflicts & merges** — merge queue + file-level conflict graph edges.
  - **Decisions** — flat audit of every prompt-tag → answer master has issued.
  - **Daemon** — pid, heartbeat age, busy/wake-pending state, subscriber counts shown as `actual/expected` per harness (green when matched, yellow when short). Expected is gated on **adapter eligibility**: only issues whose registry record carries the adapter metadata fields the daemon's `spawn_<h>_subscriber` path reads (`oc_url`+`oc_session_id`, `cc_url`+`cc_transcript`, `pi_bridge_socket`/`pi_bridge_pid`, `cx_ws`+`cx_thread_id`) are counted, so panes intentionally on tmux fallback don't trigger false warnings. When a harness is short, `live subs:` lists the live subscriber pid + pane id entries that do exist for that short bucket, and `unsubscribed:` lists only adapter-eligible panes missing a live sidecar. Daemon log tail follows.

## Read-only by design

The flightdeck skill is the single owner of `flightdeck-state` mutation, the daemon owns wake delivery, and `pane-respond` owns sending input to inner panes. pi-flightdeck never writes any of these — it just renders what's already on disk.

The skill itself works fine without this extension; the extension is purely additive UX for the Pi harness. Other harnesses (claude code, opencode, codex) keep using the skill as before.

## Settings

Configurable in `/extensions:settings` under `Flightdeck Dashboard`.

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master kill-switch (reload required) |
| `popupShortcut` | `f6` | Open the mission-control popup (`none` to disable) |
| `dashboardShortcut` | `alt+m` | Cycle widget hidden → compact → expanded ("m" for mission control — `alt+f`/`alt+d` collide with pi's built-in editor word motions) |
| `dashboard` | `true` | Render the persistent widget above the editor |
| `dashboardDefaultState` | `compact` | `hidden` / `compact` / `expanded` on first appearance |
| `dashboardMaxItems` | `8` | Max issue rows in the widget |
| `dashboardStaleAfterMin` | `5` | Suppress the issue tree (show a one-line hint instead) when the daemon is dead AND the most recent poll is older than this many minutes. `0` disables the check |
| `pauseBanner` | `true` | Show the pause-for-user banner |
| `pauseBeep` | `true` | Ring the terminal bell when master first pauses |
| `autoOpenOnPause` | `false` | Auto-open the popup once when master pauses |
| `pollIntervalMs` | `1500` | How often state files are re-read |
| `liveFeedLines` | `200` | Daemon log + decisions retained in Live feed |
| `conversationExcerptChars` | `800` | Max chars of last assistant text per turn |
| `conversationsHistory` | `5` | Recent assistant turns retained per pane |
| `treeStyle` | `unicode` | Connector glyphs (`unicode` or `ascii`) |
| `stateDir` | _(auto)_ | Override `FD_STATE_DIR` resolution |
| `flightdeckStateDir` | `tmp` | Project-relative master-state directory (`FLIGHTDECK_STATE_DIR`) |

Daemon tuning env vars remain owned by the flightdeck skill/daemon, not this read-only extension. Notable operator knob: `FD_OC_BACKOFF_MAX_SEC` (default `16`) caps OpenCode subscriber exponential backoff after unchanged `/question` + `/session/<id>/message` polls; new question ids, response hash changes, and daemon bell markers in `FD_STATE_DIR` reset the subscriber back to `FD_OC_POLL_SEC` (the daemon clears the tmux bell after marking it).

## Commands

| Command | Action |
|---|---|
| `/flightdeck` | Open the mission-control popup (also F6) |
| `/flightdeck:toggle` | Cycle the persistent dashboard widget hidden → compact → expanded (also Alt+M) |

## How it reads state

State paths mirror `skills/flightdeck/scripts/lib/daemon-paths.sh` and `flightdeck-state`:

- Master state — `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<TMUX_SESSION_NAME>.json`
- Daemon files — `${FD_STATE_DIR}/fd-{daemon,master,wake,...}-<SESSION_KEY>.{pid,log,heartbeat,busy,jsonl}`
- Subscriber pid files — `${FD_STATE_DIR}/fd-{,cc-,pi-,cx-}subscriber-<SESSION_KEY>-<pane_safe>.pid`. The `<SESSION_KEY>` infix scopes counts to the current flightdeck session; the overlay's per-harness counts and `live subs:` rows use it to filter out subscribers belonging to other concurrent daemons in the shared state dir, then verify each recorded pid is alive before rendering it.

The daemon files key off the stable tmux `session_id`, so they survive a tmux session rename. The master state filename embeds the **session name**, so renaming the tmux session orphans the existing state file — flightdeck will look for `flightdeck-state-<NEW_NAME>.json` and miss the old one. Tmux window/tab names are not used.

Where `FD_STATE_DIR` defaults to `$XDG_RUNTIME_DIR/flightdeck` (or `/tmp/flightdeck-$UID`), and `SESSION_KEY` is `s<N>` derived from the tmux `session_id`.

If the project uses a non-default `FLIGHTDECK_STATE_DIR` or `FD_STATE_DIR`, set the matching extension setting so the dashboard reads the right files.

## Install

```bash
vstack add vanillagreencom/vstack --pi-extension pi-flightdeck --harness pi -y
# or globally:
vstack add vanillagreencom/vstack --global --pi-extension pi-flightdeck --harness pi -y
```

## Out of scope

- No write actions. Forwarded user-decisions go to master via normal Pi chat.
- No daemon control. Use `flightdeck-daemon start|stop|status|health` from the skill.
- No multi-tmux-session aggregation. Scope is the current `$TMUX` session.
