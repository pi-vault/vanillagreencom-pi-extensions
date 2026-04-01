---
name: orchestration
description: "Multi-agent session coordination: issue workflows, delegation, review pipelines, cycle planning, and research spikes."
license: MIT
user-invocable: true
dependencies:
  required: [linear, github, worktree, issue-lifecycle, project-management, decider]
metadata:
  author: vanillagreen
  version: "1.1.0"
---

# Orchestration

> **Note**: `README.md` in this directory is for human setup/configuration only — not for AI agents. Follow this file (`SKILL.md`) as the authoritative skill definition.

Multi-agent session coordination with front-to-back issue workflows, delegation patterns, workflow state management, and review pipelines. Designed to survive context compaction and coordinate persistent agent sessions.

## When to Apply

Reference these guidelines when:
- Starting a multi-agent session with specialist agents
- Implementing an issue end-to-end (start → dev → review → submit → merge)
- Delegating work to dev, review, or QA agents
- Managing workflow state across context compaction boundaries
- Coordinating review → fix → re-review cycles
- Running parallel work safety analysis
- Creating or routing review findings to issue trackers
- Planning roadmaps, cycles, or research spikes

## Prerequisites — Load Before Any Workflow

Before executing any workflow in this skill, you MUST load these dependency skills.
Do not guess commands or improvise — load the skill first.

| Skill | Domain |
|-------|--------|
| `linear` | All issue tracking operations (create, update, query, sync) |
| `github` | All PR and branch operations (create, review, merge, CI) |
| `worktree` | Parallel session management (create, list, remove worktrees) |
| `issue-lifecycle` | Specialist agent delegation workflows |
| `project-management` | Roadmap, cycle planning, prioritization |
| `decider` | Architectural decision documents |

**Do not proceed with any workflow step until you have loaded the relevant dependency skill.**

## Commands

When invoked with `<command> [args]`, route to the corresponding workflow.

### Session

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `start` | `[ISSUE_ID]` | See routing below | Context-aware routing |
| `start` | `new [title]` | `workflows/start-new.md` | Create new issue + worktree |
| `start` | `self` | `workflows/initialize.md` | Initialize only, await instructions |
| `initialize` | `[ISSUE_ID]` | `workflows/initialize.md` | Team setup, auth, cache, state |

**`start` routing logic:**
1. Argument is `new` → `workflows/start-new.md`
2. Argument is `self` → `workflows/initialize.md` (extract issue from branch), then stop
3. Current directory is a worktree (git common dir differs from `.git`) → `workflows/start-worktree.md`
4. Otherwise → `workflows/start.md`

### Development

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `dev-start` | `[ISSUE_ID]` | `workflows/dev-start.md` | Delegate implementation |
| `dev-fix` | `[ISSUE_ID]` | `workflows/dev-fix.md` | Delegate review fix items |
| `ci-fix` | `PR_NUMBER` \| `queue` | `workflows/ci-fix.md` | Fix CI failures |

### Review & Submission

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `review-pr` | `[PR_NUMBER]` | `workflows/review-pr.md` | Pre-submission review |
| `review-pr-comments` | `PR_NUMBER` \| `BRANCH` | `workflows/review-pr-comments.md` | Triage PR comments |
| `submit-pr` | `[PR_NUMBER]` | `workflows/submit-pr.md` | Push, create PR, bot review, CI |
| `merge-pr` | `PR_NUMBER` \| `all` | `workflows/merge-pr.md` | Verify and merge |

### Planning & Analysis

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `audit-issues` | `project` \| `project "Name"` \| `issue [IDs]` \| `--issues [file]` | `workflows/audit-issues.md` | Audit issues for relations, hierarchy |
| `cycle-plan` | — | `workflows/cycle-plan.md` | Prioritized cycle plan |
| `roadmap` | `plan [feature]` | `workflows/roadmap-plan.md` | Consult specialists, analyze |
| `roadmap` | `create @[plan-file]` | `workflows/roadmap-create.md` | Execute plan |
| `parallel-check` | `[ISSUE_IDS]` \| `"Project Name"` | `workflows/parallel-check.md` | Verify parallel safety |
| `fix-reconcile` | — | `workflows/fix-reconcile.md` | Internal (not user-invocable) |
| `post-summary` | `[ISSUE_ID]` | `workflows/post-summary.md` | Post summary comments |

**`roadmap` routing logic:**
- `plan [feature]` → `workflows/roadmap-plan.md`
- `plan [feature] @[research-path]` → `workflows/roadmap-plan.md` with research context
- `create @[plan-file]` → `workflows/roadmap-create.md`
- `create` (no file) → Error: requires plan file from `roadmap plan`
- (empty) → Error: specify `plan [feature]` or `create @file`

