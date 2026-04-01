# Issue Lifecycle

> **Dependencies**: `$ISSUE_CLI`, `$VALIDATE_CMD`, `$DECISIONS_CMD` (optional), `$VISUAL_QA_CLI` (optional), `$SCREENSHOT_CLI` (optional), `$VISUAL_QA_TARGET_CMD` (optional), `$VISUAL_QA_FIXTURE` (optional), `$VISUAL_QA_SMOKE_CMD` (optional), `$VISUAL_QA_SWEEP_CMD` (optional), `$VISUAL_QA_BATTERY_CMD` (optional), `$BENCH_CLI` (optional), orchestration skill

**The workflow for all dev/QA agents receiving `Issue: [ISSUE_ID]` delegations.**

Skip issue tracker updates for ad-hoc requests (no issue reference).

## Delegation Types

| Type | Detection | Flow |
|------|-----------|------|
| Single | `Issue: [ISSUE_ID]` | § 1 → § 2 → § 4 → § 5 → § 6 → § 7 → § 8 → § 9 → § 10 → return |
| Bundled | `Parent: [ISSUE_ID]` + `Sub-Issues (tree): [...]` | § 1 → § 2 → [§ 4-10]×N → § 11 → return |

**If bundled**: Execute § 4-10 per **pending** sub-issue (one task each), then § 11 aggregates and returns.

**Nested sub-issues**: Sub-issues may have children (3-level hierarchy: parent → sub → nested). Blocking relations shown when present:
```
↳ [SUB_ISSUE_1]: [TITLE] | blocks: [SUB_ISSUE_2]
↳ [SUB_ISSUE_2]: [TITLE] | blocked by: [SUB_ISSUE_1]
   ↳ [SUB_ISSUE_3]: [TITLE]  ← child of [SUB_ISSUE_2]
   ↳ [SUB_ISSUE_4]: [TITLE]  ← child of [SUB_ISSUE_2]
```
Respect blocking order: complete blockers before blocked issues.

**Completed sub-issues**: Sub-issues marked `(completed)` in delegation are for context only — skip them in § 4 loop. They represent prior work in this PR.

---

## 1. Environment Setup

- Bash: `git -C [WORKTREE_PATH] ...`
- Read/Write/Edit/Grep/Glob: `[WORKTREE_PATH]/...`

```bash
BASE_BRANCH=${WORKTREE_DEFAULT_BRANCH:-$(git -C [WORKTREE_PATH] symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')}
[ -n "$BASE_BRANCH" ] || BASE_BRANCH=main
git -C [WORKTREE_PATH] fetch origin "$BASE_BRANCH"
```

---

## 2. Activate Issue

### 2.1 Claim & Get Context

```bash
# Activate issue (or parent if bundled), replace [AGENT_TYPE] with your agent type
$ISSUE_CLI issues activate [ISSUE_ID] --agent [AGENT_TYPE]
$ISSUE_CLI cache issues get [ISSUE_ID]
$ISSUE_CLI cache comments list [ISSUE_ID]
```

**If bundled**: Activate parent only. Sub-issues activated individually during § 4 loop.

**If bundled with completed siblings**: Also read comments from completed sibling sub-issues listed in delegation to pick up handoff notes:
```bash
$ISSUE_CLI cache comments list [COMPLETED_SIBLING_ID]
```

### 2.2 Check for Research Context

```bash
$ISSUE_CLI cache issues get [ISSUE_ID] | jq -r '.description'  # Look for Research/Decision/Context fields
```

**If bundled**: Also check each sub-issue for research refs. Aggregate unique paths.

**If sub-issue**: Also check the parent issue's description for research/decision references. Sub-issues inherit their parent's research context.

**If research/decision/context references found** (in issue or parent): Read the cited files — these are mandatory context, not optional. Follow § 2.2.1, then continue.

#### 2.2.1 Research-Informed Implementation

You have domain context the orchestrator lacks. You decide how research applies.

1. **Read and evaluate**: Read project research documents (e.g., `[ISSUE_ID]/findings.md`). Consider how it applies to existing patterns and architecture documentation.

