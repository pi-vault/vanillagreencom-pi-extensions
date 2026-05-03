# pi-session-bridge

![Session bridge CLI flow](./assets/session-bridge-cli.png)

Pi package that keeps the normal interactive Pi TUI visible while exposing a structured Unix-domain JSONL side channel for external controllers. It is **not** Pi `--mode rpc`; it keeps the live TUI and borrows compatible JSONL command/response conventions where useful.

## Install

Via vstack:

```bash
vstack add --agent pi
```

The vstack TUI lists this package under **Pi Extensions** and registers it in Pi's `settings.json`.

Manual install:

```bash
pi install /path/to/pi-extensions/session-bridge      # global
pi install -l /path/to/pi-extensions/session-bridge   # project
```

## What it provides

- Normal Pi TUI stays in the terminal.
- External clients discover active Pi processes from registry files.
- External clients send prompts, steering, follow-ups, and aborts without tmux key injection.
- External clients subscribe to structured live Pi events without pane scraping.
- When `pi-questions` is also loaded, external clients can list, answer, and reject pending structured questions.

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

## Commands

| Command | Action |
| --- | --- |
| `/bridge-status` | Show socket and registry paths. |
| `/bridge-ping [text]` | Emit a `bridge_pong` event; default text is `pong`. |

## `pi-bridge` CLI

```bash
pi-bridge list
pi-bridge state --pid <pid>
pi-bridge commands --pid <pid>
pi-bridge stream --pid <pid>
pi-bridge history --pid <pid> 20
pi-bridge send --pid <pid> "message for the agent"
pi-bridge steer --pid <pid> "steer current work"
pi-bridge follow-up --pid <pid> "after you finish, do this"
pi-bridge questions --pid <pid>
pi-bridge answer --pid <pid> --request-id que_... --answers '[["Stop here"]]'
pi-bridge reject --pid <pid> --request-id que_...
pi-bridge emit --pid <pid> "hello"
pi-bridge request --pid <pid> '{"type":"get_state"}'
```

If exactly one active bridge exists, target flags are optional. Target filters include `--pid`, `--socket`, `--session`, `--name`, and `--cwd`.

For `pi-questions` tabs with `allowCustom=true`, answer strings may be free-form text.

When installed via vstack as a local-path Pi package, the `pi-bridge` binary is **not** automatically placed on `PATH` because Pi local installs do not expose npm `bin` entries. Use one of:

```bash
node /path/to/pi-extensions/session-bridge/bin/pi-bridge.js list
ln -sf /path/to/pi-extensions/session-bridge/bin/pi-bridge.js ~/.local/bin/pi-bridge
```

Or use the raw socket protocol below from any language.

## Raw protocol

Connect to the advertised Unix socket and exchange one strict JSON object per LF-delimited record. Requests may include `id`; responses use `type:"response"` with the same `id`.

Common requests:

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
{"id":"10","type":"questions"}
{"id":"11","type":"answer","requestId":"que_example","answers":[["Stop here"]]}
{"id":"12","type":"reject","requestId":"que_example"}
```

Responses and events:

```json
{"type":"response","id":"1","command":"get_state","success":true,"data":{}}
{"type":"event","event":"message_update","timestamp":"...","data":{}}
{"type":"event","event":"question","timestamp":"...","data":{"action":"opened","requestId":"que_example"}}
```

Clients receive events by default. Send `subscribe` with `enabled:false` to suppress live events on that connection.

## No-LLM checks

```bash
pi-bridge state --pid <pid>
pi-bridge emit --pid <pid> "hello"
pi-bridge send --pid <pid> "/bridge-ping hello"
pi-bridge history --pid <pid> 20
```

`/bridge-ping` is handled by the extension and emits `bridge_pong` without calling a model.

## Security

The socket can trigger real agent work in the owning Pi process. Keep `PI_BRIDGE_DIR` private and do not expose the socket to other users or containers you do not trust.
