# Submit PR Workflow

Push changes, create/update PR, handle bot review, triage PR comments, and trigger CI.

## Inputs

| Command | Behavior |
|---------|----------|
| `submit-pr` | Submit current branch as PR |
| `submit-pr [PR#]` | Manage existing PR |
| (from start-worktree) | Managed lifecycle with caller context |

**Caller context parameters** (via `⤵`):
- `worktree`: worktree path
- `lifecycle` (optional): `"managed"` (return to caller at § 7) | `"self"` (default, standalone).
- `issue_id` (optional): issue tracker ID. If absent, extracted from branch.

**If PR# provided:**
```bash
ISSUE_ID=$(.agents/skills/github/scripts/github.sh pr-issue [PR_NUMBER] --format=text)
WT_PATH=$(.agents/skills/worktree/scripts/worktree path $ISSUE_ID 2>/dev/null || echo ".")
```

**If no argument:** Set `WT_PATH` to current directory.

**Standalone init** (`lifecycle: "self"` only):
```bash
# Extract issue from branch if not provided
ISSUE_ID=$(git rev-parse --abbrev-ref HEAD | grep -oiP "$GH_ISSUE_PATTERN")
WT_PATH=$(.agents/skills/worktree/scripts/worktree path $ISSUE_ID 2>/dev/null || echo ".")
# Init workflow state if not exists
if ! .agents/skills/linear-orch/scripts/workflow-state exists $ISSUE_ID; then
  .agents/skills/linear-orch/scripts/workflow-state init $ISSUE_ID --worktree "$WT_PATH" --branch "$(git rev-parse --abbrev-ref HEAD)"
fi
```

---

## 1. Push and Submit PR

1. **Push branch**:
   ```bash
   .agents/skills/worktree/scripts/worktree push "[WORKTREE_PATH]" --set-upstream
   ```

2. **Check for existing PR**:
   ```bash
   PR_NUM=$(.agents/skills/github/scripts/github.sh -C "[WORKTREE_PATH]" pr-view --json number,state 2>/dev/null | jq -r .number)
   ```

3. **Build PR body** from current workflow state using the template below (omit empty sections).

   **PR body MUST be written to a file before being passed to `pr-create`.** PR bodies frequently contain Markdown backticks (`` `WindowKind` ``, fenced code blocks, validation command lists). Passing them inline through any shell that performs command substitution — including unquoted heredocs in nested workflows — will execute those backticks against the local shell and corrupt the body. Use one of:

   ```bash
   BODY_FILE="[WORKTREE_PATH]/tmp/pr-body-[ISSUE_ID]-$(date +%Y%m%d-%H%M%S).md"
   mkdir -p "$(dirname "$BODY_FILE")"
   cat > "$BODY_FILE" <<'PR_BODY_EOF'
   ## Summary
   - ...
   PR_BODY_EOF
   ```

   The quoted heredoc terminator (`<<'PR_BODY_EOF'`) is what disables backtick interpolation — the unquoted form (`<<PR_BODY_EOF`) does **not** and is forbidden for PR bodies. Alternatively, write the file via your harness's `write` / `Write` tool with the full Markdown as the string content; that path performs no shell interpretation.

   ```markdown
   ## Summary
   [1-3 bullets describing changes]

   ## Context
   [For each matching decision from `.agents/skills/decider/scripts/decisions search --issue [ISSUE_ID]` (decider skill):]
   - **[DECISION_ID]**: [ONE_LINE_SUMMARY] — `[DECISION_FILE_PATH]`
   [For each research file linked to the issue:]
   - **Research**: [TITLE] — `[RESEARCH_FILE_PATH]`

   ## Completed Issues
   - Closes [ISSUE_ID] - [TITLE]
     - Closes [SUB_ISSUE_1] - [SUB_TITLE]
     - Closes [SUB_ISSUE_2] - [SUB_TITLE]

   ## Created Issues
   - [ISSUE_ID] - [TITLE] — Project: [PROJECT]

   ## QA Metrics
   [QA_METRICS] — project-configurable. Include results from QA agents that ran during review.

   ## Test Plan
   [validation steps]
   ```

   - **Completed Issues**: Use `Closes` keyword for issue tracker linkage. Indent sub-issues.
   - **Created Issues**: Include if issues created during review.
   - **QA Metrics**: Include if QA agents ran. Format is project-configurable based on which QA agent types are active.

