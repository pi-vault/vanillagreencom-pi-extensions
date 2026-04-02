# Issue Lifecycle

Agent workflows for issue implementation, review fix delegation, pre-submission PR review, and QA review. Designed for specialist agents receiving delegations from an orchestrator.

## Structure

```
skills/issue-lifecycle/
├── SKILL.md              # Skill definition for AI agents and skill-aware harnesses
├── README.md             # This file — human-facing docs
└── workflows/
    ├── dev-implement.md   # Main implementation lifecycle (§ 1-11)
    ├── dev-fix.md         # Review fix delegation workflow (§ 1-6)
    ├── pr-review.md       # Pre-submission PR review workflow (§ 1 + Constraints)
    └── qa-review.md       # QA label-triggered review workflow (§ 1-3 + Constraints)
```

This skill is workflow-based — there is no `rules/` directory. All behavior is defined in the workflow files.

## Workflows

### dev-implement.md

The main workflow for dev agents receiving `Issue: [ISSUE_ID]` delegations. Supports both single-issue and bundled (parent + sub-issues) flows. Covers the full lifecycle: environment setup, issue activation, research context, feasibility evaluation, implementation, validation, visual QA, skill reflection, commit, QA label application, completion summary, and finalization.

### dev-fix.md

The workflow for dev agents receiving review fix delegations. Each review item is evaluated independently against project decisions and conventions, then applied or skipped with reasoning. Includes validation, visual QA for UI fixes, and structured return with per-item decisions.

### pr-review.md

The workflow for pre-submission review agents (project-configured review specialists, e.g., security-review, test-review, doc-review). Agents review the diff, classify findings using the orchestration skill's recommendation-bias patterns, and return a structured JSON report with a pass/action_required verdict.

### qa-review.md

The workflow for QA agents (project-configured QA specialists) triggered via `needs-*` labels. Includes decision context checking, agent-specific review execution, benchmark regression classification and recording (performance QA agent), and structured JSON report output.

## Skill Dependencies

| Dependency | Purpose | Variable |
|------------|---------|----------|
| Issue tracker CLI (e.g., `linear` skill) | Issue CRUD, cache, comments, labels | `.agents/skills/linear/scripts/linear.sh` |
| Orchestration skill | Review-finding schema, recommendation-bias patterns | Referenced by name |
| Decider skill | Decision templates, search CLI, creation workflows | `.agents/skills/decider/scripts/decisions` |
| Benchmarking | Run benchmarks if a benchmarking skill is installed | Optional |

## Configuration

### Agent types

- **Dev agents**: `[AGENT_TYPE]` — specialist agents receiving implementation delegations
- **Review agents**: `[REVIEW_AGENT]` — agents that review specific aspects (security, testing, docs, errors, structure)
- **QA agents**: `[QA_AGENT]` — agents for safety, performance, and architecture review

### Commit format

`[PREFIX]([ISSUE_ID]): [DESCRIPTION]` — configurable per project conventions.

## License

MIT
