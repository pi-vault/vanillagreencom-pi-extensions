#!/usr/bin/env bash
# Regression tests for linear-orch/scripts/bot-review-wait.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$name" "$want" "$got"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        wanted substring: %s\n        in: %s\n' "$name" "$needle" "$haystack"
  fi
}

mkdir -p "$TMP_ROOT/repo/.agents/skills" "$TMP_ROOT/bin"
ln -s "$REPO_ROOT/skills/github" "$TMP_ROOT/repo/.agents/skills/github"
ln -s "$REPO_ROOT/skills/linear-orch" "$TMP_ROOT/repo/.agents/skills/linear-orch"
git -C "$TMP_ROOT/repo" init -q
git -C "$TMP_ROOT/repo" config user.email test@example.com
git -C "$TMP_ROOT/repo" config user.name Test

FAKE_GITHUB_SH="$TMP_ROOT/fake-github.sh"
cat > "$FAKE_GITHUB_SH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "sticky-comment" && "${3:-}" == "--body" ]]; then
  exit 0
fi
printf 'unexpected github.sh call: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$FAKE_GITHUB_SH"

cat > "$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  auth)
    if [[ "${2:-}" == "status" ]]; then
      if [[ "${FAKE_GH_AUTH_MODE:-token-invalid-keyring-ok}" == "fail" ]]; then
        echo "gh auth failed" >&2
        exit 1
      fi
      if [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
        echo "GH_TOKEN invalid" >&2
        exit 1
      fi
      echo "Logged in"
      exit 0
    fi
    ;;
  repo)
    if [[ "${2:-}" == "view" ]]; then
      echo '{"owner":{"login":"owner"},"name":"repo"}'
      exit 0
    fi
    ;;
  api)
    endpoint="${2:-}"
    case "$endpoint" in
      graphql)
        echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
        exit 0
        ;;
      repos/*/pulls/1/reviews)
        echo '[{"user":{"login":"review-bot[bot]"},"state":"APPROVED","submitted_at":"2026-01-01T00:00:00Z"}]'
        exit 0
        ;;
      repos/*/issues/1/comments|repos/*/issues/1/reactions|repos/*/issues/comments/*/reactions)
        echo '[]'
        exit 0
        ;;
    esac
    ;;
esac
printf 'unexpected gh call: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$TMP_ROOT/bin/gh"

run_wait() {
  (cd "$TMP_ROOT/repo" && PATH="$TMP_ROOT/bin:$PATH" .agents/skills/linear-orch/scripts/bot-review-wait "$@")
}

echo "=== bot-review-wait auth handling ==="

cat > "$TMP_ROOT/repo/.env.local" <<EOF
GIT_HOST_CLI="$FAKE_GITHUB_SH"
export GH_TOKEN=bad-token
EOF
stderr="$TMP_ROOT/fallback.err"
output=$(run_wait 1 1 5 --json --reviewers 'review-bot[bot]' 2>"$stderr")
assert_eq "$(jq -r .status <<<"$output")" "complete" "bad GH_TOKEN falls back to gh keyring auth"
assert_eq "$(jq -r .verdict <<<"$output")" "approved" "approved formal review returns terminal JSON"
assert_contains "$(cat "$stderr")" "unsetting them" "fallback warning explains masked gh auth"

cat > "$TMP_ROOT/repo/.env.local" <<EOF
GIT_HOST_CLI="$FAKE_GITHUB_SH"
EOF
stderr="$TMP_ROOT/fail.err"
set +e
output=$(FAKE_GH_AUTH_MODE=fail run_wait 1 1 30 --json --reviewers 'review-bot[bot]' 2>"$stderr")
code=$?
set -e
assert_eq "$code" "3" "hard gh auth failure exits 3"
assert_eq "$(jq -r .status <<<"$output")" "error" "hard gh auth failure emits JSON error"
assert_contains "$(cat "$stderr")" "GitHub CLI authentication failed" "hard gh auth failure emits stderr diagnostic"

echo
printf 'pass: %d   fail: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