4. **Create or update PR**:

   **No existing PR** → create with `defer-ci` label. Always pass the body via `--body-file`:
   ```bash
   ISSUE_TITLE=$(.agents/skills/linear/scripts/linear.sh cache issues get [ISSUE_ID] | jq -r '.title')

   .agents/skills/github/scripts/github.sh -C "[WORKTREE_PATH]" pr-create \
     --title "[PREFIX]([ISSUE_ID]): $ISSUE_TITLE" \
     --body-file "$BODY_FILE" \
     --label defer-ci
   ```

   **Existing PR** (`$PR_NUM` set) → update body and ensure label. `gh pr edit` also supports `--body-file`:
   ```bash
   gh pr edit "$PR_NUM" --body-file "$BODY_FILE" 2>/dev/null || true
   .agents/skills/github/scripts/commands/label-add.sh "$PR_NUM" defer-ci --reason "queue for bot review before CI" 2>/dev/null || true
   ```

   **Never** inline a PR body containing backticks or fenced code blocks via `--body "..."`. If you must produce one for tooling that lacks `--body-file`, write to a file and use `gh pr edit "$PR_NUM" --body-file "$BODY_FILE"` rather than constructing the argument in shell.

---

## 2. Wait for Bot Review

Wait for bot review to complete (sticky comment with verdict). CI is deferred via label.

```bash
WAIT_RESULT=$(.agents/skills/linear-orch/scripts/bot-review-wait [PR_NUMBER] 15 600 --json --reviewers "$BOT_REVIEWERS")
BOT_STATUS=$(echo "$WAIT_RESULT"  | jq -r '.status')
BOT_VERDICT=$(echo "$WAIT_RESULT" | jq -r '.verdict')
PENDING_REVIEWERS=$(echo "$WAIT_RESULT" | jq -r '.pending_reviewers | join(", ")')
```

Waits for all configured bot reviewers (`$BOT_REVIEWERS` — e.g., `review-bot-a[bot],chatgpt-codex-connector[bot]`). Auto-detects if not configured. Max wait 600s.

`bot-review-wait` understands per-reviewer signaling:
- **Claude-style** — formal review (APPROVED/CHANGES_REQUESTED) and/or sticky "View job" comment.
- **Codex-style** — reactions on the PR body / earliest comment (👀 = pending, 👍 = approved) and inline review threads (= changes).

`status=complete` is only emitted when **no reviewer is pending** (verdict will be `approved` or `changes`). If you need a reviewer to be ignored, pass `--skip "bot-login"` or set `BOT_SKIPPED_REVIEWERS`.

**Route result**:

| `status` | `verdict` | Action |
|----------|-----------|--------|
| `complete` | `approved` or `changes` | → § 3 |
| `timeout` | `approved` or `changes` | → § 3 (terminal verdict, safe) |
| `timeout` | `pending` | Show `pending_reviewers`; extended poll below, then ask user `Wait` \| `Skip pending bot` \| `Abort` |
| `checklist_timeout` | `approved` or `changes` | Ask user (see below) |
| `no_reviewers` | `pending` | No bot signal at all — ask user `Wait` \| `Proceed without bot review` |

**`checklist_timeout` with terminal verdict** — the bot submitted its review but is still posting inline threads. Prompt the user:

> Ask user: "Bot review verdict is **[BOT_VERDICT]** but it is still posting inline threads (checklist items unchecked). Options:"
> - **Wait 5 min** — poll again for up to 300s, then re-route
> - **Proceed** — skip remaining threads and move to comment triage now (may miss late threads)

```bash
# "Wait 5 min" path: extend checklist wait
EXT_ELAPSED=0
while [ $EXT_ELAPSED -lt 300 ]; do
  CHECKLIST_DONE=$(.agents/skills/github/scripts/github.sh sticky-comment [PR_NUMBER] --body 2>/dev/null \
    | grep -c '^\s*- \[ \]' || true)
  if [ "$CHECKLIST_DONE" -eq 0 ]; then break; fi
  sleep 30
  EXT_ELAPSED=$((EXT_ELAPSED + 30))
done
# → § 3 regardless
```

