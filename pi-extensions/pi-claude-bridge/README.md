# pi-claude-bridge

![Claude bridge provider](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-claude-bridge/assets/claude-bridge1.png)

Claude Code provider bridge for Pi. It registers `claude-bridge/*` models and routes Pi turns through the Claude Agent SDK while keeping Pi's tools in the Pi TUI.

This package is a vstack fork of [`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge). The provider, MCP tool bridge, session sync, streaming, and Claude Code SDK plumbing come from that project; this fork removes the AskClaude tool and adds vstack-controlled prompt-context forwarding.

## What it provides

- `claude-bridge/claude-opus-4-7`, Sonnet, and Haiku models in `/model`.
- Pi tool calls bridged to Claude Code through a local MCP server.
- Session reuse/rebuild so Claude Code follows Pi history across normal turns, `/compact`, forks, tree navigation, and abort recovery.
- Thinking-level forwarding, summarized Opus thinking display, MCP isolation, and Claude cloud-MCP suppression to reduce token overhead.
- Optional forwarding of Pi-only context that upstream does not pass to Claude Code.

## Prompt context

Default behavior matches upstream: append `AGENTS.md` plus Pi's skills block to Claude Code's `claude_code` preset prompt.

Extra Pi prompt context is **off by default** and can be enabled in `/extensions:settings` → `Claude Bridge`:

| Setting | Default | Effect |
| --- | --- | --- |
| `includeAppendSystemPromptMd` | off | Forward project/global `APPEND_SYSTEM.md`, including `.pi/APPEND_SYSTEM.md`. |
| `includeProjectAgentsHook` | off | Forward recognized `pi-agents-tmux` `before_agent_start` additions such as the Project Agents/Subagents list. |
| `includeTaskPanelHook` | off | Forward recognized `pi-task-panel` workflow reminders. |
| `includeCavemanHook` | off | Forward recognized `pi-caveman` response-style prompt additions. |

The bridge detects these hook additions from the effective Pi system prompt for the current turn and forwards only enabled recognized blocks.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `enabled` | on | Register the Claude bridge provider; reload required. |
| `appendSystemPrompt` | on | Forward `AGENTS.md` + skills. |
| `strictMcpConfig` | on | When Claude Code filesystem settings are loaded, block filesystem MCP auto-loads; Pi owns tool execution. |
| `pathToClaudeCodeExecutable` | auto | Explicit `claude` binary path; empty auto-detects `claude` or `claude-code` on PATH. |

Legacy config files are still read: `~/.pi/agent/claude-bridge.json` and `.pi/claude-bridge.json`. vstack extension-manager settings override them.

## Differences from upstream

- No AskClaude tool; this package is provider-only.
- vstack extension-manager settings for prompt forwarding and Claude Code options.
- Bundled runtime dependencies for vstack installs; the bridge auto-detects the local Claude Code executable.
- Opt-in delivery of `APPEND_SYSTEM.md` and recognized Pi `before_agent_start` prompt hooks.
- Keeps upstream provider fixes: ID-based tool-result matching, compact/session rebuild handling, abort recovery, skill read-tool rewriting, strict MCP config, cloud MCP suppression, and Opus 4.7 thinking display forcing.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to write bridge logs to `~/.pi/agent/claude-bridge.log` and per-query Claude Code CLI logs under `~/.pi/agent/cc-cli-logs/`.
