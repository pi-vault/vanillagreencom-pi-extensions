# Initialize Session

Set up team, auth, cache, and workflow state for a worktree session.

## Inputs

| Command | Flow |
|---------|------|
| `initialize` | § 1 → § 2 |
| `initialize [ISSUE_ID]` | § 1 → § 2 |
| (from start-worktree.md) | Managed lifecycle with caller context |

**Caller context parameters** (via `⤵`):
- `lifecycle` (optional): `"managed"` (return to caller at § 2) | `"self"` (default, standalone).
- `issue_id` (optional): Issue ID. If absent, extracted from branch.

---

## 1. Initialize

> If you are running in **Claude Code**: Create a team before any other steps — before auth checks, cache sync, or workflow-state init. All agents launch within the team. Other harnesses have no team concept; skip this.

1. **Run**: `.agents/skills/linear-orch/scripts/session-init --json [ISSUE_ID]`
   - Pass `[ISSUE_ID]` as a positional argument if the caller provided one; otherwise omit it.
   - The script resolves `ISSUE_ID` from the argument or current branch (via `$GH_ISSUE_PATTERN`, case-insensitive) and returns it as `issue_id` in the JSON output (alongside `branch`).
   - Read `issue_id` from the output and use it for subsequent steps. If empty (branch does not match the pattern), fall back to the sanitized branch name — replace `/` with `-` — so workflow-state and team naming still work for non-issue branches.

2. **If `gh_auth` is false or `linear_auth.ok` is false** → report error and fix before proceeding.

3. **Set `WORKTREE_PATH`** to current working directory.

4. **Sync cache**:
   ```bash
   .agents/skills/linear/scripts/linear.sh sync --reconcile
   ```

5. **Init workflow state**:
   ```bash
   .agents/skills/linear-orch/scripts/workflow-state init [ISSUE_ID] --team "[ISSUE_ID_LOWERCASE]" \
     --agent "[AGENT]" --worktree "[WORKTREE_PATH]" --branch "[BRANCH]"
   ```
   QA fields (`--qa-labels`, `--sub-issues`) set later via `.agents/skills/linear-orch/scripts/workflow-state set` when known.

---

## 2. Return State

**If managed**: Return to the parent workflow's next section.

**If standalone**: Session complete — session initialized.
