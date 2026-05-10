# vstack

Cross-harness distribution system for AI coding skills, agents, hooks, and Pi extensions. Installs into Claude Code, Cursor, OpenCode, Codex, and Pi via a Rust CLI.

## Repo Layout

```
cli/src/
├── main.rs              CLI entry; routes to commands/
├── commands/            add, remove, list, check, update, update_pi, verify, refresh, init
├── pi_extension.rs      Pi extension discovery, install/remove, settings.json merge
├── config.rs            Lock file (JSON), project root detection, staleness/mtime helpers
├── scope.rs             Scope enum (project | global | all); uniform `--scope`/`-g` parsing
├── mapping.rs           Source vstack.toml — MappingConfig (agent-skills, role-skills, hook-events)
├── project_config.rs    Project vstack.toml — ProjectConfig, ensure/write/update
├── resolve.rs           Shared helpers — skill-pair resolution, read_existing_extras, is_vstack_source
├── installer.rs         Symlink/copy logic, per-harness hook installation, removal
├── harness/             (canonical → per-harness translation)
│   ├── claude.rs        → .claude/agents/*.md (disallowedTools, effort/background/isolation/memory, skills, hooks frontmatter)
│   ├── cursor.rs        → .cursor/rules/*.mdc (description + alwaysApply + skills)
│   ├── opencode.rs      → .opencode/agents/*.md (YAML frontmatter + skills)
│   ├── codex.rs         → .codex/agents/*.toml (developer_instructions + skills)
│   └── pi.rs            → .pi/agents/*.md (name, description, deny-tools, model, pane)
└── tui/                 Install wizard: install_flow, state, summary, multiselect, render

(agent.rs, skill.rs, hook.rs, frontmatter.rs are simple parsers — names match their job.)

vstack.toml              Skill/hook-to-agent mapping (read at install)
agents/                  Canonical agents — `role` field drives per-harness access control
skills/                  Skill packages — each has SKILL.md with optional dependencies
hooks/                   Safety hooks — bash scripts with YAML comment headers
pi-extensions/           Pi extension packages (npm-shaped). package.json has `pi.extensions`
skill-templates/         Templates for new skills
```

## Key Design Decisions

- **Discovered dynamically.** CLI scans `agents/`, `skills/`, `hooks/`, `pi-extensions/` at runtime. No hardcoded lists.
- **Canonical source is harness-agnostic.** Translation happens in `cli/src/harness/`.
- **Agent `role` drives access control.** `analyst` → planning/research/recon artifacts. `reviewer` → report-only/subagent (may write reports, not product code). `engineer` → full access/primary. `manager` → analysis/report artifacts.
- **Skill dependencies use frontmatter.** `dependencies: { required: [...], optional: [...] }` in SKILL.md.
- **Hooks diverge by harness.** Claude Code: native shell hooks + settings.json + agent frontmatter. Cursor: safety `.mdc` rules. OpenCode: `.opencode/agents/*.md` + instructions. Codex: inline prose in `developer_instructions`. Pi has no native hook runtime — safety prose appended to agent body.
- **Pi extensions are npm-shaped.** vstack copies them to `<scope>/packages/<name>` and registers the path in Pi's `settings.json` `packages` array.
- **Skill/hook attribution is config-driven.** Source `vstack.toml` `[agent-skills]` is authoritative — explicit entries skip prefix matching. `[role-skills]` adds skills to all agents of a role. Project `vstack.toml` also has `[agent-skills]` populated at install; users add/remove and refresh. Agents get `skills:` frontmatter and a "Required Skills" body section.
- **Reconciliation is automatic.** After every `vstack add`, all installed agents are regenerated with the current full set of installed skills and hooks.
- **Project root walks up from CWD.** `config::project_root()` finds `.vstack-lock.json`, `.claude/`, `.cursor/`, `.codex/`, `.opencode/`, `.pi/`, or `.agents/` by walking parents. `$HOME` is rejected as a project root when only user-level harness dirs (`~/.claude`, `~/.pi`, etc.) exist there with no `.vstack-lock.json`, so project-scope writes never accidentally route into user state. `$HOME` is rejected as a project root when only user-level harness dirs (`~/.claude`, `~/.pi`, etc.) exist there with no `.vstack-lock.json`, so project-scope writes never accidentally route into user state.

## Formats