2. **Check for existing decision** (decider skill): `$DECISIONS_CMD search --issue [RESEARCH_ISSUE_ID]`. If a prior research-complete already recorded a decision, reference it — don't duplicate. Only create new decisions if evaluation reveals *additional* decisions.

3. **Update architecture docs** if research changes documented patterns.

4. **Update `vstack.toml`** if research reveals project-specific context that should persist (under `[agent-guidance]` for execute-on-launch directives, `[agent-instructions]` for persistent agent rules, or `[skill-instructions]` for skill-level context).

### 2.3 Evaluate Feasibility

Before planning, check your domain's code (per your agent's Domain Setup):

- **Prior decisions?** (decider skill) `$DECISIONS_CMD search "[RELEVANT_KEYWORDS]"` to find governing decision entries
- **Description contradicts a decision?** Read the full decision file, not just the index summary. Report back to orchestrator with decision reference — do not implement approaches a decision explicitly rejects
- **Can you proceed?** Do required APIs/types exist?
- **Cross-domain dependency?** Need work in another domain first?
- **Blocked by existing issue?**
- **Optimization work without `baseline` label?** If improving existing behavior, add label now (before any code changes)

**If blocked** → **Jump to § 3**, then STOP.

**If clear** → continue to § 2.4.

### 2.4 Plan Approach

- Update estimate if scope differs: `$ISSUE_CLI issues update [ISSUE_ID] --estimate N`
  - Estimates: 1=hours, 2=half-day, 3=day, 4=2-3 days, 5=week+
- Tasks pre-created by orchestrator. Do not create duplicates.
- **If bundled**: Plan sub-issue order based on dependencies/overlap.

### 2.5 Domain-Specific Setup

Follow your agent definition for architecture docs, code paths, skills to load.

### 2.6 Capture Baseline (if `baseline` label)

**Check labels** from § 2.1. If `baseline` label present:

1. **Identify affected domain** — determine which component (backend, frontend, etc.) is affected
2. **If a benchmarking skill is available** (`$BENCH_CLI`), follow its baseline workflow to capture pre-implementation baselines

The perf-qa agent uses the baseline file during QA review.

---

## 3. Block Issue (if dependency discovered)

**Skip if** not blocked — § 2.3 routed to § 2.4 (normal flow skips § 3).

### 3.1 Blocked by Existing Issue

```bash
$ISSUE_CLI issues block [ISSUE_ID] --by [BLOCKER_ID] --reason "Cannot proceed until [REASON]"
```

### 3.2 Cross-Domain Dependency Discovery