**Extended poll** (timeout + pending only):
```bash
# Poll sticky verdict every 30s for up to 300s more
EXT_ELAPSED=0
while [ $EXT_ELAPSED -lt 300 ]; do
  BOT_VERDICT=$(.agents/skills/github/scripts/github.sh sticky-comment [PR_NUMBER] --verdict 2>/dev/null || echo "pending")
  if [[ "$BOT_VERDICT" == "approved" || "$BOT_VERDICT" == "changes" ]]; then
    break
  fi
  sleep 30
  EXT_ELAPSED=$((EXT_ELAPSED + 30))
done
# Proceed to § 3 regardless (with note if still pending)
```

---

## 3. Comment Triage

### 3.1 Initial Triage

1. **Bot completion pre-check** — ensure sticky verdict is terminal before triaging:
   ```bash
   VERDICT=$(.agents/skills/github/scripts/github.sh sticky-comment [PR_NUMBER] --verdict 2>/dev/null || echo "pending")
   if [[ "$VERDICT" == "pending" ]]; then
     # Poll every 30s for up to 180s
     PRE_ELAPSED=0
     while [ $PRE_ELAPSED -lt 180 ]; do
       sleep 30
       PRE_ELAPSED=$((PRE_ELAPSED + 30))
       VERDICT=$(.agents/skills/github/scripts/github.sh sticky-comment [PR_NUMBER] --verdict 2>/dev/null || echo "pending")
       if [[ "$VERDICT" != "pending" ]]; then break; fi
     done
   fi
   # Proceed regardless — terminal or timed out
   ```

2. **Run Workflow**: `⤵ workflows/review-pr-comments.md [PR_NUMBER] § 1-8 → § 3.1` with context:
   - `lifecycle`: `"managed"`
   - `issue_id`: `[ISSUE_ID]`
   - `worktree`: `[WORKTREE_PATH]`

3. **Update state**:
   ```bash
   # For each fixed item:
   .agents/skills/linear-orch/scripts/workflow-state append [ISSUE_ID] pr_comment_review.fixes '{"description":"[DESC]","location":"[LOC]","commit":"[SHA]","source":"[SOURCE]"}'

   # For each issue created:
   .agents/skills/linear-orch/scripts/workflow-state append [ISSUE_ID] pr_comment_review.issues_created "[CREATED_ISSUE_ID]"

   # For each skipped item:
   .agents/skills/linear-orch/scripts/workflow-state append [ISSUE_ID] pr_comment_review.skipped '{"description":"[DESC]","reason":"[REASON]"}'

   # Increment iteration count
   .agents/skills/linear-orch/scripts/workflow-state increment [ISSUE_ID] pr_comment_review.iterations
   ```

4. **Route**:

   **If issues created** → § 3.3

   **If fixes applied** (no issues) → § 3.2 (re-review loop)

   **If no items fixed** AND no issues created → § 4

### 3.2 Re-Review Loop

After fixes pushed, wait for bot re-review (CI still deferred). Re-run `workflows/review-pr-comments.md` until approved or stable.

1. **Check iteration count**:
   ```bash
   ITERATIONS=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] .pr_comment_review.iterations)
   # Max 3 iterations
   if [ "$ITERATIONS" -ge 3 ]; then
     # → Max iterations exceeded → § 4
   fi
   ```

2. **Wait for bot re-review** after fixes pushed:
   ```bash
   # 1. Wait for bot to update review
   .agents/skills/linear-orch/scripts/bot-review-wait [PR_NUMBER]

   # 2. Read baseline from state
   LAST_TS=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.pr_review_baseline.last_ts // empty')
   LAST_THREADS=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.pr_review_baseline.last_threads // 0')

   # 3. Check status against baseline
   .agents/skills/github/scripts/github.sh pr-review-status [PR_NUMBER] --baseline-ts "$LAST_TS" --baseline-threads "$LAST_THREADS" > tmp/pr_status_[PR_NUMBER].json
   ```

3. **Route based on status**:

   | `needs_action` | `reason` | Action |
   |----------------|----------|--------|
   | `false` | `no_sticky` | Ask user: `Wait` \| `Skip` |
   | `false` | `no_change` | → § 4 (nothing new) |
   | `false` | `approved_clean` | → § 4 (success) |
   | `true` | `has_threads` | `⤵ workflows/review-pr-comments.md [PR_NUMBER] § 1-8 → § 3.2` with managed context, then update state, repeat |
   | `true` | `verdict_not_approved` | `⤵ workflows/review-pr-comments.md [PR_NUMBER] § 1-8 → § 3.2` with managed context, then update state, repeat |

