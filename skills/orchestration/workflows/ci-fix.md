# CI Fix Workflow

Fix CI failures by analyzing logs and routing to appropriate agents.

## Inputs

| Command | Flow |
|---------|------|
| `ci-fix` | § 1.1 → § 2 → § 3 → § 5 |
| `ci-fix [PR_NUMBER]` | § 1.1 → § 2 → § 3 → § 5 |
| `ci-fix queue` | § 1.2 → § 2 → § 4 → § 5 |

## 1. Identify Failures

### 1.1 Individual PR Flow

```bash
# If PR number provided, use it; otherwise list user's failing PRs
.agents/skills/github/scripts/github.sh pr-list-failing
```

If multiple failures and no argument, present:

<output_format>

### CI FAILURES

| # | PR | Title | Job | Error |
|---|-----|-------|-----|-------|
| 1 | #42 | Add user auth | build | lint |
| 2 | #43 | API endpoint | build | test |
</output_format>

→ Ask user: `Fix #1`, `Fix #2`, `Fix all`

**→ Jump to § 2**

### 1.2 Merge Queue Flow (if using GitHub merge queue)

```bash
.agents/skills/github/scripts/github.sh pr-list-failing --all
```

**→ Jump to § 2**

## 2. Fetch Error Details

```bash
.agents/skills/github/scripts/github.sh ci-logs [PR_NUMBER]
```

Returns:
- **Job name**: build job identifier
- **Error type**: fmt, lint, test, build (auto-classified)
- **Run ID**: For further investigation
- **Failed logs**: Last 100 lines of failure output

## 3. Classify & Route

Classify error and route to appropriate flow:

| Error Type | Flow |
|------------|------|
| Formatting, obvious lint, missing import | § 3.1 |
| Test failure, build error, non-obvious lint | § 3.2 |

### 3.1 Handle Simple Failures

| Error Type | Fix |
|------------|-----|
| Formatting check | Run formatter |
| Lint warning (obvious) | Apply suggested fix |
| Missing import | Add import |

1. **Get or create worktree**:
   ```bash
   ISSUE=$(.agents/skills/github/scripts/github.sh pr-issue [PR_NUMBER] --format=text)
   WT_PATH=$(.agents/skills/worktree/scripts/worktree path $ISSUE 2>/dev/null || .agents/skills/worktree/scripts/worktree create $ISSUE --pr [PR_NUMBER])
   ```

2. **Apply fix**.

3. **Commit**: `git -C "[WORKTREE_PATH]" commit -am "fix([ISSUE_ID]): Resolve CI failure ([ERROR_TYPE])"`

4. **Push**: `git -C "[WORKTREE_PATH]" push`

5. **Report**: "Fixed [TYPE] on PR #[PR_NUMBER], CI rerunning"

**→ Jump to § 4** (if merge queue) or **§ 5** (otherwise)

### 3.2 Delegate Complex Failures

| Error Type | Agent |
|------------|-------|
| Test failure | [AGENT_TYPE] |
| Non-obvious lint | [AGENT_TYPE] |
| Build error | [AGENT_TYPE] |

Infer agent type from component paths or issue labels.

**Flaky test detection**: If test failure involves concurrent/threading code and passes locally, check project testing conventions for common patterns (missing barriers, iteration-based waits, static mutable state).

**Detect team context**: `.agents/skills/orchestration/scripts/workflow-state exists [ISSUE_ID] && TEAM=$(.agents/skills/orchestration/scripts/workflow-state get [ISSUE_ID] .team_name)`

**Create tracking task**: Create task: "🐲 [AGENT]: Fix CI [ERROR_TYPE]", Update task status to in_progress.

**If in team** (`$TEAM` set) — message existing dev teammate:
```
Send delegation message to [AGENT]: content=DELEGATION, summary="Fix CI [ERROR_TYPE]"
```
Wait for completion message. Update tracking task to completed.