When you discover work in another domain must happen first (prerequisite issue doesn't exist):

1. **Add blocked label**:
   ```bash
   $ISSUE_CLI issues update [ISSUE_ID] --labels "agent:[AGENT_TYPE],[COMPONENT],blocked"
   ```

2. **Post structured comment**:
   ```bash
   $ISSUE_CLI comments create [ISSUE_ID] --body "BLOCKED: Cross-domain prerequisite needed.

   **Required Domain**: [DOMAIN]
   **Suggested Labels**: agent:[DOMAIN], [COMPONENT]
   **Prerequisite Issue**: [One-line description]

   **Why Blocking**:
   [What this issue needs, why it can't proceed, what prerequisite must provide]

   **Suggested Scope**:
   - [Deliverable 1]
   - [Deliverable 2]

   Requesting orchestrator create prerequisite issue."
   ```

3. **Report to orchestrator**: Your final message must state:
   - Issue is blocked pending cross-domain work
   - Domain and labels for new issue
   - Issue description ready for creation

**Orchestrator**: Creates prerequisite, sets blocking relation, delegates.

### 3.3 Unblocked

When blocker resolves:
```bash
$ISSUE_CLI issues unblock [ISSUE_ID]
```

---

## 4. Implement Solution

**If bundled**: Each sub-issue is a separate task (§ 4-10). Work only the sub-issue named in your current task.

### 4.1 Verify Branch

`git branch --show-current` — should be `[BRANCH_NAME]` (auto-links PR to issue tracker).

**If bundled**: Branch is parent's.

### 4.2 Implement

**If bundled**: Before implementing this sub-issue:
```bash
$ISSUE_CLI issues activate [SUB_ISSUE_ID] --agent [AGENT_TYPE]
```

Implement per your agent's domain expertise. Run quality gates before completion.

**Scope growing?** Create sub-issues: `$ISSUE_CLI issues create --title "..." --parent [PARENT_ID]`

**Found work outside scope?** Note in completion summary under "Discovered Work".

**Need deeper research?** Add "needs-research" label. Pause. Report to orchestrator.

### 4.3 Update Documentation

Update relevant docs if implementation changes documented APIs or architecture.

**If significant path choices made** during implementation, follow the decider skill's create-decision workflow:

1. Get next ID: `$DECISIONS_CMD next-id`
2. Select template from the decider skill's `templates/decision-entry.md` (minimal/standard/comprehensive)
3. Create decision file per the decider skill's `schemas/decision-format.md`
4. Add row to INDEX.md per the decider skill's `templates/index-row.md`
5. Use `// REVISIT(DXXX):` in code where applicable
6. Include decision ID in § 9 completion comment

**Skip decision recording if** no alternatives were considered or trade-offs made.

**If bundled**: Complete § 5-10 (validate, commit, post summary, finalize) for this sub-issue before marking task done.

---

## 5. Validate

```bash
# Choose ONE based on change scope:
$VALIDATE_CMD --quick              # Fast: lint, unit tests (comment/minor changes)
$VALIDATE_CMD --fail-fast          # Full but stops at first failure (recommended for first run)
$VALIDATE_CMD                      # Full: build, all tests, docs, benchmarks (significant changes)
# After fixing failures:
$VALIDATE_CMD --recheck            # Only re-runs previously failed checks (skip cached passes)
```

**On failure:**
- **First run**: Use `--fail-fast` to stop early, fix, then `--recheck`
- **Simple + related to your work** → fix it, `--recheck`
- **Complex or unrelated** → still commit your work, note failure in commit message, report in return
- **Stuck** (same failure 3+ times) → stop looping, commit, report details

Always report unresolved validation failures to orchestrator.

---

### 5.1 Visual QA

**Skip if** the issue does not have the `design` label.

Use visual QA skills as necessary to validate that UI changes render correctly. Focus on what your changes affect — not the full checklist. Do NOT capture golden baselines — that happens at submit-pr time.

---

## 6. Reflect & Update Documentation

**Skip if** implementation was straightforward with no repeated issues and no notable discoveries.

**Trigger**: Any of these during § 4-5:
- Fixed same problem 2+ times (lint, pattern, API usage, test approach)
- Discovered non-obvious gotcha worth remembering
- Spent multiple cycles on something a rule could prevent
- Discovered optimal approaches that differ from documented patterns

**Action**: Update the relevant documentation. Three options depending on what you learned:

- **Architecture docs** → Update if patterns, APIs, or documented behavior changed.
- **Project rule file** → Add a `.md` file to the relevant skill's `project-rules/` directory. Follow the rule template format (YAML frontmatter with title/impact + body). Run `vstack refresh` to rebuild.
- **Project config** → Add to `./vstack.toml` (`[agent-guidance]` for execute-on-launch directives, `[agent-instructions]` for persistent agent rules, `[skill-instructions]` for skill-level context). Run `vstack refresh` to apply.

Criteria: Would this save 5+ minutes in a future session? If yes, update. One surgical addition per lesson. No verbose examples.

**If you can't update directly** (wrong domain, needs discussion): note in § 9 Discovered Work with type `[process]`.

---

## 7. Commit Changes

```bash
git -C [WORKTREE_PATH] add -A
git -C [WORKTREE_PATH] commit -m "[PREFIX]([ISSUE_ID]): [DESCRIPTION]"
```

**If bundled**: Use CURRENT sub-issue ID, not parent ID.

**Worktree caveat**: Never stage lock files listed in the project-specific gitignore. Stage specific files by name.

**If unresolved validation failures**: Append `[validate: FAILING_CHECK]` to commit message.

**Verify commit exists** before proceeding:
```bash
git -C [WORKTREE_PATH] log -1 --oneline
```

---

## 8. Apply QA Labels

Based on FINAL validated code:

| Trigger | Label |
|---------|-------|
| Unsafe code, atomics, lock-free | `needs-safety-audit` |
| Hot path, latency-sensitive, or shared/main-build perf risk | `needs-perf-test` |
| New module, public API | `needs-review` |

Full triggers: see the project label application guide.
Development-only feature exception: do not apply `needs-perf-test` for work isolated behind a development-only feature gate. Run the feature-gated checks locally and only add the label if shared or feature-off paths are affected.

---

## 9. Post Completion Summary

**Always required** — documents the FINAL state after all validation passes.

**Target issue**: Post to the issue you just implemented (for bundled work: current sub-issue, not parent).

```bash
$ISSUE_CLI comments create [ISSUE_ID] --body "## Completion Summary

**Agent**: [AGENT_NAME]
**Branch**: \`[BRANCH]\`

### Files Created/Modified
- \`path/to/file\` - Description

### Key Decisions
1. Decision and rationale
2. DXXX recorded (if research-informed)

### Skills/Docs/Rules Updated
- \`skill-name\`: Updated X
(Skip if none)

### Domain Metrics
[Your agent-specific metrics: frame time, latency, etc.]
(Skip if not applicable)

### Discovered Work
- [Type]: Description (estimate: N)
Future work beyond current scope. NOT for the next agent — for backlog/orchestrator.
(Skip if none)

### Handoff Notes
Context the next agent needs to complete its current-scope work (e.g., struct changes, API contracts, file locations). Do NOT put aspirational suggestions or future work here — those belong in Discovered Work.
(Skip if none)"
```

---

## 10. Finalize Issue

**Verify complete:**

| Step | When | Ref |
|------|------|-----|
| Baseline captured | `baseline` label | § 2.6 |
| Research applied | Research in description | § 2.2.1 |
| Validation run | Always | § 5 |
| Docs/config updated | Repeated issues in § 4-5 | § 6 |
| Changes committed | Always | § 7 |
| QA labels applied | Triggers present | § 8 |
| Summary posted | Always | § 9 |

**If single**: Return now with:
```
Branch: [BRANCH_NAME]
Commit: [SHA]
QA Labels: [labels or "none"]
Validate: [pass or "FAILING: check1, check2"]
Summary: [ISSUE_ID] ✓
```

**If bundled**: Mark task completed. Next sub-issue is a separate task, or proceed to § 11 if none remain.

**Sub-issue of a parent** → mark issue Done (`$ISSUE_CLI issues update [ISSUE_ID] --state "Done"`).
**Parent or standalone issue** → do NOT mark Done (handled by PR merge workflow and issue tracker sync).

Do NOT push or submit PR — orchestrator handles after review passes.

---

## 11. Return to Orchestrator (If Bundled)

**Skip if** single issue — you returned at § 10.

1. **Update parent issue with aggregated QA labels** (issue tracker API):
   ```bash
   # Collect QA labels from all sub-issues (including nested), apply to parent
   $ISSUE_CLI issues update [PARENT_ID] --labels "[EXISTING_LABELS],[AGGREGATED_QA_LABELS]"
   ```

2. **Post parent summary** (tree format for sub-issues, blocking info shown):
   ```bash
   $ISSUE_CLI comments create [PARENT_ID] --body "## Bundle Complete
   **Agent**: [NAME] | **Branch**: [BRANCH]

   Sub-issues (tree):
   ↳ [SUB_ISSUE_1] ✓ | blocks: [SUB_ISSUE_2]
   ↳ [SUB_ISSUE_2] ✓ | blocked by: [SUB_ISSUE_1]
      ↳ [SUB_ISSUE_3] ✓  ← nested
   Files: N | Commits: N | QA: [LABELS]
   [Discovered work: ...]"
   ```

3. **Return exactly**:

   <output_format>
   Parent: [ISSUE_ID]
   Sub-Issues: [tree format with ✓]
   Branch: [BRANCH]
   Commits: [COUNT] ([SHAS])
   QA Labels: [AGGREGATED]
   Summaries: [all issue IDs ✓]
   </output_format>
