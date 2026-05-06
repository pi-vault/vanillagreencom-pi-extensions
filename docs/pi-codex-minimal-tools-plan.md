# pi-codex-minimal-tools Plan

> **Historical planning document.** Captures the original design intent. The implementation has shipped and `web_search` has since migrated out to `pi-web-tools`; current behavior lives in [`pi-extensions/pi-codex-minimal-tools/README.md`](../pi-extensions/pi-codex-minimal-tools/README.md).

## Goal

Create a small Pi package named `pi-codex-minimal-tools` that adds the Codex/OpenAI-native tools we actually want, without replacing Pi's normal workflow.

Target tools:

- `image_generation`
- `web_search`
- `view_image`
- `apply_patch`

Primary design principle: **augment Pi, do not turn Pi into Codex CLI**. Keep Pi's native `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` available unless the user explicitly opts into stricter behavior.

## Context from latest Pi changes

Checked latest upstream Pi changelog from `badlogic/pi-mono` `packages/coding-agent/CHANGELOG.md`.

Relevant points for this package:

- Latest package version observed: `@mariozechner/pi-coding-agent@0.72.1`.
- `0.72.1`: OpenAI Codex default transport uses `auto`, enabling cached WebSocket context when available.
- `0.72.0`: model-specific `thinkingLevelMap` replaces old `compat.reasoningEffortMap`.
- `0.72.0`: `pi.registerProvider()` now respects per-model `baseUrl` overrides.
- `0.71.1`: `websocket-cached` transport added for OpenAI Codex subscription auth.
- `0.70.0`: `openai-codex/gpt-5.5` added, including `xhigh` reasoning support and pricing/capability fixes.
- `0.70.0`: `--no-builtin-tools` behavior fixed so extension tools can remain active when built-ins are disabled.
- `0.69.0`: TypeBox 1.x migration; use `typebox` package as Pi docs recommend, not stale `@sinclair/typebox` patterns.
- Unreleased: Pi docs/AGENTS/SKILL read output collapses by default; no direct impact.

Implications:

- Prefer peer deps on Pi packages with `"*"` or a broad `>=0.72.1` development target.
- Do not hardcode old reasoning-effort mapping APIs.
- If we override `openai-codex` streaming, we must preserve Pi's latest transport behavior or clearly opt out. Best outcome is to avoid a full provider override unless native tool event handling forces it.

## What we learned from existing packages

### `@howaboua/pi-codex-conversion`

Useful ideas to borrow:

- Registers `image_generation`, `web_search`, `view_image`, and `apply_patch`.
- Rewrites `image_generation` / `web_search` from function tools into native OpenAI Responses tools in `before_provider_request`.
- Captures native `image_generation_call` outputs, saves PNGs under `.pi/openai-codex-images/`, and mirrors latest to `latest.png`.
- Surfaces native web-search activity as custom foldable messages.
- Provides a practical `view_image` wrapper.
- Provides a local `apply_patch` implementation and Codex-style rendering.

Things not to copy wholesale:

- It replaces Pi's core tools with `exec_command`, `write_stdin`, and `apply_patch`.
- It overrides a lot of OpenAI Codex provider behavior.
- It changes prompt/tool ergonomics globally for OpenAI-like models.
- It hardcodes Image Generation tool config to `{ type: "image_generation", output_format: "png" }` with no user controls.

### `pi-extension-codex-apply-patch`

Useful ideas to borrow:

- CFG/custom-tool apply-patch path.
- Local patch validation and filesystem verification.
- Live patch progress counters.
- Synthetic recovery outputs for interrupted custom-tool calls.

Things not to copy wholesale:

- It gates only `gpt-5.2-codex*` and `gpt-5.3-codex*`, which is stale now that Pi supports `gpt-5.5`.
- It disables `edit` and `write` on supported Codex models. We should not do that by default.
- It has its own `openai-codex` stream implementation that may lag Pi core.

## Package shape

Proposed location in this repo if implemented here:

