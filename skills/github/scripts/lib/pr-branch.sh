#!/usr/bin/env bash
# Shared best-effort PR-branch lookup for github wrappers (vstack#101).
# Returns the PR head branch name on stdout, empty string on failure.
# Designed for `--branch "$(pr_branch_name "$pr_num")"` calls into
# _activity-emit.sh: a missing branch silently omits refs.branch.

pr_branch_name() {
    local pr="${1:-}"
    [ -n "$pr" ] || return 0
    gh pr view "$pr" --json headRefName -q .headRefName 2>/dev/null || true
}
