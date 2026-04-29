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

- **Cross-harness install**: Claude Code, Cursor, OpenCode, and Codex from one CLI.
- **Package source management**: switch between repos, add/remove sources from the TUI.
- **Global and project scope**: install once per user, or per project.
- **Dependency resolution**: skills declare required/optional dependencies in `SKILL.md`; required deps are auto-included transitively.
- **Config-driven attribution**: `vstack.toml` maps extra skills to agents, role-wide skills to agent roles, and hook events to roles.
- **Project customization**: per-agent guidance, instructions, custom skills, per-skill instructions, and custom hooks via project-level `vstack.toml` — survives upstream updates.
- **AGENTS.md auto-rebuild**: skills with `rules/` directories get their AGENTS.md rebuilt from individual rule files on every install and refresh. Header, footer, and table of contents are auto-generated.
- **Project rules**: add project-specific rules as `.md` files in a skill's `project-rules/` directory. They're preserved across updates and assembled into a "Project Rules" section of the skill's AGENTS.md on refresh.
- **Reconciliation**: installed agents and skills regenerate when packages change, preserving user edits.
- **`vstack refresh`**: regenerate all agent files, re-inject skill instructions, and rebuild AGENTS.md from rule files.
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

# Install specific skills to specific harnesses
vstack add vanillagreencom/vstack --skill rust-safety,perf-zero-alloc --agent claude-code -y

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

### Project Rules

Skills with a `rules/` directory get their AGENTS.md rebuilt from individual rule files on every install and refresh. To add project-specific rules without modifying the source skill:

1. Create a `project-rules/` directory inside the installed skill (e.g., `.agents/skills/rust-conventions/project-rules/`)
2. Add `.md` files following the rule template format (YAML frontmatter with title/impact + body)
3. Run `vstack refresh` — your rules appear in a "Project Rules" section of the skill's AGENTS.md

Project rules are preserved across upstream updates. They're backed up before re-copying and restored after.

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

Pi has no built-in subagent mechanism, so installed `.pi/agents/*.md` files are inert until you also install a Pi extension that loads them. The `pi-session-bridge` package shipped in this repo is unrelated to subagents — it is a TUI side-channel for external controllers.

vstack writes Pi agent frontmatter (`name`, `description`, `tools`, `model`, optional `pane: true`) and the same vstack-managed body sections (Required Skills, Hook Rules, Additional Instructions) used by other harnesses. Hooks have no native Pi runtime and are surfaced only as inline safety prose inside the agent body.

When `vstack add` writes a Pi extension, it copies the package directory into `~/.pi/agent/packages/<name>` (or `.pi/packages/<name>` for project scope) and adds the relative `./packages/<name>` entry to Pi's `settings.json` — preserving any existing entries. Pi auto-loads the package on next launch.

Local-path Pi packages do **not** automatically expose `bin` scripts on `PATH` (this is a Pi limitation, not a vstack one). To use the `pi-bridge` CLI shipped with `pi-session-bridge`, either symlink it into your `PATH`, run the script directly, or use the raw socket protocol. See [`pi-extensions/session-bridge/README.md`](pi-extensions/session-bridge/README.md).

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

| Extension | Critical functionality |
|---|---|
| `pi-background-tasks` | Non-blocking shell task management for Pi via `bg_task` and `/bg`; tracks logs and can notify on task exit or matching output. |
| `prompt-stash` | Project-local prompt stash history for Pi; `Ctrl+S` stashes editor text or opens a searchable pop/delete popup when empty. |
| `pi-session-bridge` | Unix-socket JSONL side channel for active Pi sessions: send prompts, steer/follow-up, abort, inspect state/history, and stream events. |
| `pi-statusline` | Compact interactive Pi TUI status line showing project/git/model/context information. |

vstack installs selected Pi extension packages into `<scope>/packages/<name>` and registers `./packages/<name>` in Pi's `settings.json`. Detailed usage lives in each package's `pi-extensions/<name>/README.md`.

## License

MIT