```text
pi-extensions/pi-codex-minimal-tools/
├── package.json
├── README.md
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── capabilities.ts
│   ├── provider-native-tools.ts
│   ├── tools/
│   │   ├── apply-patch.ts
│   │   ├── image-generation.ts
│   │   ├── view-image.ts
│   │   └── web-search.ts
│   ├── patch/
│   │   ├── parser.ts
│   │   ├── apply.ts
│   │   └── render.ts
│   └── utils/
│       ├── paths.ts
│       ├── images.ts
│       └── truncation.ts
└── tests/
    ├── capabilities.test.ts
    ├── apply-patch.test.ts
    ├── image-generation.test.ts
    ├── provider-native-tools.test.ts
    ├── view-image.test.ts
    └── web-search.test.ts
```

`package.json` outline:

```json
{
  "name": "pi-codex-minimal-tools",
  "version": "0.1.0",
  "description": "Minimal Codex/OpenAI native tools for Pi: image_generation, web_search, view_image, apply_patch",
  "type": "module",
  "keywords": ["pi-package", "pi", "pi-coding-agent", "codex", "openai", "image-generation", "apply-patch"],
  "license": "MIT",
  "pi": { "extensions": ["./src/index.ts"] },
  "vstack": {
    "extensionManager": {
      "displayName": "Codex Minimal Tools",
      "settings": [
        { "key": "enabled", "label": "Enable Codex minimal tools", "description": "Register and auto-manage image_generation, web_search, view_image, and apply_patch.", "type": "boolean", "default": true, "category": "General", "apply": "reload", "requiresReload": true },
        { "key": "autoEnable", "label": "Auto-enable supported tools", "description": "Add this package's tools to the active tool set when the current model supports them, preserving all Pi native tools.", "type": "boolean", "default": true, "category": "General", "apply": "live" },
        { "key": "nativeProviderTools", "label": "Use native OpenAI tools", "description": "Rewrite image_generation and web_search to native OpenAI Codex Responses tools when supported.", "type": "boolean", "default": true, "category": "Provider", "apply": "reload", "requiresReload": true },
        { "key": "imageGeneration", "label": "Enable image_generation", "description": "Expose the image_generation tool on supported OpenAI Codex image-capable models.", "type": "boolean", "default": true, "category": "Images", "apply": "live" },
        { "key": "imageOutputDir", "label": "Image output directory", "description": "Directory for generated images, relative to the workspace/repo root unless absolute.", "type": "string", "default": ".pi/openai-codex-images", "category": "Images", "apply": "live" },
        { "key": "imageModel", "label": "Direct image API model", "description": "Image model for optional direct OpenAI Images API fallback.", "type": "enum", "enumValues": ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"], "default": "gpt-image-2", "category": "Images", "apply": "live" },
        { "key": "directImageApiFallback", "label": "Direct Images API fallback", "description": "Allow direct OpenAI Images API generation with OPENAI_API_KEY when native Codex image_generation is unavailable.", "type": "boolean", "default": false, "category": "Images", "apply": "live" },
        { "key": "webSearch", "label": "Enable web_search", "description": "Expose native OpenAI Codex web search on supported models.", "type": "boolean", "default": true, "category": "Web", "apply": "live" },
        { "key": "showWebSearchSessionNotice", "label": "Show web search session notice", "description": "Show a one-time notice when native web search is enabled. Off by default to avoid startup noise.", "type": "boolean", "default": false, "category": "Web", "apply": "live" },
        { "key": "viewImage", "label": "Enable view_image", "description": "Expose local image viewing on image-capable models.", "type": "boolean", "default": true, "category": "Images", "apply": "live" },
        { "key": "applyPatchEnabled", "label": "Enable apply_patch", "description": "Expose the apply_patch tool while preserving Pi edit/write unless strict patch mode is enabled.", "type": "boolean", "default": true, "category": "Patch", "apply": "live" },
        { "key": "strictPatchMode", "label": "Strict patch mode", "description": "Block edit/write on supported models so edits must use apply_patch. Off by default.", "type": "boolean", "default": false, "category": "Patch", "apply": "live" },
        { "key": "allowAbsolutePatchPaths", "label": "Allow absolute patch paths", "description": "Permit absolute paths in apply_patch. Off by default; relative paths stay anchored to ctx.cwd.", "type": "boolean", "default": false, "category": "Patch", "apply": "live" },
        { "key": "deferApplyPatchRendering", "label": "Defer apply_patch rendering", "description": "Do not define apply_patch renderers; let pi-tool-renderer or Pi's native renderer handle display to avoid duplicate formatting.", "type": "boolean", "default": true, "category": "Patch", "apply": "reload", "requiresReload": true }
      ]
    }
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-ai": "^0.72.1",
    "@mariozechner/pi-coding-agent": "^0.72.1",
    "@mariozechner/pi-tui": "^0.72.1",
    "typebox": "^1.1.24",
    "tsx": "^4",
    "typescript": "^5.9"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test tests/**/*.test.ts",
    "check": "npm run typecheck && npm test"
  }
}
```