### Agent frontmatter (`agents/*.md`)
```yaml
name: rust
description: ...
model: opus          # opus | sonnet | haiku
role: engineer       # engineer | analyst | reviewer | manager
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
Npm-shaped manifest. vstack discovers any subdir containing `package.json`. Packages publish under `@vanillagreen/`; unscoped names work as `--pi-extension <name>` filters via the rename table.
```json
{
  "name": "@vanillagreen/pi-qol",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/qol.ts"], "appendSystem": "./instructions.md" },
  "bin": { "pi-bridge": "./bin/pi-bridge.js" },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  }
}
```
On install vstack copies `pi-extensions/<name>/` into `<scope>/packages/<name>` and adds `./packages/<name>` to Pi's `settings.json` `packages` array. Existing entries and other settings keys are preserved; legacy absolute-path entries are replaced with the relative form. The catalog of currently-shipped extensions lives in [README.md](README.md#pi-extensions) — don't duplicate it here.

### Mapping config (`vstack.toml`)
```toml
[agent-skills]
rust = ["rust-arch", "rust-async", "rust-cargo", ...]
iced = ["iced-rs", "iced-shadcn", ...]

[role-skills]
analyst = ["linear", "github"]
engineer = ["issue-lifecycle", "github", "worktree", "decider", "linear"]
reviewer = ["issue-lifecycle", "linear"]

[hook-events]
"PreToolUse:Bash" = "all"
"PostToolUse:Edit|Write" = ["engineer"]
"PostCompact:" = "all"
```

### Project customization (`vstack.toml` at project root)

Per-agent customization survives `vstack add` — re-applied on every install/reconciliation.

```toml
# Skills loaded into each agent's context.
[agent-skills]
rust = ["rust-arch", "rust-cargo"]

# Specialist skills loaded on demand with "when to load" hints.
[agent-skills-optional]
rust = [{ skill = "rust-async", when = "Async, tokio, channels" }]

# Launch instructions added near the top of generated agent files.
[agent-launch-instructions]
rust = "Read docs/architecture.md before coding."

# Project guidance appended to generated agent files.
[agent-additional-instructions]
rust = "Always run clippy before committing."

# Generated frontmatter. vstack populates active defaults; edit and refresh.
[agent-frontmatter]
rust = { color = "orange", model = "opus", effort = "xhigh", deny-tools = ["subagent", "question"] }

# Harness-specific overrides win over top-level entries.
[agent-frontmatter.claude]
rust = { background = false }

[agent-frontmatter.opencode]
rust = { mode = "subagent" }

[agent-frontmatter.codex]
rust = { sandbox-mode = "danger-full-access" }

[agent-frontmatter.pi]
rust = { deny-tools = ["get_subagent_result", "steer_subagent", "stop_subagent"], pane = true }

