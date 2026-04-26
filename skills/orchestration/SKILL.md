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

## STOP — Required Setup

You MUST complete these steps IN ORDER before doing anything else in this skill.
Do not skip ahead to workflows or commands.

1. Load the `linear` skill now.
2. Load the `github` skill now.
3. Only after both skills are loaded, continue to the workflows below.

If you cannot load a skill, stop and tell the user. Do not proceed without them.

---

> **MODE SWITCH**: Loading this skill puts you in **orchestrator mode**. Do not write code yourself. Delegate all implementation, review, and QA work to specialist sub-agents using the workflows in this skill.

> If you are running in **Claude Code**: Create a team for the **dev agent only** so it can be re-delegated across the session. Review, QA, and TPM agents are background sub-agents — spawn them with the `Task` tool, store the returned agent ID, and re-engage across cycles via `SendMessage` to that ID. **Never add review/QA/TPM agents to the team.** When asking the user a question or presenting options, always use the `AskUserQuestion` tool. `SendMessage` accepts exactly `to`, `summary`, `message` — extra fields (`type`, `recipient`, `content`, `body`) have caused duplicate delivery on idle wake-up.

> If you are running in **Codex**: Spawn workers with `fork_context: false`. Two-step pattern: (1) spawn with the `<bootstrap_format>` message, (2) `send_input` a `DELEGATION:` prefixed message containing exactly the filled `<delegation_format>` content — nothing more.

> If you are running in **OpenCode**: The persistent identity of a spawned sub-agent is the `task_id` returned by `functions.task`. On first spawn, store that `task_id` in workflow state (`child_sessions[agent].agent_id` for dev/QA, `review_agent_ids[reviewer-name]` for reviewers). On re-delegation (fix cycles, re-review), call `functions.task(task_id=<stored_id>)` — never spawn a fresh task when a stored ID exists. Fresh spawn only if: no stored ID, one resume attempt fails, or the prior task is confirmed dead.

> Do not read `README.md` — it is for human setup only.

## Prerequisites — Load Before Any Workflow

Load these dependency skills before executing any workflow. Do not guess commands — load the skill first, then use its scripts/commands.

| Skill | Domain |
|-------|--------|
| `linear` | All issue tracking operations (create, update, query, sync) |
| `github` | All PR and branch operations (create, review, merge, CI) |
| `worktree` | Parallel session management (create, list, remove worktrees) |
| `project-management` | Roadmap, cycle planning, prioritization |
| `decider` | Architectural decision documents |

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
| `review` | `[all]` \| `[last N]` \| `[HASH]` | `workflows/review.md` | On-demand review (standalone) |
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

**`start-retro`**: Review the just-completed session for: workflow execution issues (skipped steps, incorrect skip-if evaluations, ad-hoc substitutions), rule deviations, errors, judgment calls, and knowledge gaps. Categorize by severity, perform root cause analysis, propose fixes at the appropriate level (SKILL.md, workflow, agent definition, scripts), present recommendations, and apply approved changes. Runs inline — no external workflow file.

### Execution Mode

When executing a command's workflow, follow ALL [Workflow Execution](#workflow-execution) rules:
- Process sections sequentially
- Never skip based on scope assessment
- Use `⤵` markers for nested workflow invocation

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
| `workflows/review.md` | `review` | On-demand review with fix handling |
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

```bash
.agents/skills/orchestration/scripts/<script> [args]
```

| Script | Purpose |
|--------|---------|
| `workflow-state` | Persistent state read/write/append (survives compaction) |
| `open-terminal` | Launch worktree(s) for one or more issues with auto-detected harness — **dev sessions only**. Never hand-roll tmux/terminal commands; never use this for review/QA/TPM agents (they are background sub-agents). |
| `parallel-groups` | Read/manage parallel issue groups |
| `bot-review-wait` | Block until bot review posts on a PR |
| `ci-wait` | Block until CI completes on a PR |
| `session-init` | Initialize session state for a new worktree |

### `workflow-state` actions

`ORCH_STATE_DIR` overrides state directory (default: `tmp`).

