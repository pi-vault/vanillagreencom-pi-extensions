# pi-codex-minimal-tools

Minimal Codex/OpenAI tool augmentation for Pi. This package adds the useful Codex-style tools without replacing Pi native tools like `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`.

Implemented features:

- `view_image` — validate and return a local image file as model image content.
- `apply_patch` — local Codex-style patch application with the public argument shape `{ input: string }`.
- `/codex-minimal-tools` — diagnostic command for current settings, model, and active package tools.
- Capability gating that only adds/removes this package's tools and preserves Pi native tools.
- OpenAI-loaded gating: package tools are not registered until OpenAI/OpenAI-Codex models are present.
- Native-aware OpenAI Codex provider shim for active `image_generation` / `web_search` tools.
- Generated image saving under `imageOutputDir` with `latest.<ext>` mirrors.
- Optional direct OpenAI Images API fallback when `directImageApiFallback` is enabled and `OPENAI_API_KEY` is set.

## Commands

| Command | Action |
| --- | --- |
| `/codex-minimal-tools` | Show current status and diagnostics. |
| `/codex-minimal-tools doctor` | Run lightweight self-checks. |
| `/codex-minimal-tools settings` | Show where extension-manager settings live. |

Arguments support autocomplete.

## Settings

When `pi-extension-manager` is installed, settings appear under **Codex Minimal Tools** in `/extensions` and `/extensions settings`. Values are read from:

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

Project `.pi/settings.json` overrides user `~/.pi/agent/settings.json`.

Important defaults:

- `autoEnable`: `true`
- `nativeProviderTools`: `true`
- `applyPatchEnabled`: `true`
- `deferApplyPatchRendering`: `true`
- `strictPatchMode`: `false`

## Reloading

If this package is already loaded in a running Pi session, use `/reload` after installing/updating it so Pi loads the new extension code and command/tool registrations. Starting a new Pi process also works.

## apply_patch rendering

`apply_patch` is registered with:

- tool name exactly `apply_patch`
- primary argument key `input`
- no `renderCall` / `renderResult` by default

This lets `pi-tool-renderer` attach its existing `applyPatchRenderer` hook. Without that package, Pi's fallback renderer still shows the raw success/error text.

## Development

```bash
cd pi-extensions/pi-codex-minimal-tools
npm install
npm run check
```
