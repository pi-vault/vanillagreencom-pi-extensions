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
│   ├── refresh.rs       Regenerate agents from vstack.toml customizations
│   └── init.rs          Scaffold new skill/agent template
├── agent.rs             Agent parsing, skill/hook matching heuristics
├── skill.rs             Skill parsing, frontmatter dependency resolution, dep reference injection
├── hook.rs              Hook parsing (YAML-in-comments frontmatter from .sh files)
├── pi_extension.rs      Pi extension package discovery, install/remove, settings.json merge
├── frontmatter.rs       YAML frontmatter splitting/parsing
├── config.rs            Lock file (JSON), project root detection, staleness/mtime helpers
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
agents/                  12 canonical agents — role field drives per-harness access control
skills/                  31 skill packages — each has SKILL.md with optional dependencies
hooks/                   4 safety hooks — bash scripts with YAML comment headers
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
- **Project root walks up from CWD.** `config::project_root()` finds `.vstack-lock.json`, `.claude/`, `.cursor/`, `.codex/`, `.opencode/`, or `.agents/` by walking parent dirs — works from subdirectories.

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
Npm-shaped manifest. vstack discovers any subdirectory containing a `package.json`.
```json
{
  "name": "pi-qol",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/qol.ts"] },
  "bin": { "pi-bridge": "./bin/pi-bridge.js" },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  }
}
```
On install vstack copies `pi-extensions/<name>/` into `<scope>/packages/<name>` and adds `./packages/<name>` to the `packages` array of Pi's `settings.json` (relative to the settings file dir). Existing entries and other settings keys are preserved; legacy absolute-path entries are replaced with the relative form. Catalog packages: `pi-extension-manager` (extension inventory/settings UI), `pi-skills-manager` (dedicated `/skills` menu for browsing/creating/editing/toggling skills), `pi-background-tasks` (non-blocking background shell tasks + `/bg` dashboard + task tools), `pi-questions` (structured multi-tab popup questions + `pi-bridge` list/answer/reject integration), `pi-prompt-stash` (per-session prompt stash history + Alt+S stash/pop popup), `pi-session-bridge` (Unix-socket JSONL side channel + `pi-bridge` CLI), `pi-subagents-tmux` (delegation tool + persistent tmux subagent panes with grid layout and automatic completion pickup), `pi-qol`, `pi-output-policy`, `pi-tool-renderer`, `pi-task-panel`, and `pi-caveman`.

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

The same `vstack.toml` (or a separate one in the target project) can include per-agent customization sections. These survive `vstack add` updates — they are re-applied from config on every install/reconciliation.

```toml
# Skills always loaded into each agent's context — single source of truth.
# Populated at install time. Add your own skills or remove ones you don't want.
[agent-skills]
rust = ["rust-arch", "rust-cargo", "rust-conventions", "rust-safety"]

# Specialist skills loaded on demand — agent gets a "when to load" table.
[agent-skills-optional]
rust = [
  { skill = "rust-async", when = "Async code, tokio, futures, channels" },
  { skill = "rust-ffi", when = "FFI boundaries, C interop, bindgen" },
]

# "Launch Instructions" — what the agent should do when first invoked
[agent-launch-instructions]
rust = "Read open issues and begin working on the highest-priority backend task."

# Additional instructions appended at the bottom of the agent file
[agent-additional-instructions]
rust = """
Always run clippy before committing.
Prefer zero-copy APIs in hot paths.
"""

# Project instructions added at the top of each skill's SKILL.md
[skill-instructions]
trading-design = "Focus on dark theme with green/red accent colors for this project."
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
- **Never bump the CLI version.** The version in `cli/Cargo.toml` and the matching GitHub release tag are managed manually by the user. Do not change the version or create releases unless explicitly asked.

## Updating Skills

All skill content lives in `skills/<name>/SKILL.md` — there are no separate `rules/` directories or per-skill `AGENTS.md` files. To add or modify a rule, edit the relevant section directly in SKILL.md.

## Build & Test

```bash
cd cli && cargo build                    # build
cd cli && cargo test                     # 91 unit tests
cd cli && cargo run -- add .. --all -y   # integration test against this repo
```
