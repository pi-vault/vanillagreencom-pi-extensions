# Opencode question-tool routing

Opencode's `question` tool renders an interactive multi-choice dialog
in the TUI. Earlier flightdeck versions tried to *prevent* this by
denying the tool at session creation. That partly worked — `run --attach`
auto-denies `question`, `plan_enter`, and `plan_exit` on the parent session
— but **sub-agent sessions spawned via the `task` tool do NOT inherit the
parent's permission deny**. Only `task` is auto-denied on sub-agents (to
prevent recursion). Any orchestration step that delegates to `general` /
`tpm` / specialist sub-agents can therefore call `question`, blocking the
pane on a TUI dialog flightdeck couldn't drive over `run --attach`.

The current adapter routes question dialogs through opencode's HTTP API
instead of trying to suppress them.

## API

Each opencode pane has its own `opencode serve` instance, so the
following endpoints are scoped to that pane (covering parent + every
sub-agent on that server):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/question` | List all pending question requests for this pane. |
| `POST` | `/question/<requestID>/reply` | Provide answers — body `{"answers":[[<label>,...],...]}` (one inner array per question in the request; labels, not indices). Response: `true`. |
| `POST` | `/question/<requestID>/reject` | Dismiss without answering. Response: `true`. |

The pending-question payload is structured:

```json
{
  "id": "que_…",                       // request_id
  "sessionID": "ses_…",                // sub-agent session if delegated
  "questions": [
    {
      "header":   "Issue Missing",
      "question": "Linear cannot find `CC-9401`…",
      "options":  [
        {"label":"Use current branch","description":"…"},
        {"label":"Provide issue ID","description":"…"},
        {"label":"Stop here","description":"…"}
      ],
      "multiple": false
    }
  ],
  "tool": {"messageID":"msg_…","callID":"call_…"}
}
```

`options[]` contains every choice the agent offered. The TUI may add a
synthetic "Type your own answer" entry for human users; that option is
NOT in the API contract — pick from the structured `options[]` only.
For free-text master input, send a regular user message via
`opencode run --attach --session <SID>` after rejecting the question.

## Wake-event flow

1. Daemon's `oc_subscriber_loop` polls `GET /question` each tick.
2. For every request_id never seen before, emits one wake event under
   `SESSION_LOCK`:

   ```json
   {
     "ts": "…", "pane_id": "%N", "harness": "opencode",
     "event_type": "question", "request_id": "que_…",
     "question": { … full payload above … },
     "classifier_tag": "oc-question",
     "hash": "<12-char prefix of sha256(request_id)>"
   }
   ```

3. Daemon's main loop drains, sees `classifier_tag=oc-question`
   (canonical), calls `append_event` for the master, and wakes via
   `wake_master`. Same dedup pipeline (`NOTIFIED_HASH`) as other
   canonical tags — replays of the same request_id won't re-wake.

## Master answers via `pane-respond`

```bash
# Pick a single labeled option:
pane-respond <pane> --harness opencode --question que_… --answer "Use current branch"

# Multi-pick (only valid when question.multiple == true):
pane-respond <pane> --harness opencode --question que_… --answer-multi "Label A,Label B"

# Cancel without answering:
pane-respond <pane> --harness opencode --question que_… --reject
```

Routes to `POST <oc_url>/question/<requestID>/{reply,reject}`. No tmux
`send-keys` is involved on the success path.

## Why no parent-permission removal

`run --attach` continues to auto-deny `question`/`plan_enter`/`plan_exit`
on the parent session — that's intrinsic opencode behavior with no flag
to disable. Leaving it as-is is harmless: the parent agent delegates to
sub-agents anyway, and sub-agents can use the question tool (now safely,
because we route the response). Removing the deny would require a
`PATCH` on the parent session right after creation; not worth the churn.

## Caveats

- **Race between question emit and reply**: if master answers before
  the daemon's next poll, the next poll sees `[]` and `seen_qids`
  prevents re-emit anyway. Safe.
- **Question persists after server kill**: kill `opencode serve` and the
  pending questions vanish with it. Cleanup is automatic.
- **`type your own answer`** in the TUI is a TUI-only affordance. For
  master to provide free-text, reject the question and send a regular
  user message (`opencode run --attach --session <SID> "<text>"`).

## Policy: never pass off-list labels

`POST /question/<id>/reply` does **not** validate that an answer label
appears in the question's `options[]`. The API silently accepts any
string and the agent records it verbatim, which makes typos and
free-form overrides invisible at the protocol level — the agent then
acts on a label that wasn't part of its decision space.

**Master MUST pick one of the structured `options[].label` values from
the wake event payload (or fetched live via `GET /question`)** when
calling `pane-respond --answer` / `--answer-multi`. If none of the
offered options applies, use `--reject` and follow up with
`opencode run --attach --session <SID> "<free-form text>"` instead.
Never construct an answer label that wasn't in `options[]`.