| Action | Purpose |
|--------|---------|
| `init <ID> --agent <name> --worktree <path>` | Initialize state file |
| `get <ID> <.field>` | Read state field |
| `set <ID> <field> <value>` | Write state field |
| `append <ID> <field> <value>` | Append to array field |
| `increment <ID> <field>` | Increment counter |

### `open-terminal` usage

```bash
.agents/skills/orchestration/scripts/open-terminal ISSUE-1 [ISSUE-2 ...] --harness <claude|codex|opencode> [--tmux | --ghostty]
```

Auto-detects terminal (tmux if `$TMUX` set, else GUI). Creates the worktree (reuses existing), pre-trusts the directory in Claude config, and launches the harness with `/orchestration start ISSUE` as the initial prompt. **Use this any time the user asks to spawn / launch / start dev sessions for issues. Never use it for review, QA, or TPM agents — those spawn as background sub-agents inside the orchestrator session.**

## Schemas

| Schema | Purpose |
|--------|---------|
| `schemas/workflow-state.md` | Persistent state file schema (survives compaction) |
| `schemas/review-finding.md` | Review/QA agent JSON output format |
| `schemas/audit-issues-input.md` | Input for issue audit workflows |
| `schemas/roadmap-plan-input.md` | Input for roadmap planning |

Key fields per schema:

- **Workflow State**: `issue_id`, `sub_issues`, `agent`, `worktree`, `branch`, `team_name`, `child_sessions`, `review_agents`, `cycles`, `json_paths`, `fixed_items`, `escalated_items`, `audit_issues_created`
- **Review Finding**: `blockers[]` (block merge), `suggestions[]` (fix or issue), `questions[]` (PR triage). Each item: id, title, location, description, recommendation, priority, estimate
- **Audit Issues Input**: Sources: review suggestions, escalated blockers, discovered work, roadmap items. Each item includes dependency tracking (blocks_items, blocked_by_items)
- **Roadmap Plan Input**: Proposed issues with dependency tracking, breaking changes, and doc update requirements

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `ORCH_STATE_DIR` | Override state file directory | `tmp` |
| `GH_ISSUE_PATTERN` | Regex for issue IDs in branch names | — |
| `BOT_REVIEWERS` | Comma-separated bot usernames to wait for | Auto-detects |
| `BOT_CHECK_NAME` | CI check name to treat as early review signal | — |

## System Dependencies

- `jq`
- `bash` 4+
- `flock` (util-linux) for atomic state updates

## Skill Rules

### Workflow Execution

#### Sequential Section Execution

Process sections sequentially: mark in-progress, execute all sub-sections within the section, mark completed, then proceed to next. Never create tasks for sub-sections — they are steps within the parent task, not separate tasks. Never mark a parent section complete before all sub-sections are executed.

Never skip steps because the outcome seems predictable, or rationalize skipping based on change scope ("test-only", "small", "only N items", "already reviewed"). The workflow text is the decision authority, not the agent's assessment.

#### Skip-If Condition Evaluation

When a section starts with "Skip if [condition]", evaluate the condition literally. If true, append "(SKIPPED)" to the task subject and mark completed. The workflow decides what to skip, not the agent.

#### Nested Workflow Invocation

Nested workflows (marked with `⤵`) must be invoked through the harness's workflow invocation mechanism — never inlined or substituted with ad-hoc commands. If the marker includes a return point (`→ § X`), record it before invoking.

#### Worktree Scope

If the current directory is a worktree, never automatically create, switch to, or act on a different worktree or branch. When a command's resolved `ISSUE_ID` differs from the current worktree's branch, stop and ask the user: reuse the current worktree, abort, or switch explicitly. Applies to all workflows — `start`, `dev-start`, `dev-fix`, `review-pr`, `submit-pr`, etc.

---

### Delegation

#### Delegation Patterns

| Pattern | When | Flow |
|---------|------|------|
| Spawn + message | Fresh agents (dev, QA, review) | Spawn with bootstrap message → send delegation message |
| Message only | Re-delegation to existing agents | Send delegation message to running agent |
| Self-create | Agent without team context | Full delegation instructions in prompt |
| Consultation | One-off sub-agent | Full instructions in prompt, no task machinery |

#### Agent Placement