4. **Update state** after `workflows/review-pr-comments.md` — if no fixes applied → § 4. Otherwise:
   ```bash
   # Increment iteration count
   .agents/skills/linear-orch/scripts/workflow-state increment [ISSUE_ID] pr_comment_review.iterations

   # Add fixes/issues/skipped (same as § 3.1 step 3)

   # Update baseline
   NEW_TS=$(jq -r '.sticky_updated_at' tmp/pr_status_[PR_NUMBER].json)
   NEW_THREADS=$(jq -r '.unresolved_threads' tmp/pr_status_[PR_NUMBER].json)
   .agents/skills/linear-orch/scripts/workflow-state set [ISSUE_ID] pr_review_baseline "{\"last_ts\":\"$NEW_TS\",\"last_threads\":$NEW_THREADS}"
   ```

5. **Max iterations exceeded**: Report to user with status, recommendation, and proceed to § 4.

### 3.3 Implement Created Issues

Sub-issues created during comment triage need implementation before CI.

1. **Check cycle count**:
   ```bash
   SUBMIT_CYCLES=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.submit_cycles // 0')
   ```
   **If** `SUBMIT_CYCLES >= 2` → § 4 with note: "Max re-submit cycles reached, created issues may need manual implementation."

2. **Increment**:
   ```bash
   .agents/skills/linear-orch/scripts/workflow-state increment [ISSUE_ID] submit_cycles
   ```

3. **Implement**: `⤵ workflows/dev-start.md § 1-4 → § 3.3 step 4` with context:
   - `worktree`: [WORKTREE_PATH]
   - `lifecycle`: `"managed"`
   - `issue_id`: [ISSUE_ID]

4. **Review**: `⤵ workflows/review-pr.md § 1-11 → § 3.3 step 5` with context:
   - `worktree`: [WORKTREE_PATH]
   - `lifecycle`: `"managed"`
   - `dev_agent`: from dev-start return
   - `issue_id`: [ISSUE_ID]

5. **Re-submit** → § 1 (push updated code, update PR body with new `Closes` lines, re-trigger bot review)

---

## 3.5. Update Golden Baselines

**Skip if** the issue does not have the `design` label.

```bash
LABELS=$(.agents/skills/linear/scripts/linear.sh cache issues get "$ISSUE_ID" --format=compact 2>/dev/null | jq -r '.labels[]' 2>/dev/null)
```

If `design` label present:

1. **Capture baselines in worktree**: Use visual QA skills as necessary to capture golden baselines in the worktree. If the project has no baseline-capable target, skip this step and report why.

2. **Commit and push** (without retriggering CI). Baselines are platform-specific:
   ```bash
   git -C [WT_PATH] add [BASELINE_PATH]/
   git -C [WT_PATH] commit -m "chore: update golden baselines [skip ci]"
   .agents/skills/worktree/scripts/worktree push [WT_PATH] --no-rebase
   ```

3. **Report**: `Golden baselines: updated (N scenarios)` or if capture fails, include failure reason from baseline report.

---

## 4. Trigger CI

All bot review comments resolved (or max iterations). Verify no late-arriving threads, then remove `defer-ci` label to trigger CI.

1. **Thread propagation delay** — bot may still be posting inline threads after sticky verdict:
   ```bash
   # Wait for late-arriving threads (bot posts inline comments after sticky update)
   sleep 15
   UNRESOLVED=$(.agents/skills/github/scripts/github.sh pr-threads [PR_NUMBER] --unresolved | jq '.unresolved_count')
   if [ "$UNRESOLVED" -eq 0 ]; then
     # Double-check after additional delay to catch very late threads
     sleep 15
     UNRESOLVED=$(.agents/skills/github/scripts/github.sh pr-threads [PR_NUMBER] --unresolved | jq '.unresolved_count')
   fi
   CI_GATE_REROUTED=$(.agents/skills/linear-orch/scripts/workflow-state get [ISSUE_ID] '.pr_comment_review.ci_gate_rerouted // false')
   ```

   | `UNRESOLVED` | `CI_GATE_REROUTED` | Action |
   |--------------|---------------------|--------|
   | `0` | any | → step 2 (remove label) |
   | `>0` | `false` | Set `ci_gate_rerouted=true`, → § 3.1 (one triage pass) |
   | `>0` | `true` | Ask user: "Bot posted N unresolved threads after iteration limit" — `Triage now` \| `Skip and trigger CI` \| `Abort` |

   ```bash
   if [ "$UNRESOLVED" -gt 0 ]; then
     if [ "$CI_GATE_REROUTED" = "false" ]; then
       .agents/skills/linear-orch/scripts/workflow-state set [ISSUE_ID] pr_comment_review.ci_gate_rerouted true
       # → § 3.1
     else
       # Ask user with 3 options
     fi
   fi
   ```