## Capability model

Centralize all gating in `src/capabilities.ts`.

Initial policy:

| Tool | Default active when | Notes |
|---|---|---|
| `image_generation` | `provider === "openai-codex"` and model supports image input | Uses native Responses `image_generation` tool. Later add direct OpenAI Images API fallback. |
| `web_search` | `provider === "openai-codex"` | Uses native Responses `web_search`. |
| `view_image` | model input includes `image` | Local file-to-image-content wrapper; useful beyond Codex. |
| `apply_patch` | OpenAI/Codex-like models by default, configurable | Local function tool first; native/custom CFG later. |

Important: active-tool sync must **preserve existing active tools**. It may add/remove only this package's own tools. It must not remove `read`, `edit`, `write`, `bash`, `grep`, `find`, or `ls`.

Implementation approach:

- Register all tools at extension load.
- On `session_start`, `model_select`, and `thinking_level_select`, recompute which of our tools should be active.
- Preserve user choices: if user disabled one of our tools manually via `/tools`, do not re-add it unless model changed into a newly supported mode or package setting says `autoEnable: true`.
- Add a small `/codex-minimal-tools` diagnostic command showing current model, active tools, and why each package tool is enabled/disabled.

## Tool details

### `view_image`

Purpose: allow the model to inspect local image files when the current model accepts images.

Parameters:

```ts
{
  path: string;
  detail?: "auto" | "low" | "high" | "original";
}
```

Plan:

- Resolve relative paths against `ctx.cwd`.
- Strip a leading `@` for compatibility with common model behavior.
- Reject directories and non-image files with clear error messages.
- Return only image content to the LLM, not a huge text dump.
- Keep `original` detail behind a narrow capability gate; default to `auto`.
- Render compactly in TUI with file path and image metadata.

Borrow from `pi-codex-conversion/src/tools/view-image-tool.ts`, but simplify and preserve Pi-native file tools.

### `image_generation`

Purpose: generate images from Pi using OpenAI's native `image_generation` Responses tool when available.

Parameters, phase 1:

```ts
{
  prompt?: string;        // optional because native tool can infer from conversation
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  output_format?: "png" | "webp" | "jpeg";
}
```

Native OpenAI Responses tool supports these controls, but `pi-codex-conversion` currently hardcodes only `output_format: "png"`. We should expose controls where the provider accepts them, while providing safe defaults.

Storage plan:

```text
.pi/openai-codex-images/
├── latest.png
├── latest.webp
└── <timestamp>-<call-id>-<response-id>.<ext>
```

Behavior:

- Save generated images under repo root when inside a Git repo; otherwise under `ctx.cwd`.
- Mirror the newest image to `latest.<ext>` and `latest.png` only when the output is PNG.
- Show a custom message with path, prompt/revised prompt if available, model, size/quality metadata if available, and an inline preview when UI supports it.

Provider question:

- Pi AI `0.72.1` built-in Responses stream handling appears to process only function calls, not native `image_generation_call` / `web_search_call` / custom tool calls.
- Therefore, native image generation probably requires a minimal `openai-codex` stream shim unless Pi core adds native event support.
- The shim should be as small as possible and should preserve Pi `0.72.1` features: `auto` transport, `websocket-cached`, prompt cache session IDs, service tier, text verbosity, thinking level handling via `thinkingLevelMap` metadata, and per-model baseUrl.

