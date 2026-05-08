# pi-tool-renderer

![tool_batch composite result with Read/grep/Bash rows](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-tool-renderer/assets/tool-batch.png)
![Edit tool with side-by-side diff renderer](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-tool-renderer/assets/edit-diff.png)

Compact renderers for Pi tools, plus an optional `tool_batch` composite tool.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-tool-renderer):

```bash
pi install npm:@vanillagreen/pi-tool-renderer
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-tool-renderer --harness pi -y
```

Restart Pi after installation.

## Defaults

- Re-registers `read`, `bash`, and available `grep`/`find`/`ls` with compact self-rendered rows while delegating execution to Pi's original tools.
- Registers `tool_batch` so multiple independent read/search/list/diagnostic bash calls can render as one combined result.
- Leaves `edit` and `write` on Pi's built-in renderers by default so standard diff/edit UI is preserved.
- Compacts user-message cards by default (`compactUserMessages=true`).
- Renders compaction summaries as compact tool-style rows by default (`compactCompactionMessages=true`).
- Keeps Pi's normal expand/collapse keybinding (`Ctrl+O`).

## `tool_batch`

`tool_batch` accepts calls for `read`, `grep`, `find`, `ls`, and diagnostic `bash`.

```json
{
  "calls": [
    { "tool": "read", "path": "README.md" },
    { "tool": "grep", "pattern": "registerCommand", "path": "pi-extensions" }
  ]
}
```

Prefer it for independent inspection calls. Do **not** use it for mutating commands, order-dependent commands, streaming output, or commands that should be inspected separately.

Per-call arguments can be flat, as above, or `{ "tool": "read", "args": { "path": "README.md" } }`.

`tool_batch` does not reduce per-call output while the combined result fits Pi's normal tool-result budget. If the aggregate would exceed that budget, it caps only enough child output to keep the single batch result safe, preserving head and tail for capped children. Use separate calls or explicit `read` `offset`/`limit` chunks when you need the maximum output budget from each call.

## Optional renderers

Enable through `pi-extension-manager` settings:

- `renderMutationTools=true`: compact `edit`/`write` renderers with rich red/green diff summaries, hunk counts, syntax highlighting, and optional side-by-side previews (`splitDiffs`).
- `renderBashDiffs=false`: keep read-only bash commands that output unified/git patches to a single compact summary line by default; enable to render those outputs with the rich Shiki diff UI.
- `renderGitDiffCommandDiffs=false`: keep explicit `git diff` bash commands to a single compact summary line by default; enable to restore the rich Shiki diff UI for those commands.
- `applyPatchRenderer` / `applyPatchPreview`: render `apply_patch` calls/results with parsed file patch previews.
- Generic OpenAI-style tool renderers for names such as `web_search`, `webfetch`, `fetch_content`, `Agent`, and `Task*`.
- MCP-looking tool renderers (`mcp`, `mcp__server__tool`, etc.) with `mcpOutputMode`.
- `workingIndicator`: optionally use a compact pulse or hide Pi's streaming indicator.
- `toolChrome`: optional global container chrome (`off`, `transparent`, or `outlines`).
- `rightMarginGuard=true`: render compact tool chrome, wrapped lines, diffs, and compact user-message borders one column short to avoid right-margin auto-wrap flashes in tmux and some terminals.
- `pendingStatusAnimation=false`: animate pending compact tool bullets; disabled by default for more stable streaming output at the bottom of terminal panes.

Output modes can be tuned live with `readOutputMode`, `searchOutputMode`, `bashOutputMode`, and `mcpOutputMode`.

## Legacy stacking

`stackToolCalls=true` enables legacy stacking for separate native tool calls. It is disabled by default because current Pi still reserves spacer rows for hidden sibling tool entries. `stackChildDisplay` controls the tradeoff:

- `rows`: render child tools as separate compact `├`/`└` rows.
- `headline`: hide child rows and show the list only when expanded.
- `anchor-list`: hide child rows and show the compact list in the headline by default.

`hideStackChildRows` remains as a legacy alias for `stackChildDisplay="headline"` when `stackChildDisplay` is unset.

## Limits

This package mostly changes rendering, not underlying tool execution. The `tool_batch` helper is a single tool result, so it enforces an aggregate safety cap when combined child output would exceed Pi's normal result budget; individual built-in tools still apply their own truncation first. Hidden `Thinking...` labels and reserved spacer rows require Pi core renderer changes to remove completely.
