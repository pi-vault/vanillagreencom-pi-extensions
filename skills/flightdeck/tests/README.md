# Flightdeck tests

These tests are local smoke tests for the `flightdeck` skill's harness adapters and daemon wake path.

## Host requirements

- `tmux` 3.x with an active session (full live tests run inside that session)
- Real `pi` binary on `PATH` (or set `PI_BIN=/path/to/pi`) for Pi bridge tests
- GNU bash 5+ (`bash --version`)
- GNU date (`date --version` from coreutils)
- `jq`, `git`, `sha256sum`/coreutils, and the relevant harness CLI for adapter-specific tests (`opencode`, `codex`, etc.)

## `live-wake.sh`

`./skills/flightdeck/tests/live-wake.sh` is the full daemon wake smoke test. Runtime is normally about 2 minutes.

It asserts that:

1. a real Pi master session registers with `pi-bridge` from an isolated temporary project;
2. `flightdeck-daemon start --in-tmux-window --master-harness pi` can launch against that master and a bash inner pane;
3. a terminal bell in the inner pane is detected by the daemon fallback path; and
4. the daemon wakes the Pi master through `pi-bridge send`, observable in `pi-bridge history`, with `harness=pi via=pi-bridge` in the daemon log.

Run full mode from inside tmux:

```bash
skills/flightdeck/tests/live-wake.sh
```

By default it uses the current tmux session, falling back to `VS` when no current session name can be resolved. Override with:

```bash
FD_LIVE_TMUX_SESSION=VS skills/flightdeck/tests/live-wake.sh
```

The test creates `fdlive-*` tmux windows and kills stale `fdlive-*` windows in its `trap EXIT` cleanup. It also uses a visible `flightdeck-daemon-s<N>` window while the daemon is running, then kills it on exit.

### CI-friendly shape mode

Use `--no-tmux` for a fast smoke check that does not spawn tmux, Pi, or the daemon:

```bash
skills/flightdeck/tests/live-wake.sh --no-tmux
```

Shape mode checks GNU bash/date availability, executable script paths, and bash syntax for the daemon and related scripts.

## Cleaning daemon artifacts

Daemon artifacts live under `${FD_STATE_DIR}`. Without an override, the daemon uses `$XDG_RUNTIME_DIR/flightdeck` when available, otherwise `/tmp/flightdeck-$UID`.

Between local full-mode runs, remove stale flightdeck daemon artifacts for tmux session keys (`s<N>`) if needed:

```bash
rm -f /run/user/$UID/flightdeck/fd-*-s*.* 2>/dev/null || true
rm -f /tmp/flightdeck-$UID/fd-*-s*.* 2>/dev/null || true
```

If a run is interrupted before cleanup, remove leftover test windows from the target tmux session:

```bash
tmux list-windows -t VS -F '#{window_id} #{window_name}' \
  | awk '$2 ~ /^fdlive-/ { print $1 }' \
  | xargs -r -n1 tmux kill-window -t
```