Fallback option:

- Add optional direct Images API mode for users with `OPENAI_API_KEY`, calling `gpt-image-2` explicitly.
- This would work outside `openai-codex`, but it would not use ChatGPT subscription auth. Keep it optional and clearly documented.

### `web_search`

Purpose: expose native OpenAI Codex web search.

Parameters:

```ts
{}
```

Plan:

- Register a zero-argument `web_search` tool.
- For `openai-codex`, rewrite its function tool definition to native Responses:

```ts
{
  type: "web_search",
  external_web_access: true,
  search_content_types?: ["text", "image"]
}
```

- For Spark/text-only models, omit multimodal content types.
- Capture `web_search_call` events and show merged foldable status messages with queries and top sources.
- Do not add a local browser/search implementation in phase 1; Pi already has shell/network options, and native web search is the real value.

### `apply_patch`

Purpose: provide patch-based editing while keeping Pi's native `edit` and `write` available.

Phase 1: local function tool.

Parameters:

```ts
{
  input: string;
}
```

Patch format:

```text
*** Begin Patch
*** Add File: path
+line
*** Update File: path
@@ optional context
-old
+new
*** Delete File: path
*** End Patch
```

Behavior:

- Parse and validate before file mutation.
- Resolve relative paths against `ctx.cwd`.
- Strip leading `@` and surrounding quotes.
- Decide explicit path policy before implementation:
  - safer default: reject absolute paths outside `ctx.cwd`;
  - configurable `allowAbsolutePaths` if we need Codex parity.
- Participate in Pi's file mutation queue if available/exported (`withFileMutationQueue`) so parallel edits do not race built-in `edit`/`write`.
- **Do not create duplicate apply_patch output formatting by default.** Register the tool without `renderCall` / `renderResult` when `deferApplyPatchRendering` is true, so existing renderers can hook in.
- Rely first on existing rendering support:
  - `pi-tool-renderer` already has an `applyPatchRenderer` setting that installs call/result renderers for a tool named `apply_patch` when that tool does not define its own renderer.
  - That renderer recognizes argument keys `patch`, `patchText`, `patch_text`, and `input`, so our `{ input: string }` schema is compatible.
  - It parses the patch for call-phase previews and uses Pi's rich diff/highlighting path (`shikiDiffs`, word diff highlights, hunk metadata) rather than duplicating that logic.
- Return concise text content and structured `details` for diagnostics only; do not make the tool result depend on a custom renderer.
- If `pi-tool-renderer` is absent, allow Pi's fallback tool renderer to show raw success/error text. Later we can add an opt-in minimal renderer, but not by default.
- Return clear partial-failure recovery instructions if earlier file actions succeeded and later actions failed.

Phase 2: native/custom grammar support.

Options to evaluate:

1. Native Responses `{"type": "apply_patch"}` if OpenAI supports it for the selected model and Pi stream handling can map `apply_patch_call` events.
2. Custom CFG freeform tool with Lark grammar, following `pi-extension-codex-apply-patch`.
3. Keep function tool only if it is reliable enough.

Do not disable Pi's `edit` / `write` by default. If desired later, add a package setting or command for strict patch mode.

## Provider integration strategy

### Preferred path

Avoid overriding providers if Pi core can handle native tools.

Implementation spike:

1. Register tools normally.
2. Use `before_provider_request` to rewrite relevant function tools into native tool definitions.
3. Test with `openai-codex/gpt-5.5`:
   - Does Pi stream handler preserve `image_generation_call`?
   - Does it surface native `web_search_call`?
   - Are follow-up turns valid after native calls?

### Expected path

Because `@mariozechner/pi-ai@0.72.1` shared OpenAI Responses stream code appears to handle function calls but not native image/web/custom apply-patch events, implement a **minimal provider shim**.

Shim requirements:

- Only override `openai-codex` when at least one native tool is active.
- Preserve all model metadata and auth behavior.
- Preserve latest Pi Codex features:
  - session ID prompt cache;
  - `auto` / `websocket` / `websocket-cached` transport behavior;
  - service tier forwarding/cost accounting;
  - text verbosity default `low`;
  - reasoning/thinking level clamping from model metadata;
  - per-model `baseUrl` overrides.
