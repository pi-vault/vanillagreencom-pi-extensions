# pi-session-bridge

Pi package that keeps normal interactive Pi TUI sessions visible while exposing a structured Unix-domain JSONL side channel for external controllers.

## Install via vstack

```bash
vstack add --agent pi
```

The vstack TUI surfaces this package under the **Pi Extensions** tab. Selecting it copies the package into the Pi packages directory and registers it in Pi's `settings.json`.

For a manual install instead:

```bash
pi install /path/to/pi-extensions/session-bridge      # global
pi install -l /path/to/pi-extensions/session-bridge   # project
```

## What it provides

- Normal Pi TUI stays in the terminal.
- External clients discover active Pi processes via registry files.
- External clients send prompts/steering/follow-ups/abort without tmux key injection.
- External clients subscribe to live structured Pi events without pane scraping.

## Discovery

Default paths:

```text
${PI_BRIDGE_DIR:-/tmp/pi-session-bridge-$UID}/instances/<pid>.json
${PI_BRIDGE_DIR:-/tmp/pi-session-bridge-$UID}/pi-<pid>.sock
```

Override with:

```bash
export PI_BRIDGE_DIR=/some/private/dir
```

The bridge directory is created `0700`; instance files are `0600`.

## CLI

```bash
pi-bridge list
pi-bridge state --pid <pid>
pi-bridge commands --pid <pid>
pi-bridge stream --pid <pid>
pi-bridge send --pid <pid> "message for the agent"
pi-bridge steer --pid <pid> "steer current work"
pi-bridge follow-up --pid <pid> "after you finish, do this"
```

If exactly one active bridge exists, target flags are optional.

When installed via vstack as a local-path Pi package, the `pi-bridge` binary is **not** automatically placed on `PATH` (Pi local installs do not expose npm `bin` entries). Either:

- Run the script directly: `node /path/to/pi-extensions/session-bridge/bin/pi-bridge.js list`
- Or symlink it once: `ln -sf /path/to/pi-extensions/session-bridge/bin/pi-bridge.js ~/.local/bin/pi-bridge`
- Or use the raw socket protocol described below from any language

## Raw protocol

Connect to the advertised Unix socket and exchange LF-delimited JSON.

Commands:

```json
{"id":"1","type":"get_state"}
{"id":"2","type":"prompt","message":"Run tests","deliverAs":"auto"}
{"id":"3","type":"steer","message":"Focus on errors"}
{"id":"4","type":"follow_up","message":"Summarize when done"}
{"id":"5","type":"abort"}
{"id":"6","type":"history","limit":50}
{"id":"7","type":"subscribe","enabled":true}
{"id":"8","type":"emit","message":"no-LLM test event"}
{"id":"9","type":"get_commands"}
```

Responses:

```json
{"type":"response","id":"1","command":"get_state","success":true,"data":{}}
```

Broadcast events:

```json
{"type":"event","event":"message_update","timestamp":"...","data":{}}
{"type":"event","event":"tool_execution_start","timestamp":"...","data":{}}
```

The client receives events by default. Send `subscribe` with `enabled:false` to suppress live events on that connection.

## No-LLM checks

```bash
pi-bridge state --pid <pid>
pi-bridge emit --pid <pid> "hello"
pi-bridge history --pid <pid> 20
```

Use `send /bridge-ping ...` to verify bridge input injection without calling a model. The extension handles this specific input and emits `bridge_pong`:

```bash
pi-bridge send --pid <pid> "/bridge-ping hello"
pi-bridge history --pid <pid> 20
```

## Security

The socket can trigger real agent work in the owning Pi process. Keep `PI_BRIDGE_DIR` private and do not expose the socket to other users or containers you do not trust.