2. **Remove label**:
   ```bash
   .agents/skills/github/scripts/commands/label-remove.sh [PR_NUMBER] defer-ci --reason "bot review approved; running CI"
   ```

3. **Wait for CI**:
   ```bash
   .agents/skills/linear-orch/scripts/ci-wait [PR_NUMBER]
   ```

4. **Handle CI result**:

   | Result | Action |
   |--------|--------|
   | ✅ Pass | → § 6 |
   | ❌ Fail | → § 5 |

---

## 5. CI Failure Recovery

1. **Run Workflow**: `⤵ workflows/ci-fix.md [PR_NUMBER] § 1-7 → § 5`

2. **After ci-fix returns**:
   - If fix applied → add `defer-ci` label, push, wait for bot re-review (§ 3.2 with iteration check)
   - If fix not possible → Ask user: `Skip CI` | `Retry` | `Abort`

3. **Max 2 ci-fix cycles** per PR submission.

4. **After max cycles** → § 6 with note: "CI failing, may need manual intervention"

---

## 6. Standalone Summary

**If managed**: Skip → § 7

**If standalone**:

1. **Reconcile fixes**:

   Run Workflow: `⤵ workflows/fix-reconcile.md § 1-9 → § 6 step 2` with context:
   - `issue_id`: [ISSUE_ID]
   - `pr_number`: [PR_NUMBER]

2. **Post summary** — skip if no fixes AND no issues created. Write the summary to a file first so Markdown backticks and code fences cannot be command-substituted by the shell:
   ```bash
   SUMMARY_FILE="[WORKTREE_PATH]/tmp/submit-summary-[ISSUE_ID]-$(date +%Y%m%d-%H%M%S).md"
   mkdir -p "$(dirname "$SUMMARY_FILE")"
   cat > "$SUMMARY_FILE" <<'SUMMARY_EOF'
   [filled SUMMARY_CONTENT — see template below]
   SUMMARY_EOF
   .agents/skills/github/scripts/github.sh post-comment [PR_NUMBER] --body-file "$SUMMARY_FILE"
   .agents/skills/linear/scripts/linear.sh comments create [ISSUE_ID] --body "$(cat "$SUMMARY_FILE")"
   ```

   **Summary content template** (omit empty sections):

   ```markdown
   ## Recommendations Processed

   ### Fixed in PR
   - [SOURCE]: [ITEM] — [SHA]

   ### Issues Created
   - [ISSUE_ID] - [TITLE] — [PROJECT]

   ### Skipped
   - [SOURCE]: [ITEM] — [REASON]
   ```

3. **Output result**:

   <output_format>

   ### ✅ PR SUBMITTED — #[PR_NUMBER]

   | Metric | Value |
   |--------|-------|
   | PR | #[PR_NUMBER] |
   | CI | ✅ passing / ❌ failing |
   | Bot | ✅ approved / ⚠️ changes |
   | Comment iterations | [N] |
   | Fixes applied | [N] |
   | Issues created | [N] |

   </output_format>

4. **Offer merge** — skip if CI not passing:

   → Ask user: `linear-orch merge-pr [PR_NUMBER]` | `Skip`

   | Choice | Action |
   |--------|--------|
   | Merge | `⤵ workflows/merge-pr.md [PR_NUMBER] § 1-7 → end` |
   | Skip | → end |

---

## 7. Return State

**If managed**: Return to the parent workflow's next section.

**If standalone**: Session complete — PR submitted. Summary presented in § 6.