- Handle events:
  - normal text and reasoning;
  - normal function tool calls;
  - `web_search_call` activity;
  - `image_generation_call` results;
  - future `apply_patch_call` or `custom_tool_call` only when phase 2 is enabled.
- Convert native activity to Pi messages without polluting LLM context unless required for follow-up validity.

Maintenance warning: provider shims are high-churn. Keep this module isolated and heavily tested so we can delete it if Pi core gains native tool support.

## Configuration

Expose important user settings through `pi-extension-manager` from day one using the package manifest `vstack.extensionManager.settings` schema. Settings should be stored under:

```json
{
  "vstack": {
    "extensionManager": {
      "config": {
        "pi-codex-minimal-tools": {}
      }
    }
  }
}
```

Implementation should follow existing vstack package patterns (`pi-output-policy`, `pi-session-manager`, `pi-caveman`): merge user and project `.pi/settings.json`, read `vstack.extensionManager.config["pi-codex-minimal-tools"]`, and keep defaults in code in sync with `package.json`.

Proposed options:

```ts
interface CodexMinimalToolsSettings {
  autoEnable: boolean;              // default true
  nativeProviderTools: boolean;     // default true for openai-codex
  directImageApiFallback: boolean;  // default false
  imageModel: "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1";
  imageOutputDir: string;           // default .pi/openai-codex-images
  applyPatchEnabled: boolean;       // default true
  strictPatchMode: boolean;         // default false; if true, blocks edit/write on supported models
  allowAbsolutePatchPaths: boolean; // default false
  showWebSearchSessionNotice: boolean; // default false; avoid noisy startup notices
  viewImage: boolean;               // default true
  deferApplyPatchRendering: boolean;// default true; let pi-tool-renderer/Pi render apply_patch
}
```

## Commands and diagnostics

Register `/codex-minimal-tools` command:

- no args: show current status, active model, enabled/disabled tools and reasons.
- `doctor`: run self-checks:
  - current Pi version;
  - provider/model capability;
  - whether native provider shim is active;
  - whether image output dir is writable;
  - whether `OPENAI_API_KEY` exists for direct image fallback.
- `settings`: open or explain `pi-extension-manager` / `/extensions settings` for this package rather than creating a duplicate settings UI.

Extension-manager requirements:

- Add `vstack.extensionManager.displayName = "Codex Minimal Tools"`.
- Add settings metadata in `package.json` for every user-facing option above.
- Use categories: `General`, `Provider`, `Images`, `Web`, `Patch`.
- Mark provider-shim toggles as `apply: "reload"` / `requiresReload: true`; pure behavior toggles can be `apply: "live"`.
- README must document that settings appear under `/extensions` and `/extensions settings` when `pi-extension-manager` is installed.

## Testing plan

Unit tests:

- capability detection across current Pi model catalog:
  - `openai-codex/gpt-5.5` => image/web/apply/view enabled;
  - `openai-codex/gpt-5.3-codex-spark` => web/apply enabled, image/view disabled;
  - regular `openai/gpt-5.5` => apply/view as configured, native image/web disabled unless fallback enabled.
- native tool rewrite payloads.
- extension-manager settings schema/defaults match runtime defaults.
- settings merge order: user settings first, project settings override, malformed settings ignored.
- image path generation and latest symlink/copy behavior.
- web search activity message merge and rendering text.
- apply_patch renderer compatibility:
  - tool name is exactly `apply_patch`;
  - primary arg key is `input`;
  - default registration omits `renderCall` and `renderResult` so `pi-tool-renderer` can hook in;
  - success/error text remains useful with Pi fallback renderer.
- apply_patch parser and application:
  - add/update/delete/move;
  - multi-file patch;
  - path traversal rejection;
  - absolute path policy;
  - partial failure recovery.
- view_image rejects non-images and returns image blocks.

Integration tests:

