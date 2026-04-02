---
name: decider
description: "Architectural decision document management: templates, creation, search, supersession tracking, and INDEX maintenance."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Decider

> **Note**: `README.md` in this directory is for human setup/configuration only — not for AI agents. Follow this file (`SKILL.md`) as the authoritative skill definition.

Architectural decision document management with canonical templates, creation/update workflows, and a search CLI. Provides the single source of truth for decision entry format and lifecycle.

## When to Apply

Reference these guidelines when:
- Creating a new decision entry after research completion
- Recording a significant path choice during implementation
- Searching for existing decisions governing an area of code
- Checking if a proposed change contradicts an active decision
- Superseding or partially superseding an existing decision
- Including decision context in PR bodies or delegation prompts
- Validating decision references in issue descriptions

## Skill Dependencies

This skill is self-contained. Other skills depend on it:

| Dependent Skill | Purpose |
|-----------------|---------|
| Orchestration | Decision creation in research-complete, search in review/submit workflows |
| Issue Lifecycle | Decision search in dev-implement/dev-fix/qa-review, creation in dev-implement |
| Project Management | Decision search in audit/roadmap workflows |

Project-level configuration:

| Variable | Purpose | Default |
|----------|---------|---------|
| `$DECISIONS_DIR` | Path to decision documents directory | Auto-discovers `docs/decisions/`, `decisions/`, `doc/decisions/`, or `adr/` with `INDEX.md` |

## Templates

| Template | Purpose |
|----------|---------|
| `templates/decision-entry.md` | Decision file format (minimal, standard, comprehensive) |
| `templates/index-row.md` | INDEX.md table row format |

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/create-decision.md` | Research complete, significant path choice | Assign ID, write file, add INDEX row, update superseded |
| `workflows/update-decision.md` | New decision affects existing | Supersede, partial supersede, or revisit existing entries |
| `workflows/search-decisions.md` | Before implementing, reviewing, auditing | Search by issue, keywords, or ID |

## Schemas

| Schema | Purpose |
|--------|---------|
| `schemas/decision-format.md` | Canonical format constraints for decision documents and INDEX |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/decisions` | CLI entry point for `.agents/skills/decider/scripts/decisions` — search, next-id, get |

## CLI Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `.agents/skills/decider/scripts/decisions search --issue [ID]` | Find decisions linked to an issue | JSON `[{id, decision, path}]` |
| `.agents/skills/decider/scripts/decisions search "[KEYWORDS]"` | Ranked keyword search (AND, scored) | JSON `[{id, decision, path, score}]` |
| `.agents/skills/decider/scripts/decisions search "a\|b"` | Regex OR search | JSON `[{id, decision, path}]` |
| `.agents/skills/decider/scripts/decisions list` | List all active decisions | JSON `[{id, decision, path}]` |
| `.agents/skills/decider/scripts/decisions next-id` | Get next available DXXX | Single `DXXX` line |
| `.agents/skills/decider/scripts/decisions get [DXXX]` | Get decision details | JSON `{id, decision, status, date, path}` |

Options: `--limit N` (default: 5) for search results.

## Decision Lifecycle

```
Research Complete → Create Decision (§ 6.1)
                        ↓
                 INDEX.md + DXXX-descriptor.md
                        ↓
            ┌───────────┴───────────┐
            ↓                       ↓
    Search/Reference         Update/Supersede
    (review, audit,          (new research,
     implementation)          revisit conditions met)
```

## Quick Reference

### Creating Decisions

1. Get next ID: `.agents/skills/decider/scripts/decisions next-id`
2. Select template size (minimal/standard/comprehensive) from `templates/decision-entry.md`
3. Write decision file to `[project decision documents]/[DECISION_ID]-[DESCRIPTOR].md`
4. Add row to `[project decision documents]/INDEX.md`
5. Update any partially superseded decisions

### Searching Decisions

1. By issue: `.agents/skills/decider/scripts/decisions search --issue [ISSUE_ID]`
2. By keywords: `.agents/skills/decider/scripts/decisions search "[RELEVANT_KEYWORDS]"`
3. Read full decision files — index summaries are insufficient for understanding scope and rejected alternatives
4. Suggestions contradicting active decisions are invalid unless decision is flawed

### Decision Entry Format

All entries require: title (`# DXXX: Title`), date, status, research ref (or `—`), decision statement, rationale, revisit conditions. See `schemas/decision-format.md` for full constraints.

## Configuration

| Variable | Purpose | Required |
|----------|---------|----------|
| `DECISIONS_DIR` | Decision documents directory path | No — auto-discovers from CWD |

## Content Guidelines

### What to Log

- Technology selections with alternatives considered
- Performance trade-offs (chose X over Y for reason Z)
- Significant path choices where conditions might change
- Research-informed decisions

### What NOT to Log

- Variable names, small refactors, bug fixes
- Obvious choices with no realistic alternatives
- Standard pattern applications

## System Dependencies

- `bash` 4+
- `jq` for JSON processing
- `grep` with `-P` (PCRE) support
- `sed`, `find`
