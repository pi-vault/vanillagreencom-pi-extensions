#!/usr/bin/env bash
# vstack#100 Fix B + vstack#101 PR-emit: github wrappers must
# auto-bind entry_id from FLIGHTDECK_ENTRY_ID env, and PR emits must
# include refs.branch when gh pr view succeeds. Best-effort: branch
# lookup failures must silently omit refs.branch without blocking the
# emit or the wrapper.
#
# Run:  bash skills/github/tests/wrapper-entry-id-branch.test.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
TRAMPOLINE="$REPO_ROOT/skills/flightdeck/scripts/flightdeck-state"
EMIT_SH="$REPO_ROOT/skills/flightdeck/scripts/_activity-emit.sh"

SANDBOX="$(mktemp -d -t fd-wrapper-XXXXXX)"
export ACTIVITY_FILE="$SANDBOX/activity.jsonl"
export GH_LOG="$SANDBOX/gh-calls.log"
STUB_DIR="$SANDBOX/stub"
mkdir -p "$STUB_DIR"

PASS=0
FAIL=0

cleanup() { rm -rf "$SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf '  PASS: %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  FAIL: %s\n    expected: %s\n    actual:   %s\n' "$label" "$expected" "$actual" >&2
        FAIL=$((FAIL + 1))
    fi
}

# Stub gh: respond to `gh pr view <n> --json headRefName -q .headRefName`
# with a deterministic branch name; record the call for inspection.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$GH_LOG"
# pr view <n> --json headRefName -q .headRefName  → emit the branch
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [[ " $* " == *" --json headRefName "* ]]; then
    case "${3:-}" in
        BRANCH-FAIL) exit 1 ;;
        *) printf 'feature/auto-bind-%s\n' "${3:-unknown}"; exit 0 ;;
    esac
fi
exit 0
STUB
chmod +x "$STUB_DIR/gh"
export PATH="$STUB_DIR:$PATH"
export FLIGHTDECK_STATE_BIN="$TRAMPOLINE"

# Round 1: FLIGHTDECK_ENTRY_ID exported → emit picks it up automatically.
rm -f "$ACTIVITY_FILE" "$GH_LOG"
export FLIGHTDECK_MANAGED=1
export FLIGHTDECK_ACTIVITY_FILE="$ACTIVITY_FILE"
export FLIGHTDECK_SESSION=wrapper-test
export FLIGHTDECK_ENTRY_ID=triage-sweep
bash "$EMIT_SH" github pr.comments_left \
    --severity info --importance normal \
    --summary "Auto-bind smoke test" \
    --pr-number 42 \
    --branch "feature/auto-bind" >/dev/null
if [ ! -s "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: emit should have written a row\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: emit writes a row when managed\n'
    line="$(tail -n 1 "$ACTIVITY_FILE")"
    assert_eq "entry_id auto-bound from env" "triage-sweep" "$(jq -r '.entry_id' <<<"$line")"
    assert_eq "refs.pr_number from --pr-number" "42" "$(jq -r '.refs.pr_number' <<<"$line")"
    assert_eq "refs.branch from --branch" "feature/auto-bind" "$(jq -r '.refs.branch' <<<"$line")"
fi

# Round 2: pr-view.sh (sources pr-branch.sh) executes the gh lookup and
# passes --branch. Drive emit directly via the lib helper.
rm -f "$ACTIVITY_FILE" "$GH_LOG"
# shellcheck source=/dev/null
source "$REPO_ROOT/skills/github/scripts/lib/pr-branch.sh"
branch_for_42=$(pr_branch_name 42)
assert_eq "pr_branch_name resolves via gh stub" "feature/auto-bind-42" "$branch_for_42"
bash "$EMIT_SH" github pr.merge_blocked \
    --severity warning --importance important \
    --summary "PR #42 merge blocked" \
    --pr-number 42 \
    --branch "$branch_for_42" >/dev/null
line="$(tail -n 1 "$ACTIVITY_FILE")"
assert_eq "branch lookup feeds refs.branch" "feature/auto-bind-42" "$(jq -r '.refs.branch' <<<"$line")"
assert_eq "entry_id still auto-bound" "triage-sweep" "$(jq -r '.entry_id' <<<"$line")"

# Round 3: pr_branch_name on a PR that fails gh lookup → empty,
# refs.branch omitted from the emitted row.
rm -f "$ACTIVITY_FILE"
branch_for_fail=$(pr_branch_name BRANCH-FAIL)
assert_eq "pr_branch_name returns empty on gh failure" "" "$branch_for_fail"
emit_args=(
    --severity info --importance normal
    --summary "PR with failing branch lookup"
    --pr-number 99
)
[ -n "$branch_for_fail" ] && emit_args+=(--branch "$branch_for_fail")
bash "$EMIT_SH" github pr.comments_left "${emit_args[@]}" >/dev/null
line="$(tail -n 1 "$ACTIVITY_FILE")"
assert_eq "refs.branch absent when lookup fails" "null" "$(jq -r '.refs.branch // null' <<<"$line")"
assert_eq "refs.pr_number still set" "99" "$(jq -r '.refs.pr_number' <<<"$line")"

# Round 4: FLIGHTDECK_ENTRY_ID unset → no entry_id in the emit even
# under FLIGHTDECK_MANAGED.
rm -f "$ACTIVITY_FILE"
unset FLIGHTDECK_ENTRY_ID
bash "$EMIT_SH" github pr.comments_left \
    --severity info --importance normal \
    --summary "No env" --pr-number 7 >/dev/null
line="$(tail -n 1 "$ACTIVITY_FILE")"
assert_eq "entry_id absent when env unset" "null" "$(jq -r '.entry_id // null' <<<"$line")"

# Round 5: explicit --entry-id wins over env (caller override path).
rm -f "$ACTIVITY_FILE"
export FLIGHTDECK_ENTRY_ID=triage-sweep
bash "$EMIT_SH" github pr.comments_left \
    --severity info --importance normal \
    --summary "Override" --pr-number 7 \
    --entry-id PROJECT-X >/dev/null
line="$(tail -n 1 "$ACTIVITY_FILE")"
assert_eq "explicit --entry-id wins over env" "PROJECT-X" "$(jq -r '.entry_id' <<<"$line")"

# Round 6: unmanaged session → no emission at all.
rm -f "$ACTIVITY_FILE"
unset FLIGHTDECK_MANAGED FLIGHTDECK_ACTIVITY_FILE
bash "$EMIT_SH" github pr.comments_left \
    --severity info --importance normal \
    --summary "Unmanaged" --pr-number 7 >/dev/null
if [ -e "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: unmanaged should not write activity file\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: unmanaged emits no row\n'
fi

printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