- Package installs with `pi install ./pi-extensions/pi-codex-minimal-tools -l`.
- `pi -e ./pi-extensions/pi-codex-minimal-tools` starts without replacing core tools.
- `pi-extension-manager` shows **Codex Minimal Tools** and all settings under `/extensions` and `/extensions settings`.
- With `pi-tool-renderer` installed, `apply_patch` uses the existing apply_patch renderer; with it disabled/absent, raw fallback output is still readable.
- In a temp repo:
  - `apply_patch` edits files correctly;
  - `view_image` can inspect a generated PNG;
  - if credentials available, `image_generation` creates `.pi/openai-codex-images/latest.png`;
  - if credentials available, `web_search` surfaces query/source messages.

Manual dogfood scenarios:

1. Ask `openai-codex/gpt-5.5` to generate a small icon and then inspect it with `view_image`.
2. Ask it to search for current OpenAI image-generation docs and cite sources.
3. Ask it to make a multi-file code change using `apply_patch`, then run tests.
4. Switch to a non-Codex model and confirm native tools disable cleanly while Pi tools remain.

## Implementation phases

### Phase 0 — scaffold

- Create package skeleton under `pi-extensions/pi-codex-minimal-tools`.
- Add package manifest, tsconfig, README, tests.
- Register no-op diagnostic command.
- Confirm package loads with `pi -e` and `/reload`.

### Phase 1 — local tools that do not require provider override

- Implement `view_image`.
- Implement function-tool `apply_patch` with parser/application tests and renderer-compatibility tests.
- Do **not** define `renderCall` / `renderResult` for `apply_patch` by default; verify `pi-tool-renderer` can render it via its existing `applyPatchRenderer` hook.
- Dynamic activation that preserves existing tools.
- No provider override yet.

### Phase 2 — native image_generation and web_search spike

- Register function-shaped placeholder tools.
- Try `before_provider_request` rewrite only.
- Confirm whether Pi core handles native events. If yes, keep provider-free design.
- If not, implement minimal provider shim.

### Phase 3 — provider shim if needed

- Fork/adapt only the minimum from latest Pi `openai-codex-responses` plus targeted logic from `pi-codex-conversion`.
- Preserve latest Pi transport/caching behavior.
- Add native event capture for image/web.
- Add custom message renderers.

### Phase 4 — image controls and direct fallback

- Expose image generation parameters.
- Add optional direct `gpt-image-2` Images API fallback for users with `OPENAI_API_KEY`.
- Add `/codex-minimal-tools doctor` checks.

### Phase 5 — advanced apply_patch

- Evaluate native Responses `apply_patch` and/or custom CFG grammar support.
- Add only if it materially improves reliability over function-tool patching.
- Keep strict patch mode opt-in.

## Non-goals

- Do not replace Pi's shell with `exec_command` / `write_stdin`.
- Do not remove `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write` by default.
- Do not globally override all OpenAI/GPT models with Codex prompts.
- Do not fork large chunks of Pi provider code unless native tool event support requires it.
- Do not show noisy session notices every startup.
- Do not require users to globally install the package during development.

## Open questions

- Can latest Pi core be extended via `before_provider_request` alone for native image/web calls, or must we override the provider stream?
- Should `image_generation` be native-only for ChatGPT subscription auth, or should v0.1 also include direct Images API `gpt-image-2` fallback?
- Should `apply_patch` be enabled for all models or only OpenAI/Codex-like models?
- Should absolute patch paths be supported for Codex parity or rejected for safety?
- Do we need any custom apply_patch renderer at all, or can `pi-tool-renderer` plus Pi fallback cover every case?
- Should settings live only under `vstack.extensionManager.config`, or should we also support env-var overrides for CI/non-interactive use?

## Success criteria

- Package adds four tools without degrading Pi-native tool UX.
- `openai-codex/gpt-5.5` can generate an image and save it to `.pi/openai-codex-images/latest.png`.
- Native web search works when supported and displays concise query/source status.
- `view_image` works for local images on image-capable models.
- `apply_patch` reliably performs multi-file edits and renders readable diffs through existing renderer hooks, with no duplicate/changing output chrome from this package.
- Switching models does not leave stale tools active or break follow-up turns.
