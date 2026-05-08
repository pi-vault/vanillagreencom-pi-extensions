# vstack

Cross-harness distribution system for AI coding skills, agents, hooks, and Pi extensions. Installs into Claude Code, Cursor, OpenCode, Codex, and Pi via a Rust CLI.

## Repo Layout

```
cli/src/
├── main.rs              CLI entry, clap definition, routes to commands/
├── commands/
│   ├── add.rs           Install wizard (TUI or --yes), reconciliation
│   ├── remove.rs        Uninstall skills/agents, cleanup
│   ├── list.rs          Show installed skills and agents
│   ├── check.rs         Validate installation status
│   ├── update.rs        Self-update to latest release
│   ├── update_pi.rs     Update Pi packages by version (npm or vstack repos), grouped by (scope, sourceRepo)
│   ├── verify.rs        Lock-vs-source hash check + byte-level Pi-package source-vs-install drift detection
│   ├── refresh.rs       Reinstall locked items from source (agents, skills, hooks, Pi packages); re-applies vstack.toml
│   └── init.rs          Scaffold new skill/agent template
├── agent.rs             Agent parsing, skill/hook matching heuristics
├── skill.rs             Skill parsing, frontmatter dependency resolution, dep reference injection
├── hook.rs              Hook parsing (YAML-in-comments frontmatter from .sh files)
├── pi_extension.rs      Pi extension package discovery, install/remove, settings.json merge
├── frontmatter.rs       YAML frontmatter splitting/parsing
├── config.rs            Lock file (JSON), project root detection, staleness/mtime helpers
├── scope.rs             Scope enum (project | global | all) and uniform `--scope`/`-g` parsing for scope-aware commands
├── mapping.rs           Source vstack.toml loader — MappingConfig (agent-skills, role-skills, hook-events)
├── project_config.rs    Project vstack.toml — ProjectConfig, ensure/write/update, TOML template
├── resolve.rs           Shared helpers — skill-pair resolution, read_existing_extras, is_vstack_source
├── installer.rs         Symlink/copy logic, per-harness hook installation, removal
├── harness/
│   ├── mod.rs           Harness enum, detection, routing
│   ├── claude.rs        → .claude/agents/*.md (skills + hooks frontmatter, "Required Skills")
│   ├── cursor.rs        → .cursor/rules/*.mdc (description + alwaysApply + skills section)
│   ├── opencode.rs      → .opencode/agents/*.md (YAML frontmatter + skills section)
│   ├── codex.rs         → .codex/agents/*.toml (developer_instructions + skills section)
│   └── pi.rs            → .pi/agents/*.md (Pi frontmatter: name, description, tools, model, pane)
└── tui/
    ├── mod.rs           Re-exports and shared types (DiscoveredItems incl. pi_extensions)
    ├── install_flow.rs  Install wizard, event loop, inline update, tab mutation
    ├── state.rs         Installed state, staleness detection, tab building (incl. Pi Packages tab)
    ├── summary.rs       Post-install summary screen
    ├── multiselect.rs   Selection state, scroll, toggle, confirm dialog
    └── render.rs        Ratatui rendering (header, list, status, help bar, dialog overlay)

vstack.toml              Skill/hook-to-agent mapping config (read by CLI at install time)
agents/                  Canonical agents — `role` field drives per-harness access control
skills/                  Skill packages — each has SKILL.md with optional dependencies
hooks/                   Safety hooks — bash scripts with YAML comment headers
pi-extensions/           Pi extension packages (npm-shaped). Each package has package.json with `pi.extensions`.
skill-templates/         Templates for new skills
```

## Key Design Decisions

