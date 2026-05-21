# Start Session Workflow (Worktree)

Expedited session start for worktree contexts. Skips issue selection, preparation, research, and worktree creation — those completed in the prior main-repo session.

## Inputs

| Command | Flow |
|---------|------|
| `start` (from worktree) | § 1 → § 2 → § 3 → § 4 → § 5 |
| `start [ISSUE_ID]` (from worktree) | § 1 → § 2 → § 3 → § 4 → § 5 |

---

## 1. Initialize Worktree Session

**Invoke workflow**: `⤵ workflows/initialize.md § 1-2 → § 2` with context:
- `lifecycle`: `"managed"`
- `issue_id`: from argument or branch

---

## 2. Delegate to Specialist Agent(s)

1. **Invoke workflow**: `⤵ workflows/dev-start.md § 1-4 → § 2 step 2` with context:
   - `worktree`: [WORKTREE_PATH]
   - `lifecycle`: `"managed"`
   - `issue_id`: [ISSUE_ID]

2. **Parse return**: Branch, Commit, QA Labels, Summary.

3. **Do NOT shutdown dev agent.** It persists for § 3 fix cycles, § 10 pending children, and any re-delegation. Only § 5.4 shuts it down.

→ § 3

---

## 3. Run Review Cycle

**Invoke workflow**: `⤵ workflows/review-pr.md § 1-11 → § 4` with context:
- `worktree`: [WORKTREE_PATH]
- `lifecycle`: `"managed"`
- `dev_agent`: `[DOMAIN_AGENT]` from § 2
- `issue_id`: `[ISSUE_ID]`

---

## 4. Submit PR

1. **Invoke workflow**: `⤵ workflows/submit-pr.md § 1-7 → § 5` with context:
   - `worktree`: [WORKTREE_PATH]
   - `lifecycle`: `"managed"`
   - `issue_id`: `[ISSUE_ID]`

---

## 5. Finalization

Post-review cleanup: reconcile fixes, post summaries, handoff to downstream issues.

### 5.1 Reconcile Fixes Against Existing Issues

**Invoke workflow**: `⤵ workflows/fix-reconcile.md § 1-9 → § 5.2` with context:
- `issue_id`: [ISSUE_ID]
- `pr_number`: from § 4

### 5.2 Post Summary & Handoff Comments

**Invoke workflow**: `⤵ workflows/post-summary.md § 1-3 → § 5.3` with context:
- `worktree`: [WORKTREE_PATH]
- `lifecycle`: `"managed"`
- `issue_id`: [ISSUE_ID]
- `pr_number`: from § 4

### 5.3 Output Session Summary

**Do NOT mark issues Done.** Issues stay "In Review" until `workflows/merge-pr.md` or issue-closing convention triggers Done on merge.

1. **Read final state**:
   ```bash
   CYCLES=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] .cycles)
   FIXED_COUNT=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.fixed_items | length')
   ESCALATED_COUNT=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.escalated_items | length')
   PR_ITERATIONS=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] .pr_comment_review.iterations)
   PR_FIXES=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.pr_comment_review.fixes | length')
   PR_ISSUES=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.pr_comment_review.issues_created | length')
   AUDIT_ISSUES=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.audit_issues_created | length')
   ```

2. **Output session summary**:

   <output_format>

   ### ✅ SESSION COMPLETE — [ISSUE_ID]: [TITLE]

   Sub-issues (tree):
   ↳ [SUB_ISSUE_1]: [TITLE] | blocks: [SUB_ISSUE_2]
   ↳ [SUB_ISSUE_2]: [TITLE] | blocked by: [SUB_ISSUE_1]
      ↳ [SUB_ISSUE_3]: [TITLE]  ← nested

   | Metric | Value |
   |--------|-------|
   | PR | #N |
   | Commits | N (sha1, sha2, ...) |
   | Files | N |
   | Review cycles (§ 3) | [CYCLES] |
   | Fixes applied (§ 3) | [FIXED_COUNT] |
   | Escalated | [ESCALATED_COUNT] |
   | Audit issues created (§ 3) | [AUDIT_ISSUES] |
   | PR comment iterations (§ 4) | [PR_ITERATIONS] |
   | PR comment fixes | [PR_FIXES] |
   | PR comment issues | [PR_ISSUES] |
   | CI | ✅ passing |
   | Bot | ✅ approved |

   ### Issues Created

   | ID | Title | Project | Relations |
   |----|-------|---------|-----------|
   | [ISSUE_ID] | [TITLE] | [PROJECT] | blk [ISSUE_X], rel [ISSUE_Y] |

   ### Issues Updated

   | ID | Title | Changes |
   |----|-------|---------|
   | [ISSUE_ID] | [TITLE] | state: Todo→Done, +rel [ISSUE_X] |

   Omit sections with no data. Include sub-issues tree if bundled.


   </output_format>

### 5.4 Shutdown Team

1. **Shutdown all agents** from `child_sessions` in workflow state. Terminate each still-active agent.

### 5.5 Offer Merge

**Skip if** no PR created (§ 4) or CI not passing.

→ Ask user: `linear-orch merge-pr [PR_NUMBER]` | `Skip`

| Choice | Action |
|--------|--------|
| Merge | `⤵ workflows/merge-pr.md [PR_NUMBER] § 1-7 → end` |
| Skip | → end |

→ end
