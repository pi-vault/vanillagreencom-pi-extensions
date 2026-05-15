# Flightdeck dashboard parity smokes

Manual smoke coverage for pi-flightdeck surfaces that cannot be proven by a ratatui snapshot because they depend on terminal side effects or live tmux pane identity. The Rust TUI is render-only with one in-process bell side effect; it does not auto-focus tmux windows.

## Scope

- Rust dashboard: `skills/flightdeck/lib/flightdeck-dashboard/`
- Pi extension being deprecated for new sessions: `pi-extensions/pi-flightdeck/`
- Snapshot-backed rows live in `skills/flightdeck/lib/flightdeck-dashboard/tests/snapshot_overview.rs` and `tests/snapshot_tabs.rs`.

## Smoke 1 — terminal bell on pause

Purpose: verify the Rust dashboard preserves the pi-flightdeck pause-bell behavior.

1. Start inside tmux.
2. Launch the dashboard through the normal hook:

   ```bash
   .agents/skills/flightdeck/scripts/flightdeck-dashboard launch
   ```

3. In the same Flightdeck session, write or trigger state with `paused_for_user` set.
4. Observe:
   - Terminal bell fires once when the paused state first appears.
   - Status bar shows `PAUSED FOR USER`.
   - Overview snapshot-equivalent pause chip remains visible until state clears.

Expected result: audible/visual bell side effect occurs once per pause edge; repeated file watcher reloads do not spam the bell.

## Smoke 2 — no auto-focus on pause

Purpose: verify the Rust dashboard does not mutate tmux focus on pause. The earlier parity plan mapped the Pi auto-popup to `tmux select-window`; Phase 11 removed that write-side behavior because the TUI must stay read/render-only.

1. Start a Flightdeck tmux session with at least one child window and the dashboard window.
2. Leave focus on a non-dashboard window.
3. Trigger `paused_for_user` in the master state.
4. Observe:
   - Focus stays on the current tmux window.
   - Terminal bell fires if `FLIGHTDECK_DASHBOARD_BELL` is not `0`.
   - The dashboard window shows `PAUSED FOR USER` when viewed manually.

Expected result: pause edge produces bell + visual status only; operators choose whether to focus the dashboard window.

## Smoke 3 — owner/observer live panes

Purpose: verify snapshot-backed observer banner also matches real tmux panes.

1. Launch the dashboard from a pane different from the Flightdeck owner pane.
2. Open the dashboard window against the owner session.
3. Observe:
   - Status bar includes `OBSERVER`.
   - Overview shows `observer mode` banner with owner pane and dashboard pane ids.
   - No write actions are offered from the observer view.

Expected result: peer panes see read-only observer affordances; owner pane sees normal owner-scoped dashboard.

## Snapshot parity map

| Surface | Evidence |
| --- | --- |
| Pause banner above editor | `snapshot_overview::paused_fixture_overview` |
| Persistent dashboard widget / compact tree | `snapshot_overview::compact_dashboard_widget` |
| Six-tab popup | `snapshot_tabs::*_tab` snapshots |
| Session-complete archive fallback | `snapshot_overview::archive_fallback_from_dir` |
| Owner-scoped visibility / observer banner | `snapshot_overview::observer_banner` |
| Kind badges | `snapshot_overview::mixed_fixture_overview` |
| Conversations stream | `snapshot_tabs::conversations_stream_newest_first` |
| Conflicts & merges issue-mode relabel | `snapshot_tabs::mixed_merges_tab` |
| Conflicts & merges hidden without ISS rows | `snapshot_tabs::merges_tab_hidden_without_issue_rows` |
| Decisions detail popup | `snapshot_tabs::decisions_detail_popup` |
| Daemon heartbeat folding | `snapshot_tabs::mixed_daemon_tab` |
| Terminal bell + no auto-focus on pause | Smoke 1 + Smoke 2 above |
