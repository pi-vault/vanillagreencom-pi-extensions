# vstack

Cross-harness package manager for AI coding systems.

Write a package once as a harness-agnostic skill, agent, or hook, then install it into Claude Code, Cursor, OpenCode, Codex, or Pi through one Rust CLI.

[![Rust](https://img.shields.io/badge/Rust-%20-000000?style=flat-square&logo=rust)](./cli/Cargo.toml)
[![Ratatui](https://img.shields.io/badge/TUI-ratatui-5D3FD3?style=flat-square)](https://ratatui.rs)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Cursor](https://img.shields.io/badge/Cursor-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![OpenCode](https://img.shields.io/badge/OpenCode-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Codex](https://img.shields.io/badge/Codex-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Pi](https://img.shields.io/badge/Pi-supported-0EA5E9?style=flat-square)](#supported-harnesses)

![vstack TUI](docs/assets/vstack-tui.png)

---

## What Is vstack?

`vstack` is two things:

1. A Rust CLI and TUI for discovering, selecting, installing, updating, and removing AI coding packages.
2. A maintained package catalog in this repo containing reusable agents, skills, and hooks.

The key idea is simple:

- Packages are authored once in canonical, harness-agnostic formats.
- `vstack` translates them into each harness's native representation at install time.
- Repos can be swapped. The built-in catalog is just the default source, not the only one.

This makes `vstack` closer to a package manager than a static dotfiles repo.

## Features

- **Cross-harness install**: Claude Code, Cursor, OpenCode, Codex, and Pi from one CLI.
- **Package source management**: switch between repos, add/remove sources from the TUI.
- **Global and project scope**: install once per user, or per project.
- **Dependency resolution**: skills declare required/optional dependencies in `SKILL.md`; required deps are auto-included transitively.
- **Config-driven attribution**: `vstack.toml` maps extra skills to agents, role-wide skills to agent roles, and hook events to roles.
- **Project customization**: per-agent guidance, instructions, custom skills, per-skill instructions, and custom hooks via project-level `vstack.toml` — survives upstream updates.
- **Reconciliation**: installed agents and skills regenerate when packages change, preserving user edits.
- **`vstack refresh`**: regenerate all agent files and re-inject project skill instructions after editing `vstack.toml`.
- **Version-based update check**: notifies when the CLI version changes, not on every repo push. `vstack update --force` to rebuild from source.
- **Source registry**: previously used package repos are remembered and reusable from the TUI.
- **Fast terminal UX**: native Rust TUI with mouse support, built with `ratatui` and `crossterm`.

## Quick Start

```bash
# Install the CLI
cargo install --git https://github.com/vanillagreencom/vstack.git vstack

# Open the interactive installer with the default package catalog
vstack add vanillagreencom/vstack
```

Useful commands:

```bash
# Interactive install (TUI)
vstack add vanillagreencom/vstack

# Install from the current repo if you're inside a package source
vstack add

# Install all packages to all detected harnesses
vstack add vanillagreencom/vstack --all

# Global install
vstack add vanillagreencom/vstack --all --global

# Filter what gets installed (each kind narrows independently)
vstack add vanillagreencom/vstack --harness claude-code,opencode -y          # specific harnesses
vstack add vanillagreencom/vstack --skill rust-safety,perf-zero-alloc -y     # specific skills
vstack add vanillagreencom/vstack --agent rust,tpm -y                        # specific agents
vstack add vanillagreencom/vstack --hook block-bare-cd -y                    # specific hooks

# Regenerate agents/skills after editing vstack.toml
vstack refresh

# Update the CLI binary
vstack update              # skips if version matches
vstack update --force      # always rebuilds from source

# Inspect / remove
vstack list
vstack check
vstack remove rust-safety
```

## Project-Local Config

Two config files live at the project root:

- **`vstack.toml`** — agent customization (guidance, instructions, custom skills, custom hooks). Auto-created on first install. Edit and run `vstack refresh` to apply. See [Project Customization](#project-customization).
- **`.env.local`** — workflow config for skills that need it (worktree behavior, issue-tracker tokens, bot auth). Copy [.env.local.example](./.env.local.example) and fill only the variables your project uses. The `worktree` skill symlinks this into created worktrees.

## How It Works

### Mental Model

`vstack` treats a source repo as a package registry:

- `agents/*.md`: canonical agent definitions
- `skills/*/SKILL.md`: canonical skills, rules, scripts, workflows
- `hooks/*.sh`: canonical safety hooks
- `pi-extensions/*/package.json`: optional npm-shaped Pi extension packages
- `vstack.toml`: mapping and attribution rules

At install time, the CLI discovers those packages, lets the user choose what to install, then emits harness-specific files in the correct destination.

### Dependencies And Mapping

Package dependencies are currently skill-to-skill dependencies. A skill can declare them in `SKILL.md` frontmatter:

```yaml
dependencies:
  required: [linear, orchestration, decider]
  optional: []
```

`vstack` builds a dependency graph from installed skills and auto-adds only `required` dependencies. `optional` dependencies are preserved as metadata/documentation, but are not auto-installed.

`vstack.toml` in the source repo is the mapping layer. `[agent-skills]` is the single source of truth for which skills appear in each agent's frontmatter — when an agent has an explicit entry, prefix matching is skipped. `[role-skills]` adds skills to all agents of a role. `[hook-events]` assigns hooks by event/matcher to roles.

```toml
[agent-skills]
rust = ["rust-arch", "rust-async", "rust-cargo", "rust-conventions", "rust-cross", "rust-debugging", "rust-ffi", "rust-no-std", "rust-safety"]
iced = ["iced-rs", "iced-shadcn", "trading-design", "price-handling"]

[role-skills]
engineer = ["issue-lifecycle", "github", "worktree", "decider", "linear"]
reviewer = ["issue-lifecycle", "linear"]

[hook-events]
"PreToolUse:Bash" = "all"
"PostToolUse:Edit|Write" = ["engineer"]
```

### Project Customization

`vstack add` auto-creates a `vstack.toml` at your project root with commented placeholders for every installed agent and skill. Edit the values, then run `vstack refresh` to apply.

All sections survive upstream updates — they're re-applied from the config on every install and refresh.

```toml
# What the agent should do when first invoked
[agent-launch-instructions]
rust = "Read open issues and begin working on the highest-priority backend task."
generalist = ""    # empty = no section generated

# Project-specific rules appended to the bottom of agent files
[agent-additional-instructions]
rust = "Always run clippy before committing."

# Skills attached to each agent's frontmatter — single source of truth.
# Populated automatically at install time. Add your own skills to any
# agent's list; remove skills you don't want. Run `vstack refresh` to apply.
[agent-skills]
rust = ["rust-arch", "rust-async", "rust-cargo", "rust-conventions", "rust-cross", "rust-debugging", "rust-ffi", "rust-no-std", "rust-safety", "decider", "github", "issue-lifecycle", "linear", "worktree"]
iced = ["iced-rs", "iced-shadcn", "trading-design", "price-handling", "decider", "github", "issue-lifecycle", "linear", "worktree"]

# Project instructions appended at the bottom of each skill's SKILL.md (won't overwrite the skill author's own)
[skill-instructions]
trading-design = "Focus on dark theme with green/red accent colors."

# Project-local hooks (Claude Code runs the command; other harnesses get the description as inline instructions)
[[custom-hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./scripts/no-force-push.sh"
description = "Never run git push --force on main or master."
agents = "all"     # "all", a role ("engineer"), or a list ["rust", "iced"]
```

If you edit a generated agent or skill file directly (e.g., add an "Additional Instructions" section), vstack extracts your edits and saves them to `vstack.toml` before the next regeneration — so both approaches work.

### Skill Instructions

Project-specific skill guidance lives in the project root `vstack.toml` under `[skill-instructions]`. vstack injects that text into the installed `SKILL.md` during `vstack add` and `vstack refresh`, so project guidance survives upstream package updates without editing source skills directly.

### Architecture

```text
source repo
├─ agents/*.md
├─ skills/*/SKILL.md
├─ hooks/*.sh
└─ vstack.toml
        │
        ▼
   vstack CLI / TUI
   - discovers packages
   - resolves dependencies
   - selects repo / scope / harnesses / method
   - applies mapping rules
        │
        ├─ Claude Code → .claude/agents, .claude/skills, .claude/hooks, settings.json
        ├─ Cursor      → .cursor/rules
        ├─ OpenCode    → .opencode/agents, .opencode/skills, opencode.json
        ├─ Codex       → .codex/agents, .agents/skills
        └─ Pi          → .pi/agents, .agents/skills, .pi/packages, .pi/settings.json
```

### Repo Sources

The default source is this repo: `vanillagreencom/vstack`.

The TUI also supports:

- switching between remembered package repos
- adding a new package repo by GitHub shorthand or URL
- persisting known sources in a small registry under vstack's global state

Compatible repos follow the same content model:

```text
agents/
skills/
hooks/
pi-extensions/
vstack.toml
```

`pi-extensions/` is optional — only include it if your repo ships Pi extension packages.

## Supported Harnesses

| Harness | Agents | Skills | Hooks | Notes |
|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md` | `.claude/skills/<name>/` | native `.claude/hooks/*.sh` + `settings.json` | richest native hook support |
| Cursor | `.cursor/rules/*.mdc` | `.cursor/rules/<name>/` | safety rules only | project scope only |
| OpenCode | `.opencode/agents/*.md` | `.opencode/skills/<name>/` | instructions + `opencode.json` permissions | config-dir aware |
| Codex | `.codex/agents/*.toml` | `.agents/skills/<name>/` | safety prose in `developer_instructions` | uses `CODEX_HOME` when set |
| Pi | `.pi/agents/*.md` | `.agents/skills/<name>/` | safety prose in agent body | extensions install to `.pi/packages/<name>` and register in `.pi/settings.json` |

Global install behavior:

- Claude Code: user home `~/.claude`
- OpenCode: config-dir based, respecting `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`
- Codex: `CODEX_HOME` or `~/.codex`
- Pi: `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`
- Cursor: intentionally project-only

### Pi notes

vstack writes Pi agent frontmatter (`name`, `description`, `tools`, `model`, optional `pane: true`) plus the standard body sections (Required Skills, Hook Rules, Additional Instructions). Hooks have no native Pi runtime, so they surface as inline safety prose in the agent body.

Pi has no built-in subagent mechanism, so installed `.pi/agents/*.md` files are inert until you also install a Pi extension that loads them. The `pi-subagents-tmux` package shipped in this repo provides that loader/delegation layer; `pi-session-bridge` is a separate TUI side-channel for external controllers.

For Pi extensions, `vstack add`:
- Copies the package into `<scope>/packages/<name>` (`~/.pi/agent` for `--global`, `<project>/.pi` otherwise).
- Registers `./packages/<name>` in that scope's `settings.json` (preserves unrelated entries).
- For each entry in the package's `package.json` `bin` map, creates a symlink at `<scope>/bin/<cli-name>` pointing at the installed binary. Pi auto-loads the package on next launch and the CLI is reachable as `<scope>/bin/<cli-name>` (add it to your `PATH` if you want bare-name invocation).

Pi extensions are scope-exclusive — Pi loads packages from both global and project scopes simultaneously, so duplicate registration would crash startup. Installing the same extension at one scope when it already exists at the other is skipped with a clear notice; switch by removing first (`vstack remove [--global] <name>`) and re-adding at the desired scope. `vstack remove` cleans the package dir, `settings.json` entry, and any `bin` symlinks.

Windows note:

- The CLI should run natively.
- “Symlink” mode falls back to copy on non-Unix targets.

## Package Catalog In This Repo

### Agents

| Agent | Role | Brief |
|---|---|---|
| `generalist` | engineer | General maintenance, cleanup, docs, stale references, and project hygiene. |
| `iced` | engineer | Iced UI implementation and architecture specialist. |
| `rust` | engineer | Rust engineer for systems work, performance, zero-allocation, and low-level design. |
| `tpm` | manager | Technical program management and roadmap analysis agent. |
| `reviewer-arch` | reviewer | Reviews boundaries, abstractions, and architectural drift. |
| `reviewer-doc` | reviewer | Reviews documentation accuracy and stale docs. |
| `reviewer-error` | reviewer | Reviews error handling, silent failures, and propagation. |
| `reviewer-perf` | reviewer | Reviews latency, benchmarks, and performance regressions. |
| `reviewer-safety` | reviewer | Reviews unsafe Rust, memory safety, and concurrency correctness. |
| `reviewer-security` | reviewer | Reviews auth, input handling, and security risks. |
| `reviewer-structure` | reviewer | Reviews modularity, file size, and code organization. |
| `reviewer-test` | reviewer | Reviews test coverage, missing cases, and test quality. |

### Skills

#### Rust

| Skill | Brief |
|---|---|
| `rust-arch` | Rust architecture rules, anti-patterns, and review heuristics. |
| `rust-async` | Async internals, runtime patterns, cancellation, and concurrency composition. |
| `rust-cargo` | Cargo workflows, workspaces, feature flags, and build/release config. |
| `rust-conventions` | Style, layout, tests, and definition-of-done conventions. |
| `rust-cross` | Cross-compilation, target setup, and multi-platform builds. |
| `rust-debugging` | GDB/LLDB, tracing, panic triage, and async runtime debugging. |
| `rust-ffi` | Safe C interop and FFI wrapper patterns. |
| `rust-no-std` | `no_std` design, alloc boundaries, and embedded-friendly structure. |
| `rust-safety` | Unsafe code review, SAFETY comments, and safety audit patterns. |

#### Performance

| Skill | Brief |
|---|---|
| `perf-cache` | Cache locality, false sharing, and data layout optimization. |
| `perf-ebpf` | Aya/eBPF instrumentation and kernel-level observability. |
| `perf-latency` | Benchmarking and percentile-focused latency measurement. |
| `perf-lock-free` | Atomics, loom verification, and lock-free correctness. |
| `perf-profiling` | Flamegraphs, hotspot analysis, NUMA, and jitter investigation. |
| `perf-simd` | SIMD, auto-vectorization, intrinsics, and runtime dispatch. |
| `perf-threading` | Pinning, topology-aware concurrency, and jitter reduction. |
| `perf-zero-alloc` | Eliminating allocations in hot paths. |

#### UI / Domain

| Skill | Brief | Arguments |
|---|---|---|
| `iced-rs` | Iced 0.14 patterns, reactive UI rules, and Elm-style structure. | — |
| `iced-shadcn` | shadcn Base UI component planning, family decomposition, and parity audits for Iced. | — |
| `price-handling` | Price rounding, epsilon comparison, and market-price handling. | — |
| `trading-design` | Dense, professional trading-style interface design guidance. | — |

#### Workflow / Platform

| Skill | Brief | Arguments |
|---|---|---|
| `decider*` | Architectural decision document management and indexing. | — |
| `github*` | GitHub PR, thread, review, CI, and merge workflows. | — |
| `issue-lifecycle*` | Delegated implementation/review/QA issue workflows. | — |
| `linear*` | Linear issue, cycle, milestone, and project workflows with fully custom API scripts. | — |
| `flightdeck*` | Master session lifecycle for multi-issue parallel dev work: dashboard, spawn, oversee tmux panes, plan merges. Tmux-only. | <ul><li><code>/flightdeck start [ISSUE_ID]</code></li><li><code>/flightdeck start new [title]</code></li><li><code>/flightdeck start self</code></li><li><code>/flightdeck parallel-check [ISSUE_IDS|"Project Name"]</code></li><li><code>/flightdeck watch [ISSUE_IDS]</code></li><li><code>/flightdeck status</code></li></ul> |
| `orchestration*` | Per-issue inside-worktree lifecycle: dev → review → submit → merge. Loaded by per-issue agents in spawned panes. | <ul><li><code>/orchestration start [ISSUE_ID]</code> (from worktree only — from main, use <code>/flightdeck start</code>)</li><li><code>/orchestration initialize [ISSUE_ID]</code></li><li><code>/orchestration dev-start [ISSUE_ID]</code></li><li><code>/orchestration dev-fix [ISSUE_ID]</code></li><li><code>/orchestration ci-fix &lt;PR_NUMBER|queue&gt;</code></li><li><code>/orchestration review-pr [PR_NUMBER]</code></li><li><code>/orchestration review-pr-comments &lt;PR_NUMBER|BRANCH&gt;</code></li><li><code>/orchestration submit-pr [PR_NUMBER]</code></li><li><code>/orchestration merge-pr &lt;PR_NUMBER|all&gt;</code></li><li><code>/orchestration post-summary [ISSUE_ID]</code></li></ul> |
| `project-management*` | TPM-orchestrated planning, audit, roadmap, research-driven decomposition. | <ul><li><code>/project-management cycle-plan</code></li><li><code>/project-management audit-issues &lt;project | project "Name" | issue [IDs] | --issues [file]&gt;</code></li><li><code>/project-management roadmap plan [feature] [@research-path]</code></li><li><code>/project-management roadmap create @plan-file</code></li><li><code>/project-management research-spike</code></li><li><code>/project-management research-complete [ISSUE_ID]</code></li></ul> |
| `second-opinion` | Cross-model review via external AI CLI — auto-detects harness and calls the opposite (Claude ↔ Codex). | <ul><li><code>/second-opinion review [--range &lt;base..head&gt;]</code></li><li><code>/second-opinion challenge &lt;description&gt;</code></li><li><code>/second-opinion audit &lt;path&gt;</code></li><li><code>/second-opinion quick &lt;question&gt;</code></li></ul> |
| `worktree*` | Git worktree creation, env/config linkage, and isolated workflows. | <ul><li><code>/worktree create &lt;ID&gt; [--base &lt;branch&gt;] [--from &lt;ref&gt;] [--pr &lt;N&gt;]</code></li><li><code>/worktree list</code></li><li><code>/worktree remove &lt;ID|path&gt;</code></li><li><code>/worktree cleanup</code></li><li><code>/worktree path &lt;ID&gt;</code></li><li><code>/worktree exists &lt;ID&gt;</code></li><li><code>/worktree check</code></li><li><code>/worktree push [ID|/path] [--set-upstream|-u] [--no-rebase]</code></li></ul> |

`*` Requires project-local setup before first use, such as `.env.local`, decision directories, or command aliases. Check that skill's `README.md` for the exact bootstrap steps.

### Hooks

| Hook | Event | Brief |
|---|---|---|
| `block-bare-cd` | `PreToolUse` | Blocks unsafe bare `cd` usage and nudges toward subshell-safe patterns. |
| `pre-commit-check` | `PreToolUse` | Validates formatting and lint before commits. |
| `post-edit-lint` | `PostToolUse` | Runs lint checks after source edits. |
| `task-completed-check` | `TaskCompleted` | Runs final lint checks before marking work complete. |

### Pi Extensions

All vstack Pi packages declare `vstack.extensionManager.settings` metadata, including an `enabled` feature toggle. Install `pi-extension-manager` to browse inventory, toggle resources, and edit those settings from Pi.

#### `pi-extension-manager`

- **Purpose:** Pi-styled extension inventory, full settings shell, and quick inline settings editor.
- **Commands:** `/extensions` for the full popup and `/extensions settings` for quick inline edits.
- **Notes:** Pi has no public native API for third-party `/settings` tabs or live module unloads; package/module toggles apply after `/reload` or restart.
- **More:** [pi-extensions/pi-extension-manager/README.md](pi-extensions/pi-extension-manager/README.md).

#### `pi-skills-manager`

- **Purpose:** Dedicated `/skills` shell for browsing, previewing, inserting, creating, editing, renaming, deleting, and enabling/disabling Pi skills.
- **Behavior:** hides native `/skill:*` commands and the startup `[Skills]` block by default, then expands inserted `[skill] <name>` markers into full skill content before prompts are sent.
- **Settings:** native command/startup hiding, AI generation toggle, default create location, marker cleanup, popup dimensions, visible list rows.
- **More:** [pi-extensions/pi-skills-manager/README.md](pi-extensions/pi-skills-manager/README.md).

#### `pi-background-tasks`

- **Purpose:** Adds explicit non-blocking shell task management to Pi so long-running commands do not block the current turn.
- **Tools:** `bg_task` for spawn/list/log/stop/clear; `bg_status` compatibility tool for PID-based status/log/stop.
- **Commands:** `/bg`, `/bg run <cmd>`, `/bg list`, `/bg log <id>`, `/bg watch <id>`, `/bg stop <id>`, `/bg clear`.
- **UI:** configurable dashboard shortcut opens a task overlay; a compact task widget appears while tasks are tracked.
- **Settings:** timeout, output caps, wakeup tail size, widget placement, dashboard shortcut, log directory.
- **More:** [pi-extensions/pi-background-tasks/README.md](pi-extensions/pi-background-tasks/README.md).

#### `pi-questions`

- **Purpose:** Structured multi-tab popup questions for the model and bridge-driven replies.
- **Tools/commands:** `question` tool.
- **Settings:** popup dimensions, visible option rows, default header, bridge reply enablement; large free-form answers are truncated with temp-file preservation.
- **More:** [pi-extensions/pi-questions/README.md](pi-extensions/pi-questions/README.md).

#### `pi-session-bridge`

- **Purpose:** Keeps the normal interactive Pi TUI visible while exposing a Unix-socket JSONL side channel for external control and event streaming.
- **Enables:** send prompts, steer/follow-up, abort, inspect state/history, subscribe to live events, and answer pending `pi-questions` prompts.
- **CLI:** `pi-bridge` for list/state/commands/stream/send/steer/follow-up/history/emit.
- **Settings:** bridge dir, history limit, line cap, heartbeat, status badge, startup notifications.
- **More:** [pi-extensions/session-bridge/README.md](pi-extensions/session-bridge/README.md).

#### `pi-subagents-tmux`

- **Purpose:** Delegates work to `.pi/agents`, `.claude/agents`, and user agents with isolated Pi context; supports persistent tmux panes.
- **Tools/commands:** `subagent`, `get_subagent_result`, `steer_subagent`, `/agents`.
- **Behavior:** persistent pane tasks keep a durable task registry; `steer_subagent` only sends through `pi-session-bridge` when it can target the exact child pane session file, otherwise it queues an explicit inbox fallback rather than matching by cwd.
- **Settings:** parallel task limit, concurrency, collapsed result size, result truncation/full-output preservation, pane polling intervals, forced session-bridge loading for panes.
- **More:** [pi-extensions/pi-subagents-tmux/README.md](pi-extensions/pi-subagents-tmux/README.md).

#### `pi-statusline`

- **Purpose:** Replaces Pi's default footer/editor chrome with a compact Claude-style status line and `π` prompt.
- **Shows:** repo/project, branch with worktree dirty state, model, thinking level, context window size, remaining context percent.
- **Settings:** enablement, footer replacement, compact prompt, input padding, git refresh timeout, dirty marker.
- **More:** [pi-extensions/pi-statusline/README.md](pi-extensions/pi-statusline/README.md).

#### `pi-prompt-stash`

- **Purpose:** Per-session prompt stash history with a stash/pop editor workflow.
- **Commands/UI:** `/prompt-stash`; configurable stash shortcut (`Alt+S` by default).
- **Settings:** store file, shortcut, popup dimensions, visible rows, deduplication.
- **More:** [pi-extensions/pi-prompt-stash/README.md](pi-extensions/pi-prompt-stash/README.md).

#### `pi-qol`

- **Purpose:** Reliable multiline input, styled image placeholder chips, manual/auto session naming, session search/context import, handoff, permission prompts, terminal/tmux notifications, custom compaction, and collapsed-thinking timer.
- **Commands:** `/qol status`, `/qol rename`, `/qol rename status`, `/qol rename full`, `/qol notify-test`, `/qol attachments`, `/qol collapse`, `/qol reset`, `/session-name`, `/search`, `/handoff`.
- **Settings:** Shift+Enter handling, fallback newline key, image chips/status, auto session rename, session search/import, handoff, permission gate, notification triggers/channels, custom/remote/idle compaction, branch summary override, thinking timer.
- **More:** [pi-extensions/pi-qol/README.md](pi-extensions/pi-qol/README.md).

#### `pi-session-manager`

- **Purpose:** Polished Pi session browser for searching, threaded lineage review, resuming, renaming, and safely deleting sessions.
- **Commands/UI:** `/sessions [current|all]`; configurable idle shortcut (`Ctrl+Shift+R` by default).
- **Settings:** enablement, shortcut, default scope/sort, overlay width, visible rows, named-session status badge, trash-before-unlink deletion.
- **More:** [pi-extensions/pi-session-manager/README.md](pi-extensions/pi-session-manager/README.md).

#### `pi-output-policy`

- **Purpose:** OMP-style large-output policy: shell minimization, head/tail truncation, spill-file preservation, UI-safe caps.
- **Settings:** spill threshold, inline tail budgets, UI safety caps, full-output preservation, shell minimizer controls.
- **More:** [pi-extensions/pi-output-policy/README.md](pi-extensions/pi-output-policy/README.md).

#### `pi-tool-renderer`

- **Purpose:** Compact Claude/opencode-style built-in tool renderers while preserving original tool execution.
- **Behavior:** individual `read`/`bash`/search calls render as compact bullet rows with no padded box; mutation tools show stats and bounded expanded previews via Pi's normal `Ctrl+O` model; `tool_batch` is preferred for independent read/search/list/diagnostic bash calls as one compact renderable unit.
- **Settings:** read/search/bash/MCP output modes, mutation renderer toggles, diff preview budgets, batch tool toggle/limit, global tool chrome, working indicator, renderer safety caps.
- **More:** [pi-extensions/pi-tool-renderer/README.md](pi-extensions/pi-tool-renderer/README.md).

#### `pi-task-panel`

- **Purpose:** Persistent structured task panel above the status line/editor plus `/tasks` commands and `tasks_write` tool.
- **Settings:** default panel state, Ctrl+T takeover opt-in, Alt+T tri-state toggle, compact count, auto-show/hide, compact tool output, sequential task updates, model-facing workflow context/reminders.
- **More:** [pi-extensions/pi-task-panel/README.md](pi-extensions/pi-task-panel/README.md).

#### `pi-caveman`

- **Purpose:** Native Pi caveman communication mode via `before_agent_start` prompt injection.
- **Commands:** `/caveman [lite|full|ultra|micro|toggle|off|status]`.
- **Settings:** enable/default mode, status badge, clarity escape, session override, code/commit/review boundaries.
- **More:** [pi-extensions/pi-caveman/README.md](pi-extensions/pi-caveman/README.md).

See also: [Pi extension settings audit](docs/pi-extension-settings-audit.md).

Source layout:

```text
pi-extensions/
└─ <name>/
   ├─ package.json        npm-shaped, with `pi.extensions` and optional `bin`
   ├─ extensions/*.ts     loaded by Pi via the `pi.extensions` manifest
   ├─ bin/*               optional CLI scripts
   ├─ README.md
   └─ THIRD_PARTY_NOTICES.md  optional attribution for vendored/base code
```

Authoring a new Pi extension package: write a `package.json` with `keywords: ["pi-package"]`, `pi.extensions`, and any `bin` scripts. vstack will pick it up automatically the next time you run `vstack add` against a source repo containing it.

Updates: edit files under `pi-extensions/<name>/` in the vstack repo, then run `vstack refresh` (or `vstack add` again) — installed Pi scopes pick up the change. Users never edit the deployed copy directly.

#### Settings layout

vstack writes Pi's `packages` array using the relative form Pi resolves against the settings file directory:

```json
{
  "packages": [
    "./packages/pi-session-bridge",
    "./packages/pi-statusline"
  ]
}
```

| Scope | Settings file | Packages directory |
|---|---|---|
| Global | `~/.pi/agent/settings.json` | `~/.pi/agent/packages/<name>/` |
| Project | `.pi/settings.json` | `.pi/packages/<name>/` |

Other entries in `settings.json` are preserved across installs and refreshes; vstack only mutates the `packages` array, dedupes the entries it owns, and writes the file back. A legacy absolute-path entry (from earlier vstack versions) is replaced with the canonical relative form on the next `vstack add`/`refresh`.

The `pi-extension-manager` package stores its own disabled lists and extension setting values under `vstack.extensionManager` in Pi settings. That namespace is intentionally separate from Pi's top-level `extensions` resource-path setting.

## License

MIT