# Project instructions prepended to a skill's SKILL.md.
[skill-instructions]
trading-design = "Dark theme, green/red accents."
```

## Per-Harness Model/Effort Mapping

| Canonical | Claude Code | Claude effort | OpenCode | Codex | Pi |
|-----------|-------------|---------------|----------|-------|-----|
| `opus` | `opus[1m]` | `max` | `openai/gpt-5.5` | `gpt-5.5` (xhigh) | `openai-codex/gpt-5.5:xhigh` |
| `sonnet` | `sonnet` | `high` | `openai/gpt-5.5` | `gpt-5.5` (high) | `openai-codex/gpt-5.5:high` |
| `haiku` | `haiku` | `medium` | `openai/gpt-5.5` | `gpt-5.5` (medium) | `openai-codex/gpt-5.5:medium` |

## Per-Harness Tool Overrides

- Prefer `deny-tools`. Claude Code writes it as native `disallowedTools`, derives `background` from Pi `pane` (`pane = true` → `background = false`, `pane = false` → `background = true`), omits `isolation`/`memory` unless configured, and maps `xhigh` effort to Claude `max`. OpenAI-style harnesses (OpenCode, Codex, Pi) map `max` effort back to `xhigh`. Pi emits `deny-tools` for `pi-agents-tmux` (default = active parent tools minus denials). OpenCode defaults generated agents to `mode: subagent`, still exposes `mode` for rare primary-agent overrides, emits `permission: <tool>: deny` entries from the same deny list, maps `color` to hex values, and writes reasoning under `options.reasoningEffort` with summary/verbosity defaults.
- Cursor and Codex don't use the same per-agent tool-deny frontmatter; Codex subagents use sandbox/approval configuration instead.

## Rules

- **No project-specific references.** Zero mentions of specific apps, crate names, paths, or tools in `agents/`, `skills/`, `hooks/`.
- **Validate ctx7 IDs.** Every library ID in SKILL.md ctx7 tables must resolve via `npx ctx7@latest docs <id> "test"`.
- **Test after CLI changes.** `cd cli && cargo test`. Integration: `cargo run -- add .. --all --copy` into a temp dir.
- **Hooks must be portable.** No hardcoded paths.
- **Child workflows return JSON to parent.** Subagent workflows output JSON in `<output_format>` tags; the calling primary agent writes files.
- **Keep CLI version and GitHub release tag in sync.** `cli/Cargo.toml` version and the GitHub release/tag must always match. Don't bump or release without explicit ask.
- **`vstack add` scope is destructive — read the printed summary.** Every non-interactive run prints `Scope: PROJECT (...)` vs `GLOBAL (...)`, method, and every item written. Confirm both before claiming success.
- **Never `--global` without an item filter.** CLI refuses `--global -y` unless `--all` or one of `--agent`/`--skill`/`--hook`/`--pi-extension` is set. Item filters are exclusive — passing any restricts the install to only those kinds.
- **Scope flag is uniform.** `list`, `check`, `refresh`, `remove` accept `--scope project|global|all`. `-g`/`--global` = `--scope global`. Default: `all` for read-only (`list`, `check`, `refresh`), `project` for `remove`. `vstack refresh` with no args reinstalls items at every scope they're locked at.
- **Verify after refresh.** `vstack refresh -v` prints per-item `old→new` hash. `vstack verify [-g] [name…]` confirms source matches lock and byte-matches install dir for Pi packages. Use both before claiming a change is live.
- **Docs and instruction payloads ship with the code change.** Any change to a hook, skill, agent, or Pi extension must update — in the same commit — affected READMEs, AGENTS.md, `vstack.toml`, `.env.local.example`, `package.json`, agent instruction payloads (`appendSystem` files / before_agent_start hook prose), and any cross-referencing docs. A behavior change without its docs/instructions update is incomplete.
- **Edit skills directly.** Edit `skills/<name>/SKILL.md` in place. No separate `rules/` directories or per-skill `AGENTS.md` files.

## Updating Pi Extensions

`vstack update-pi[ --check][ --scope global|project]` reinstalls only stale Pi packages. Source of truth: `<scope>/.vstack-source.json` plus `npm:` entries in Pi `settings.json`. Installed versions compare against `pi-extensions/<name>/package.json` (vstack repos) or `npm view <name> version` (npm). Different packages can come from different vstack repos — grouped by `(scope, sourceRepo)` and reinstalled independently. Stale index entries (referenced package no longer installed) are dropped. The pi-extension-manager extension reads the same index for its `↑ X.Y.Z` badge.

## Pi APPEND_SYSTEM.md load order

Pi core auto-discovers exactly one `APPEND_SYSTEM.md`: `<cwd>/.pi/APPEND_SYSTEM.md` first, falling back to `~/.pi/agent/APPEND_SYSTEM.md` only if the project file is missing. Not concatenated by core. Claude bridge can opt into forwarding both with `includeAppendSystemPromptMd`.

## Pi Extension UI Rules

- Inspect multiple `pi-extensions/*` packages first; match existing patterns.
- Popups: title in top border (`\x1b[32m`); tabs then blank line; search = full-width `toolPendingBg` row, `> [cursor]`, no hint; footer owns key hints (`\x1b[33m`); active rows `selectedBg`+text; matches `\x1b[31m`; no decorative cursors.
- Tool rendering: compact one-line calls; bold label, accent target, muted metadata; tree children; success/error/warning status colors; raw output/diffs only when useful or expanded.
- Persistent banners below status: framed, compact counts in header, tree rows, active first, muted hints, collapse/clear when empty.

## Pi Extension Development Workflow

For any `pi-extensions/**` or Pi package behavior change:
1. **Validate before finishing.** Confirm new code is reachable from where it's invoked. Cross-extension calls: `pi.getCommands()` is metadata only; bridge via `globalThis[Symbol.for("vstack.pi.<topic>")]` (see modal-lock, thinking-timer, question-service). If you can't live-test in Pi, say so.
2. **Commit intended Pi package changes** unless user says not to. Stage only intended files; mention unrelated dirty files. If signing fails, retry with `--no-gpg-sign`.
3. **After commit, run `vstack refresh -g`** so the global Pi install picks up committed source state. Refresh after commit, not before. Report commit hash and refresh result.
4. **Don't claim done/fixed/committed/ready until commit + refresh are complete.** If skipped, say so and why.

Worktree/feature branch dev: test via local project Pi settings for that checkout; don't add vstack repo sources pointing at temp/worktree paths.

### Pi slash-command expansion

- `sendUserMessage` and `pi-bridge send` skip slash/skill expansion (`expandPromptTemplates: false`). Only the interactive editor and the `pi` CLI initial-prompt arg expand `/skill:foo`.
- From an extension, use `ctx.ui.pasteToEditor("/skill:foo\n")` (user submits). No public API auto-submits.

## Build & Test

```bash
cd cli && cargo build                    # build
cd cli && cargo test                     # unit + integration tests
cd cli && cargo run -- add .. --all -y   # integration test against this repo
```

## Publishing & Releases

The agent does not auto-publish or auto-release. When the user asks:
- npm publishing of Pi extension packages → `.pi/prompts/npm-deploy.md`
- vstack CLI version bump + GitHub release → `.pi/prompts/gh-release.md`