### Research

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `research-complete` | `[ISSUE_ID]` | `workflows/research-complete.md` | Route completed research |
| `research-spike` | — | `workflows/research-spike.md` | Quick exploration |
| `research-issue` | — | `workflows/research-issue.md` | Internal (not user-invocable) |

### Retrospective

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `start-retro` | — | Inline (see below) | Analyze workflow execution |

**`start-retro`**: Retrospective analysis of the just-completed session. Reviews conversation for: workflow execution issues (skipped steps, incorrect skip-if evaluations, ad-hoc substitutions), rule deviations, errors, judgment calls, and knowledge gaps. Categorizes by severity (Critical/High/Medium/Low), performs root cause analysis, proposes fixes at appropriate level (SKILL.md, workflow, agent definition, scripts), presents recommendations, and applies approved changes. No external workflow file — runs inline.

### Execution Mode

When executing a command's workflow, follow ALL [Workflow Execution](#rule-categories-by-priority) rules:
- Process sections sequentially
- Never skip based on scope assessment
- Use `⤵` markers for nested workflow invocation

## Skill Dependencies

Workflows reference these companion skills. Install and configure per your project:

| Dependency | Purpose | Variable |
|------------|---------|----------|
| Issue tracker CLI (e.g., `linear` skill) | Issue CRUD, cache, comments, labels | Resolved automatically |
| Git host CLI (e.g., `github` skill) | PR operations, CI status, comments | Resolved automatically |
| Worktree CLI (e.g., `worktree` skill) | Create/remove git worktrees | Resolved automatically |
| Issue lifecycle skill | Dev implement/fix/review workflows | Referenced in delegation |
| Project management skill | TPM audit/cycle/roadmap workflows | Referenced in delegation |
| Decider skill | Decision templates, creation workflows, search CLI | Resolved automatically |
| Visual QA skill (optional) | Screenshot baselines, optional target-specific baseline routing | Referenced in submit-pr |

Project-level configuration (set in `.env.local`):

| Variable | Purpose |
|----------|---------|
| `ORCH_STATE_DIR` | Override state file directory (default: `tmp`) |
| `ISSUE_PATTERN` | Regex for issue IDs in branch names |
| `BOT_REVIEWERS` | Comma-separated bot usernames to wait for. Auto-detects if unset. |
| `BOT_CHECK_NAME` | Optional CI check name to treat as an early review signal |

## Workflows

### Session Lifecycle

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/initialize.md` | `initialize` | Team setup, auth, cache, state init |
| `workflows/start.md` | `start` (from main repo) | Dashboard, issue selection, research eval, worktree creation |
| `workflows/start-worktree.md` | `start` (from worktree) | Full session: dev → review → submit → finalize |
| `workflows/start-new.md` | `start-new` | Create new issue, spawn worktree session |

### Development

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/dev-start.md` | `dev-start` | Delegate implementation to specialist agents |
| `workflows/dev-fix.md` | `dev-fix` | Delegate fix items to dev agents |
| `workflows/ci-fix.md` | `ci-fix` | Analyze and fix CI failures |

### Review & Submission

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/review-pr.md` | `review-pr` | Pre-submission review with fix handling and QA |
| `workflows/review-pr-comments.md` | `review-pr-comments` | Triage PR review comments via domain agents |
| `workflows/submit-pr.md` | `submit-pr` | Push, create PR, bot review, comment triage, CI |
| `workflows/merge-pr.md` | `merge-pr` | Verify conditions and merge PR(s) |

### Planning & Analysis

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/audit-issues.md` | `audit-issues` | Audit issues for relations, hierarchy, gaps |
| `workflows/fix-reconcile.md` | `fix-reconcile` | Check if fixes address existing open issues |
| `workflows/post-summary.md` | `post-summary` | Post summary and handoff comments |
| `workflows/parallel-check.md` | `parallel-check` | Verify parallel work safety |
| `workflows/cycle-plan.md` | `cycle-plan` | Plan development cycles |
| `workflows/roadmap-plan.md` | `roadmap plan` | Consult specialists, analyze roadmap |
| `workflows/roadmap-create.md` | `roadmap create` | Execute roadmap plan |