- **Everything is discovered dynamically.** The CLI scans `agents/`, `skills/`, `hooks/`, `pi-extensions/` at runtime. No hardcoded lists.
- **Canonical source is harness-agnostic.** Agents, skills, and hooks contain no harness-specific syntax. Translation happens in `cli/src/harness/`.
- **Agent `role` drives access control.** `reviewer` → read-only/subagent. `engineer` → full access/primary. `manager` → analysis only.
- **Skill dependencies use frontmatter.** `dependencies: { required: [...], optional: [...] }` in SKILL.md.
- **Hooks diverge by harness.** Claude Code gets native shell hooks + settings.json + agent frontmatter. Cursor gets safety `.mdc` rules. OpenCode gets `.opencode/agents/*.md` + instructions. Codex gets inline prose in `developer_instructions`. Pi has no native hook runtime — safety prose is appended to the agent body instead.
- **Pi extensions are npm-shaped packages.** vstack copies them to `~/.pi/agent/packages/<name>` (or `.pi/packages/<name>`) and registers the path in Pi's `settings.json` `packages` array.
- **Skill/hook attribution is config-driven.** Source `vstack.toml` `[agent-skills]` is authoritative — explicit entries skip prefix matching. `[role-skills]` adds skills to all agents of a role. Project `vstack.toml` also has `[agent-skills]` populated at install time; users can add/remove skills and refresh. Agents get a `skills:` frontmatter field and a "Required Skills" body section.
- **Reconciliation is automatic.** After every `vstack add`, all installed agents are regenerated with the current full set of installed skills and hooks. Adding a skill after an agent updates that agent.
- **Project root walks up from CWD.** `config::project_root()` finds `.vstack-lock.json`, `.claude/`, `.cursor/`, `.codex/`, `.opencode/`, `.pi/`, or `.agents/` by walking parent dirs — works from subdirectories.

## Formats

### Agent frontmatter (`agents/*.md`)
```yaml
name: rust
description: ...
model: opus          # opus | sonnet | haiku
role: engineer       # engineer | reviewer | manager
color: orange
```

### Skill frontmatter (`skills/*/SKILL.md`)
```yaml
name: orchestration
description: ...
license: MIT
user-invocable: true
dependencies:
  required: [linear, github, worktree]
```

### Hook header (`hooks/*.sh`)
```bash
# ---
# name: block-bare-cd
# event: PreToolUse       # PreToolUse | PostToolUse | PostCompact | TaskCompleted
# matcher: Bash           # Bash | Edit|Write | (empty for all)
# description: ...
# safety: ...
# timeout: 30             # optional, seconds
# ---
```

### Pi extension package (`pi-extensions/<name>/package.json`)
Npm-shaped manifest. vstack discovers any subdirectory containing a `package.json`. Packages in this repo are all published under the `@vanillagreen/` scope on npm; the unscoped names also work as `--pi-extension <name>` filters via the rename table.
```json
{
  "name": "@vanillagreen/pi-qol",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/qol.ts"] },
  "bin": { "pi-bridge": "./bin/pi-bridge.js" },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  }
}
```
On install vstack copies `pi-extensions/<name>/` into `<scope>/packages/<name>` and adds `./packages/<name>` to the `packages` array of Pi's `settings.json` (relative to the settings file dir). Existing entries and other settings keys are preserved; legacy absolute-path entries are replaced with the relative form. The catalog of currently shipped extensions and their purpose lives in [README.md](README.md#pi-extensions) — don't duplicate it here.

### Mapping config (`vstack.toml`)
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
"PostCompact:" = "all"
```

### Project customization (`vstack.toml` at project root)

Per-agent customization sections survive `vstack add` — re-applied on every install/reconciliation.

```toml
# Skills loaded into each agent's context.
[agent-skills]
rust = ["rust-arch", "rust-cargo"]

# Specialist skills loaded on demand with "when to load" hints.
[agent-skills-optional]
rust = [{ skill = "rust-async", when = "Async, tokio, channels" }]

# Generated-frontmatter overrides. Top-level entries apply to every harness.
[agent-frontmatter]
rust = { color = "green" }

# Harness-specific generated-frontmatter overrides win over top-level entries.
# Use exact model/tool ids for the target harness.
[agent-frontmatter.pi]
researcher = { model = "openai/gpt-5.5:xhigh", tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "web_research"] }

# What the agent should do when first invoked.
[agent-launch-instructions]
rust = "Pick up the highest-priority backend issue."

# Project guidance appended to the agent file.
[agent-additional-instructions]
rust = "Always run clippy before committing."