Only **dev agents** get a tmux pane (via `open-terminal`). Review, QA, and TPM agents are background sub-agents — spawned inside the orchestrator session and persisted across cycles by stored agent/task ID, **not** by team membership or pane occupancy.

| Role | Where it lives | Re-delegation mechanism |
|------|----------------|--------------------------|
| Orchestrator (worktree session) | Tmux pane via `open-terminal` | — |
| Dev sub-agent (`rust`, `iced`, …) | Team teammate (Claude Code) / persistent sub-agent (Codex, OpenCode) | `SendMessage` by name (Claude) / `send_input` (Codex) / `functions.task(task_id=…)` (OpenCode) |
| Review / QA / TPM | Background sub-agent — **never team, never pane** | Store agent/task ID at first spawn → `SendMessage` to ID (Claude) / `send_input` (Codex) / `functions.task(task_id=…)` (OpenCode) on every fix → re-review cycle |

Reviewers persist across the full review → fix → re-review loop so their initial-review context is retained on re-engagement. Shut them down only when the review pass completes (see [Review Agent Lifecycle Management](#review-agent-lifecycle-management)).

#### Bootstrap Message

When spawning a new agent, send the bootstrap message **first** before any delegation. This establishes the agent's role and boundaries. Use the template below — fill `[PLACEHOLDERS]`, send verbatim:

<bootstrap_format>
You are a [ROLE] sub-agent ([AGENT_NAME]). You report to the orchestrator.

Rules:
- Execute all assigned work yourself. Do not spawn sub-agents for implementation, review, or fix work.
- You may use Explore sub-agents for codebase search/research only.
- Only act on delegation messages from the orchestrator. If no delegation is pending, stay idle.
- After completing assigned work, send a single return message and go idle. Wait for further delegation.
- Do not manage tasks for other agents. Do not act as a coordinator.
</bootstrap_format>

The delegation message (containing the `<delegation_format>` content) follows as a separate message after the bootstrap.

#### Format Tags Are Literal

`<bootstrap_format>`, `<delegation_format>`, and `<output_format>` tags define exact content. When sending or presenting content from these tags:

1. **Fill `[PLACEHOLDERS]`** with actual values
2. **Omit lines/sections** where the placeholder value is empty or not applicable
3. **Add nothing else** — no commentary, no extra fields, no rewording, no explanations before or after the content
4. **Do not paraphrase** — use the exact structure, headings, and field names from the tag
5. **Placeholders hold structured data only** — fill only schema fields. Never embed workflow steps, commit/validate/push, or "let the orchestrator …" lines inside item records; the agent's `Follow workflow:` already owns process, and duplication triggers a second return on idle wake-up.

#### Task Layers

Work is organized in visually distinct layers: orchestrator workflow steps, nested sub-workflows, and agent tasks. Agents only act on their own assigned work — they never touch orchestrator or sub-workflow items.

#### No Duplicate Agent Spawns

Never spawn a fresh agent when the same role/name is already alive. Read workflow state first, reuse by stored agent/session ID when possible, and only respawn after one recovery attempt or confirmed stuck/closed status.

Idle agents are reusable. A prior completion message does not justify a duplicate reviewer or dev agent.

#### Single Return Message

An agent sends exactly one completion message when its assigned work is done. The agent must not send additional messages after it.

If a second return arrives, treat it as a violation, not new work. Diff against the first and flag any unrequested commits to the user. Root cause is usually process leakage in `[FORMATTED_ITEMS]` or extra fields on the delegation call.

---

### Agent Lifecycle

#### Lifecycle Stages

```
1. SPAWN        Spawn agent with bootstrap message → agent learns its role and boundaries
2. DELEGATE     Send delegation message (filled <delegation_format>)
3. WORK         Agent executes assigned work itself — no sub-delegation
4. RETURN       Agent sends single completion message to orchestrator
5. IDLE/REDEL   Agent goes idle — may receive new delegation for fix cycles
```

#### Dev Agent Persistence

Dev agents persist for the entire session. Never shut down a dev agent unless one of these conditions is met:
1. **Explicit user request** — the user directly asks to shut down the agent
2. **Confirmed stuck/incorrect** — verified via the [escalation sequence](#wait-for-agent-return-before-acting) (quiet ≠ stalled; idle ≠ stuck)

Re-delegate for review fix items, QA fix items, comment fixes, or CI failure fixes. Each re-delegation: create new tasks → send message with delegation.

#### Review Agent Lifecycle Management

Review agents persist across fix → re-review cycles within the review workflow:
- Read `review_agents` and `review_agent_ids` before spawning anything
- Reuse the same reviewer instance by exact reviewer name whenever it is still alive or recoverable
- Spawn only the missing/stuck subset; do not restart the full review pool for a new cycle
- After fixes, selectively shut down non-reporting agents for low-risk changes; keep all alive if risk flags present
- Full shutdown when review passes, clear review agents state

QA agents spawn and shut down per-agent.

#### Wait for Agent Return Before Acting

After delegation, wait for the agent's return message. Do not act on idle notifications. On each idle notification, check the task list:
- Any in-progress → **go idle** (agent is working)
- All completed → proceed
- All pending (none claimed) → re-send delegation ONCE, wait one full agent turn. If still all pending, respawn.

Never re-send or intervene while any task is in-progress.

**Quiet ≠ stalled.** Do not interpret read/search activity without file writes as a stall. Minimum quiet window: 10 minutes from delegation before escalation. No exceptions.

**Invalid stall signals** (never sufficient alone or combined): return-message timeout, clean `git status`/`git diff`/`git log`, no modified files. These observe worktree state only.

**Stall confirmation required.** Verify inactivity using session-level evidence:
- **Task-based** (Claude Code): task status unchanged across multiple idle cycles
- **Session-file** (Codex, OpenCode): no new session log entries for 10+ minutes
- **Process-level**: agent process exited or zero CPU for extended period

**Escalation sequence** (only after quiet window + confirmed stall):
1. Re-message once with clarification specifying the missing step.
2. Wait 5 min. Re-check activity signals. New activity → go idle.
3. Still inactive → shut down → respawn → re-create tasks → re-delegate.

#### Orchestrator Never Fixes Code

Never edit or write code in the worktree unless the user explicitly asks you to. Always delegate to the domain agent. If an agent appears stuck, follow the [escalation sequence](#wait-for-agent-return-before-acting) above. Read-only commands and script invocations are permitted.

---

### State Management

#### Durable Workflow State Files

Use workflow state files for any data that must survive context compaction: issue tracking, sub-issues, agent persistence, cycle counts, fix/escalation tracking, and audit trails. Use the `workflow-state` CLI for all state reads/writes.

State file location: `$ORCH_STATE_DIR/workflow-state-[ID].json` (default: `tmp/`)

#### Compaction Recovery Protocol

After context compaction, conversation history is discarded but external state persists:
1. Check the task list — find last completed task, resume from next
2. Read workflow state file for persistent data (team name, cycles, agent IDs)
3. If team-based: re-read team config from disk to restore member list
4. Re-send delegation to existing agents using stored agent/session IDs.
5. If no response after one idle cycle, respawn only the missing/stuck agent.

Never repeat completed actions.

---

### Coordination

#### Agent Sequencing by Data Dependency

When multiple agents work on related issues, determine blocking relations from data dependencies:
1. Infer agent from label or component path
2. Identify candidate pairs from sequential requirements
3. Confirm with Creates ↔ Consumes analysis — no data flow = no blocking
4. Set blocking relations on parent issues, not children, when bundled

Default sequential requirements:
- Backend → Frontend (if data dependency — UI needs backend types/APIs first)
- `*` → Generalist (runs last — may reference changes from any domain)

#### Bundled Issue Task Structure

When a parent issue has sub-issues assigned to the same agent, create one composite task per sub-issue covering all relevant sections, not one task per section. Agents execute all referenced sections, then mark the single task complete.

```
§ 1: Environment Setup          (one task)
§ 2: Activate Issue              (one task)
§ 3: Block Issue                 (one task, usually SKIPPED)
§ 4-10: PROJ-001 — First sub    (composite — all sections for this sub-issue)
§ 4-10: PROJ-002 — Second sub   (composite — all sections for this sub-issue)
§ 11: Return to Orchestrator     (one task)
```

#### Multi-Agent Bundles

When sub-issues span domains:
- Process groups sequentially per agent-sequencing rules
- Collect handoff notes between groups
- All dev agents persist per [Dev Agent Persistence](#dev-agent-persistence) rules

#### Parallel Work Safety Analysis

Before running issues in parallel, verify safety across five dimensions:
1. **Dependency resolution** — direct blocks/blockedBy, shared blockers
2. **Agent overlap** — same agent on multiple issues risks file conflicts
3. **Code scope** — analyze file paths, modules, type/value flows
4. **Build config** — manifest file changes create hard separations
5. **Active work** — check for existing worktrees and open PRs

Grouping constraints: limit concurrent issues, limit same-agent per group, manifest conflicts as hard separations.

---

### Review Pipeline

#### Review Finding Schema

All review/QA agents output JSON:

```json
{
  "agent": "agent-name",
  "timestamp": "2026-01-14T03:30:00Z",
  "verdict": "pass|action_required",
  "summary": "1-2 sentence summary",
  "blockers": [{
    "id": 1, "title": "Title (5-10 words)",
    "location": "src/file.rs (`function_name`)",
    "description": "What the issue is",
    "recommendation": "How to fix it",
    "priority": 1, "estimate": 2
  }],
  "suggestions": [{
    "id": 1, "title": "Title (5-10 words)",
    "location": "src/file.rs (`function_name`)",
    "description": "What could be improved",
    "recommendation": "How to improve it",
    "priority": 3, "estimate": 2,
    "category": "fix|issue"
  }],
  "questions": [{
    "id": 1, "location": "src/file.rs",
    "question": "Why is this async?",
    "draft_response": "Because...",
    "source": "@reviewer",
    "source_id": "PRRT_kwDO...",
    "source_type": "inline"
  }],
  "qa_metadata": {}
}
```

Verdict: `action_required` if blockers exist, `pass` otherwise. Location uses function/struct names, never line numbers.

Each item requires: `id`, `title` (5-10 words), `location` (file path with function/struct names, no line numbers), `description`, `recommendation`, `priority` (1-4), `estimate` (1-5). Suggestions also require `category` (fix or issue).

#### Recommendation Categorization

For each review suggestion, evaluate in order:

1. **Actionable?** Specific deliverable, observable impact, bounded scope. Vague → omit.
2. **Related?** Semantic relevance to issue/changes. Doc updates for changed code → always fix. Unrelated → issue.
3. **Size?** Small → fix. Needs delegation/tracking → issue.

Category signals:

| Signal | Category |
|--------|----------|
| Small, quick to apply | `fix` |
| Doc/reference updates for changed code | `fix` — always |
| Needs tracking, delegation, or history | `issue` |
| Architectural change, cross-component | `issue` |
| Test coverage (existing test) | `fix` |
| Test coverage (new suite) | `issue` |
| Error handling gaps | `issue` |
| Security vulnerabilities | `fix` if quick, else `issue` — never skip |

"Low priority" ≠ omit. Track if actionable.

#### Issue Audit Pipeline

Collect review JSON → transform `category=issue` suggestions into audit input → delegate to TPM agent for tracked issue creation. Sources: suggestions, escalated blockers, planned items, discovered work.

Audit item requires: index, title, location (no line numbers), description (2-3 sentences), recommendation (bullet-list), priority, estimate, found_by, origin (suggestion/escalated/planned/discovered). Populate dependency fields when implementation order is known.

---

### Platform-Specific Mitigations

| Behavior | Mitigation |
|----------|------------|
| Task status changes generate trailing notifications | On completed tasks, go idle immediately |
| Idle notifications wake orchestrator on every agent turn boundary | Never intervene while any task is in-progress |
| Worktree appears clean during agent research/planning phase | Check session-level activity — not worktree state — before declaring stall |
| Orchestrator loses teammate awareness after context compaction | Re-read `workflow-state` child session data, re-send delegation, only respawn if no response |
| Teammates lost on explicit session restart | Respawn + re-delegate pending tasks |
| Task creation notifications wake idle agents prematurely | Create tasks before spawning, or within existing team context |