### Research

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/research-issue.md` | `research-issue` | Create research issue with assets |
| `workflows/research-complete.md` | `research-complete` | Route completed research to workflows |
| `workflows/research-spike.md` | `research-spike` | Quick research exploration |

### Reference

| Workflow | Purpose |
|----------|---------|
| `workflows/agent-sequencing.md` | Cross-domain blocking relations and delegation order |
| `workflows/recommendation-bias.md` | Review finding categorization (fix vs issue) |

### Templates

| Template | Purpose |
|----------|---------|
| `templates/issue-description-template.md` | Standard markdown for issue descriptions |
| `templates/parent-issue-template.md` | Parent/bundle issues with sub-issue coordination |

## Scripts

| Script | Purpose |
|--------|---------|
| `.agents/skills/orchestration/scripts/workflow-state` | Read/write/append persistent state (init, get, set, append, increment) |

## Schemas

| Schema | Purpose |
|--------|---------|
| `schemas/workflow-state.md` | Persistent state file schema (survives compaction) |
| `schemas/review-finding.md` | Review/QA agent JSON output format |
| `schemas/audit-issues-input.md` | Input for issue audit workflows |
| `schemas/roadmap-plan-input.md` | Input for roadmap planning |

## Delegation Patterns

| Pattern | When | Flow |
|---------|------|------|
| Spawn + message | Fresh agents | Create tasks → spawn (behavioral prompt) → send delegation message |
| Message only | Re-delegation to existing agents | Create tasks → send delegation message |
| Self-create | Agent without team context | Full delegation instructions in prompt |
| Consultation | One-off sub-agent | Full instructions in prompt, no task machinery |

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Workflow Execution | CRITICAL | `wf-` |
| 2 | Delegation | CRITICAL | `del-` |
| 3 | Agent Lifecycle | HIGH | `life-` |
| 4 | State Management | HIGH | `state-` |
| 5 | Coordination | MEDIUM | `coord-` |
| 6 | Review Pipeline | MEDIUM | `rev-` |

## Quick Reference

### 1. Workflow Execution (CRITICAL)

- `wf-sequential-execution` - Process sections sequentially; never skip based on scope assessment
- `wf-skip-if-evaluation` - Evaluate skip conditions literally; append (SKIPPED) for visibility
- `wf-nested-workflows` - Invoke nested workflows through harness mechanism, never inline

### 2. Delegation (CRITICAL)

- `del-delegation-patterns` - Four delegation patterns: spawn+message, message-only, self-create, consultation
- `del-message-gate` - Mandatory message gate prevents processing non-delegation messages
- `del-task-layers` - Visually distinct task layers; agents filter by PENDING status
- `del-no-duplicate-spawn` - Message existing agents; only respawn after confirmed stuck
- `del-single-return` - Last task handles return; no additional messages after

### 3. Agent Lifecycle (HIGH)

- `life-lifecycle-stages` - Seven-stage agent lifecycle: SPAWN → DELEGATE → WORK → RETURN → IDLE/REDEL → SHUTDOWN
- `life-dev-agent-persistence` - Dev agents persist entire session; re-delegate for fix cycles
- `life-review-agent-lifecycle` - Review agents persist across fix/re-review; QA agents are one-shot
- `life-wait-for-return` - Never intervene while tasks in-progress; quiet ≠ stalled; confirm stall via session-level evidence before shutdown
- `life-never-fix-as-orchestrator` - Always delegate to domain agent; never fix code directly

### 4. State Management (HIGH)

- `state-workflow-state-file` - Use workflow-state files for data that must survive compaction
- `state-compaction-recovery` - Task list + state file recovery protocol after compaction

### 5. Coordination (MEDIUM)

- `coord-agent-sequencing` - Determine blocking from data dependencies, not agent type
- `coord-bundled-issues` - One composite task per sub-issue, not per section
- `coord-multi-agent-bundles` - Cross-domain sub-issues processed sequentially per agent-sequencing rules
- `coord-parallel-safety` - Verify five dimensions before running issues in parallel

### 6. Review Pipeline (MEDIUM)

- `rev-review-finding-schema` - Review/QA agents output JSON with verdict, blockers, suggestions, questions
- `rev-finding-schema` - All review findings require id, title, location, description, recommendation, priority, estimate
- `rev-recommendation-bias` - Categorize findings as fix vs issue using actionability/relevance/size
- `rev-issue-audit-pipeline` - Transform review findings into tracked issues via audit workflow

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `ORCH_STATE_DIR` | Override state file directory | `tmp` |

## System Dependencies

- `jq` for JSON processing
- `bash` 4+
- `flock` (util-linux) for atomic state updates

## Full Compiled Document

For the complete guide with all patterns, schemas, and delegation details expanded inline: `AGENTS.md`
