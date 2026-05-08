# pi-questions

![Questions workflow](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-questions/assets/questions-workflow.gif)

Structured inline questions for Pi, with multi-tab categories and `pi-bridge` answer/reject support.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-questions):

```bash
pi install npm:@vanillagreen/pi-questions
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-questions --harness pi -y
```

Restart Pi after installation.

## What it provides

- `question` tool for multiple-choice question tabs.
- Ships `instructions.md` so vstack/npm install adds `question` usage rules to the scope's `APPEND_SYSTEM.md`, removed on uninstall or disable.
- `ctx.askQuestions(payload)` helper for other Pi extensions.
- Editor-area UI by default, matching opencode/Claude-style prompts.
- Wrapped option labels/descriptions so long choices remain readable in narrow panes.
- Optional legacy floating overlay mode.
- `pi-session-bridge` integration for listing, answering, rejecting, and streaming question events.
- `pi-qol` notification hook before prompts open.

## Payload

```json
{
  "id": "que_example",
  "header": "Choose next action",
  "questions": [
    {
      "header": "Issue Missing",
      "question": "How should I proceed?",
      "options": [
        { "label": "Use current branch", "description": "Continue without a tracker issue." },
        { "label": "Stop here", "description": "Wait for operator guidance." }
      ],
      "multiple": false,
      "allowCustom": true,
      "customLabel": "Type issue ID"
    }
  ]
}
```

Result:

```json
{ "requestId": "que_example", "answers": [["Stop here"]] }
```

Rejected/cancelled result:

```json
{ "requestId": "que_example", "cancelled": true }
```

## Free-form answers

Set `allowCustom: true` on a tab to add a free-type row. Selecting it opens an inline text editor, and the submitted text is returned in that tab's answer array. Bridge callers can provide the same custom answer by passing any non-empty string for that tab.

Optional fields:

- `customLabel`: label for the free-type row; default `Type custom answer`.
- `customPlaceholder`: help text shown beside the custom row/editor.

Very large result JSON is truncated to Pi's default 50KB/2000-line tool limit and saved to a temp file with the path included in the result.

## Interactive keys

| Key | Action |
| --- | --- |
| `←` / `→` or `Tab` | Switch tabs. |
| `↑` / `↓` | Move selection. |
| `Enter` | Pick/advance/submit; on the custom row, open text input. |
| `Space` | Toggle multi-select rows; on the custom row, open text input. |
| `Esc` | Cancel the request, or leave custom text input. |

## Settings

Settings are exposed through `pi-extension-manager` under **Questions**.

- `renderMode`: `editor` (default) or `overlay`.
- `optionRows`: maximum visible option rows before scrolling.
- `popupWidth` / `popupMaxHeight`: overlay mode only.
- `defaultHeader`: fallback question title.
- `bridgeRepliesEnabled`: allow `pi-session-bridge` to answer/reject pending questions.

## Bridge control

Requires `pi-session-bridge` in the same Pi runtime.

```bash
pi-bridge stream --pid <PID>
pi-bridge questions --pid <PID>
pi-bridge answer --pid <PID> --request-id que_example --answers '[["Stop here"]]'
pi-bridge reject --pid <PID> --request-id que_example
```
