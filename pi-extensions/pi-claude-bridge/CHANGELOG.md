# Changelog

## 1.0.0

Initial vstack fork of `elidickinson/pi-claude-bridge`.

- Registers Claude Code as a Pi provider via `claude-bridge/*` models.
- Removes the upstream AskClaude tool; this package is provider-only.
- Adds vstack extension-manager settings.
- Adds opt-in forwarding for `APPEND_SYSTEM.md` and recognized Pi `before_agent_start` prompt hooks (`pi-agents-tmux`, `pi-task-panel`, `pi-caveman`).
- Keeps upstream provider fixes for session sync/rebuild, compact recovery, abort recovery, ID-based tool-result matching, skills forwarding, strict MCP config, cloud MCP suppression, and Opus thinking display.
- Pins and bundles Claude Agent SDK `0.2.128`, with auto-detection of the local `claude` executable for vstack installs without `node_modules`.