**If standalone** (no team) — launch sub-agent from table above. Update tracking task to completed on return.

Follow exactly, fill placeholders, add nothing else. Omit lines/sections with empty placeholders.

<delegation_format>
CI failure on PR #[PR_NUMBER] ([BRANCH_NAME]).

Job: [job name]
Error type: [fmt/lint/test/build]

Error output:
[truncated error logs]

Worktree: [WORKTREE_PATH]

1. Analyze the error (if test failure in concurrent code, check for flaky test patterns)
2. Fix the issue
3. Run the project's validation command
4. If target issue fixed but OTHER failures exist: still commit, note in message
5. Commit: "fix([ISSUE_ID]): [DESCRIPTION]" (append `[validate: FAILING_CHECK]` if other failures)
6. Push to branch

Report: what was fixed, validate status, any unrelated failures.
</delegation_format>

**→ Jump to § 4** (if merge queue) or **§ 5** (otherwise)

## 4. Handle Merge Queue Integration (if `queue` argument)

For `queue` argument (merge queue failures). May need to dequeue PR while fixing.

1. **Get draft PR commits**:
   ```bash
   gh pr view [DRAFT_PR] --json commits --jq '.commits[].oid'
   ```

2. **Cross-reference with original PRs** to identify:
   - Which file(s) failed
   - Which commit introduced the issue
   - Which original PR that commit belongs to

3. **Route by scenario**:

   | Scenario | Action |
   |----------|--------|
   | Single PR identifiable | Route to that PR's agent |
   | Integration issue (cross-PR) | Route to architecture review agent for analysis |
   | Unclear source | Present to user for decision |

4. **Create worktree from draft branch** (integration issues only):
   ```bash
   WT_PATH=$(.agents/skills/worktree/scripts/worktree create [ISSUE_ID] "[DRAFT_BRANCH]" --pr [DRAFT_PR_NUMBER])
   ```

5. **Delegate to architecture review agent**: Follow exactly, fill placeholders, add nothing else. Omit lines/sections with empty placeholders.

<delegation_format>
Merge queue CI failure - integration issue across stacked PRs.

Draft PR: #[PR_NUMBER]
Worktree: [WORKTREE_PATH]
Stack: [list PRs in stack with domains]

Error output:
[error logs]

1. Analyze which PRs interact to cause this failure
2. Identify the root cause
3. Recommend which PR(s) need changes
4. If fixable, provide specific fix instructions

Report findings for user decision.
</delegation_format>

## 5. Verify

After fix is pushed:

```bash
.agents/skills/orchestration/scripts/ci-wait [PR_NUMBER]
```

**Post to issue tracker** (if issue found in branch name):
```bash
ISSUE=$(.agents/skills/github/scripts/github.sh pr-issue [PR_NUMBER] --format=text)
[ -n "$ISSUE" ] && .agents/skills/linear/scripts/linear.sh comments create "$ISSUE" --body "CI Fix: [ERROR_TYPE] → [FIX_DESCRIPTION]"
```

## 6. Present Results

| CI Result | Output |
|-----------|--------|
| ✅ Pass | Success format below |
| ❌ Fail | Failure format below |

**If CI passes:**

<output_format>

### ✅ CI FIXED — PR #42

| Field | Value |
|-------|-------|
| Error | [ERROR_TYPE] |
| Fix | [FIX_DESCRIPTION] |
| Status | ✅ CI passing |
</output_format>

**If CI still failing:**

<output_format>

### ⚠️ CI STILL FAILING — PR #42

| Field | Value |
|-------|-------|
| Original | [ERROR_TYPE] ✅ (fixed) |
| New failure | [NEW_ERROR_TYPE] |
| Next | Run /ci-fix [PR_NUMBER] again |
</output_format>

## 7. Return State

**If managed**: Return to the parent workflow's next section.

**If standalone**: Session complete — CI fix results presented in § 6.
