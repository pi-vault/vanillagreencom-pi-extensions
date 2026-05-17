#!/bin/bash
# View PR details for current branch or specified PR
# Usage: pr-view [PR_NUMBER] [--json FIELDS]

set -euo pipefail

# shellcheck source=../lib/pr-branch.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/pr-branch.sh"

show_help() {
    cat << 'EOF'
View PR details

Usage: pr-view [PR_NUMBER] [options]

Arguments:
  PR_NUMBER    PR number (optional, defaults to current branch's PR)

Options:
  --json FIELDS    Output specific fields as JSON (e.g., --json number,title)
  --help           Show this help

Examples:
  github.sh pr-view              # View PR for current branch
  github.sh pr-view 68           # View PR #68
  github.sh pr-view --json number   # Check if PR exists (returns JSON or fails)
  github.sh -C /path/to/worktree pr-view --json number
EOF
}

main() {
    local pr_num=""
    local json_fields=""
    local -a extra_args=()

    while [ $# -gt 0 ]; do
        case "$1" in
            --json)
                json_fields="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            -*)
                extra_args+=("$1")
                shift
                ;;
            *)
                if [ -z "$pr_num" ]; then
                    pr_num="$1"
                else
                    extra_args+=("$1")
                fi
                shift
                ;;
        esac
    done

    local -a cmd=(gh pr view)
    [ -n "$pr_num" ] && cmd+=("$pr_num")
    [ -n "$json_fields" ] && cmd+=(--json "$json_fields")
    [ ${#extra_args[@]} -gt 0 ] && cmd+=("${extra_args[@]}")

    local output status=0
    output=$("${cmd[@]}") || status=$?
    if [ -n "$output" ]; then
        printf '%s\n' "$output"
    fi
    if [ "$status" -ne 0 ]; then
        exit "$status"
    fi
    emit_checks_activity "$json_fields" "$pr_num" "$output"
}

# vstack#71 W4 Phase 7 follow-up (B2): transition-memory for PR checks.
# Returns the directory we should write the sidecar JSON into.
pr_checks_state_dir() {
    if [ -n "${FLIGHTDECK_PR_CHECKS_STATE_DIR:-}" ]; then
        printf '%s' "$FLIGHTDECK_PR_CHECKS_STATE_DIR"
        return
    fi
    if [ -n "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        printf '%s' "$(dirname "$FLIGHTDECK_ACTIVITY_FILE")"
        return
    fi
    if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
        printf '%s/flightdeck' "$XDG_RUNTIME_DIR"
        return
    fi
    printf '/tmp/flightdeck-%s' "$(id -u 2>/dev/null || echo 0)"
}

pr_checks_state_path() {
    local pr_number="$1"
    [ -z "$pr_number" ] && return 1
    printf '%s/flightdeck-pr-checks-%s.json' "$(pr_checks_state_dir)" "$pr_number"
}

pr_checks_prune_lru() {
    local dir="$1" max="${FLIGHTDECK_PR_CHECKS_LRU:-50}"
    [[ "$max" =~ ^[1-9][0-9]*$ ]] || max=50
    [ -d "$dir" ] || return 0
    local count
    count=$(find "$dir" -maxdepth 1 -type f -name 'flightdeck-pr-checks-*.json' 2>/dev/null | wc -l)
    if [ "$count" -le "$max" ]; then
        return 0
    fi
    local trim
    trim=$((count - max))
    # Delete oldest by mtime first.
    find "$dir" -maxdepth 1 -type f -name 'flightdeck-pr-checks-*.json' -printf '%T@ %p\n' 2>/dev/null \
        | sort -n \
        | head -n "$trim" \
        | awk '{ $1=""; sub(/^ /,""); print }' \
        | xargs -r rm -f 2>/dev/null || true
}

pr_checks_last_outcome() {
    local state_file="$1"
    [ -f "$state_file" ] || { printf ''; return; }
    jq -r '.lastOutcome // empty' "$state_file" 2>/dev/null || printf ''
}

pr_checks_record_outcome() {
    local state_file="$1" outcome="$2" pr_number="$3"
    local dir
    dir=$(dirname "$state_file")
    mkdir -p "$dir" 2>/dev/null || return 0
    local tmp="$state_file.tmp.$$"
    if jq -n --arg outcome "$outcome" --arg pr "$pr_number" --arg ts "$(date -Iseconds)" \
        '{lastOutcome: $outcome, prNumber: $pr, updatedAt: $ts}' \
        > "$tmp" 2>/dev/null; then
        mv "$tmp" "$state_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
        rm -f "$tmp" 2>/dev/null
    fi
    pr_checks_prune_lru "$dir"
}

# Emit pr.checks_passed | pr.checks_failed activity rows. Best-effort
# suppression of duplicate events on rollup flap:
#
#   - State sidecar at <state-dir>/flightdeck-pr-checks-<pr>.json holds
#     the last-observed outcome. New event fires ONLY when the rollup
#     transitions (prev != curr).
#   - Read-compare-record-emit is serialized via flock against a sibling
#     <state-dir>/flightdeck-pr-checks-<pr>.lock file so two concurrent
#     pr-view calls on the same PR don't both observe the pre-transition
#     state and double-emit (round-2 fix; see pr_checks_record_outcome).
#   - State dir resolves via FLIGHTDECK_PR_CHECKS_STATE_DIR override,
#     then dirname(FLIGHTDECK_ACTIVITY_FILE), then XDG_RUNTIME_DIR/
#     flightdeck, then /tmp/flightdeck-$UID. Bounded by
#     FLIGHTDECK_PR_CHECKS_LRU (default 50, oldest-mtime first).
#
# Best-effort means: any write/lock failure falls back to emitting the
# event so a broken state file never silences master.
emit_checks_activity() {
    local json_fields="$1"
    local pr_ref="$2"
    local output="$3"
    if [ "${FLIGHTDECK_MANAGED:-}" != "1" ] && [ -z "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        return 0
    fi
    if [[ ",$json_fields," != *",statusCheckRollup,"* ]]; then
        return 0
    fi
    if ! command -v jq >/dev/null 2>&1; then
        return 0
    fi
    local outcome
    outcome=$(echo "$output" | jq -r '
        (.statusCheckRollup // []) as $checks |
        if ($checks | length) == 0 then ""
        elif all($checks[]; ((.conclusion // .state // .status // "") | ascii_upcase) as $s | ($s == "SUCCESS" or $s == "SKIPPED" or $s == "COMPLETED")) then "passed"
        elif any($checks[]; ((.conclusion // .state // .status // "") | ascii_upcase) as $s | ($s == "FAILURE" or $s == "FAILED" or $s == "ERROR" or $s == "CANCELLED" or $s == "TIMED_OUT" or $s == "ACTION_REQUIRED")) then "failed"
        else "" end
    ' 2>/dev/null || true)
    if [ -z "$outcome" ]; then
        return 0
    fi
    local pr_number
    pr_number=$(echo "$output" | jq -r '.number // empty' 2>/dev/null || true)
    if [ -z "$pr_number" ] && [[ "$pr_ref" =~ ^[0-9]+$ ]]; then
        pr_number="$pr_ref"
    fi

    # vstack#71 W4 Phase 7 follow-up (B2): emit pr.checks_* ONLY on
    # transition. Flapping CI used to produce a fresh event on every
    # pr-view call; the sidecar JSON at
    # <state-dir>/flightdeck-pr-checks-<pr>.json records the last outcome
    # so duplicates collapse. State is bounded by FLIGHTDECK_PR_CHECKS_LRU
    # (default 50, oldest-mtime first).
    #
    # Round-2 fix (reviewer-arch + reviewer-error major): the
    # read-compare-write region is serialized via flock against a
    # sibling .lock file so two concurrent pr-view calls on the same PR
    # do not both observe the pre-transition state and both emit. The
    # whole emit + record sequence runs under the lock; the activity-
    # emit call stays inside so a slow emitter does not let a peer race
    # past the dedup check.
    local type severity summary
    if [ "$outcome" = "passed" ]; then
        type="pr.checks_passed"
        severity="success"
        summary="PR checks passed"
    else
        type="pr.checks_failed"
        severity="warning"
        summary="PR checks failed"
    fi
    [ -n "$pr_number" ] && summary="$summary for #$pr_number"

    if [ -n "$pr_number" ]; then
        local state_file lock_file last_outcome
        state_file=$(pr_checks_state_path "$pr_number")
        if [ -n "$state_file" ]; then
            lock_file="${state_file%.json}.lock"
            mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true
            (
                exec 9>"$lock_file"
                if ! flock -w 5 9 2>/dev/null; then
                    # Lock contention beyond 5s -> let the peer emit;
                    # we drop this one to avoid double-firing.
                    exit 0
                fi
                last_outcome=$(pr_checks_last_outcome "$state_file")
                if [ "$last_outcome" = "$outcome" ]; then
                    exit 0
                fi
                pr_checks_record_outcome "$state_file" "$outcome" "$pr_number"
                local pr_branch_locked
                pr_branch_locked=$(pr_branch_name "$pr_number")
                local checks_args=(
                    --severity "$severity"
                    --importance normal
                    --summary "$summary"
                    --pr-number "$pr_number"
                )
                [ -n "$pr_branch_locked" ] && checks_args+=(--branch "$pr_branch_locked")
                bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_activity-emit.sh" "$type" "${checks_args[@]}" || true
            )
            return 0
        fi
    fi

    local pr_branch_fallback
    pr_branch_fallback=$(pr_branch_name "$pr_number")
    local fallback_args=(
        --severity "$severity"
        --importance normal
        --summary "$summary"
        --pr-number "$pr_number"
    )
    [ -n "$pr_branch_fallback" ] && fallback_args+=(--branch "$pr_branch_fallback")
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_activity-emit.sh" "$type" "${fallback_args[@]}" || true
}

main "$@"