# Project instructions prepended to a skill's SKILL.md.
[skill-instructions]
trading-design = "Dark theme, green/red accents."
```

## Per-Harness Model Mapping

| Canonical | Claude Code | OpenCode | Codex | Pi |
|-----------|-------------|----------|-------|-----|
| `opus` | `opus[1m]` | `openai/gpt-5.5` | `gpt-5.5` (xhigh) | `openai/gpt-5.5:xhigh` |
| `sonnet` | `sonnet` | `openai/gpt-5.5` | `gpt-5.5` (high) | `openai/gpt-5.5:high` |
| `haiku` | `haiku` | `openai/gpt-5.5` | `gpt-5.5` (medium) | `openai/gpt-5.5:medium` |

## Rules

- **No project-specific references.** Zero mentions of specific apps, crate names, paths, or tools in `agents/`, `skills/`, `hooks/`.
- **Validate ctx7 IDs.** Every library ID in SKILL.md ctx7 tables must resolve via `npx ctx7@latest docs <id> "test"`.
- **Test after CLI changes.** `cd cli && cargo test` for unit tests. For integration: `cargo run -- add .. --all --copy` into a temp dir.
- **Hooks must be portable.** No hardcoded paths. Scripts should work in any Rust project (or degrade gracefully).
- **Child workflows return JSON to parent.** Subagent workflows (project-management, issue-lifecycle) output JSON in `<output_format>` tags — the calling primary agent writes files.
- **Keep CLI version and GitHub release tag in sync.** `cli/Cargo.toml` version and the GitHub release/tag must always match. Do not bump the version or create releases unless explicitly asked; when asked, update both together.
- **`vstack add` scope is destructive — read the printed summary.** Every non-interactive run prints a block with `Scope:` (`PROJECT (...)` vs `GLOBAL (...)`), method, and every item written with its path. Confirm both before claiming success; wrong scope means the install affects every project on the machine.
- **Never `--global` without an item filter.** The CLI refuses `--global -y` (or `--global --harness ... -y`) unless `--all` or one of `--agent`/`--skill`/`--hook`/`--pi-extension` is set. To install one Pi package globally: `vstack add <repo> --global --pi-extension <name> --harness pi -y`. Item filters are exclusive — passing any restricts the install to only those kinds.
- **Scope flag is uniform.** `list`, `check`, `refresh`, `remove` accept `--scope project|global|all`. `-g`/`--global` stays as shorthand for `--scope global`. Default is `all` for read-only/non-destructive (`list`, `check`, `refresh`) and `project` for `remove`. `vstack refresh` (no args) reinstalls items at every scope they're locked at — the right command after editing source files.
- **Verify after refresh, don't trust the count.** `vstack refresh -v` prints per-item `old→new` hash with changed/unchanged status; `vstack verify [-g] [name…]` then confirms source matches the lock and (for Pi packages) byte-matches the install dir, exiting non-zero on drift. Use both before claiming an extension/skill/agent change is live.

## Updating Skills

Edit `skills/<name>/SKILL.md` directly. No separate `rules/` directories or per-skill `AGENTS.md` files.

## Updating Pi Extensions

`vstack update-pi[ --check][ --scope global|project]` reinstalls only stale Pi packages. Source of truth is `<scope>/.vstack-source.json` plus `npm:` entries in Pi `settings.json`; installed versions are compared against `pi-extensions/<name>/package.json` (vstack repos) or `npm view <name> version` (npm). Different packages can come from different vstack repos — grouped by `(scope, sourceRepo)` and reinstalled independently. Stale index entries (referenced package no longer installed) are dropped. The pi-extension-manager extension reads the same index for its `↑ X.Y.Z` badge.

Pi-specific UI/workflow rules (popup styling, banner conventions, refresh-after-commit) and the npm publish runbook (`@vanillagreen/<name>` packages, `op run` token flow, `--userconfig`/bypass-2FA notes) live in [.pi/APPEND_SYSTEM.md](.pi/APPEND_SYSTEM.md).

## Build & Test

```bash
cd cli && cargo build                    # build
cd cli && cargo test                     # unit + integration tests
cd cli && cargo run -- add .. --all -y   # integration test against this repo
```
