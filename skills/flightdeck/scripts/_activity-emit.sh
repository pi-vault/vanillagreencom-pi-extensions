#!/bin/bash
# Shared best-effort Flightdeck activity emitter for shell wrappers.
# Sourced by github/linear wrappers. Silent unless Flightdeck manages the caller
# or an explicit activity file is set.

set -uo pipefail

flightdeck_activity_emit() {
    local source="${1:-}"
    shift || true
    if [ -z "$source" ]; then
        return 0
    fi
    if [ "${FLIGHTDECK_MANAGED:-}" != "1" ] && [ -z "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        return 0
    fi

    local type="${1:-}"
    shift || true
    if [ -z "$type" ]; then
        return 0
    fi

    local severity="info" importance="normal" summary="$type"
    local entry_id="" pr_number="" issue_id="" linear_id="" commit="" check_name="" branch="" details_json="{}"
    local entry_id_explicit=0

    while [ $# -gt 0 ]; do
        case "$1" in
            --source) source="${2:-}"; shift 2 ;;
            --severity) severity="${2:-}"; shift 2 ;;
            --importance) importance="${2:-}"; shift 2 ;;
            --summary) summary="${2:-}"; shift 2 ;;
            --entry-id) entry_id="${2:-}"; entry_id_explicit=1; shift 2 ;;
            --pr-number) pr_number="${2:-}"; shift 2 ;;
            --issue-id) issue_id="${2:-}"; shift 2 ;;
            --linear-id) linear_id="${2:-}"; shift 2 ;;
            --commit) commit="${2:-}"; shift 2 ;;
            --check-name) check_name="${2:-}"; shift 2 ;;
            --branch) branch="${2:-}"; shift 2 ;;
            --details-json)
                # Use an explicit fall-back so bash's ${VAR:-DEFAULT}
                # brace-matching doesn't eat one of the JSON object's
                # closing braces (e.g. {"a":1} would become {"a":1}}
                # and silently reset to {} on jq validation).
                if [ -n "${2:-}" ]; then details_json="$2"; else details_json="{}"; fi
                shift 2 ;;
            *) shift ;;
        esac
    done

    # vstack#100 Fix B: auto-bind entry_id from FLIGHTDECK_ENTRY_ID env
    # when the caller did not pass --entry-id explicitly. Lets shell
    # wrappers (github/linear/etc) attribute events to the originating
    # tracked entry without each call site mirroring the same logic.
    if [ "$entry_id_explicit" -eq 0 ] && [ -z "$entry_id" ] && [ -n "${FLIGHTDECK_ENTRY_ID:-}" ]; then
        entry_id="$FLIGHTDECK_ENTRY_ID"
    fi

    if ! command -v jq >/dev/null 2>&1; then
        return 0
    fi
    if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$details_json"; then
        details_json="{}"
    fi

    local script_dir fd_state
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 0
    fd_state="${FLIGHTDECK_STATE_BIN:-}"
    if [ -z "$fd_state" ]; then
        if [ -x "$script_dir/flightdeck-state" ]; then
            fd_state="$script_dir/flightdeck-state"
        elif command -v flightdeck-state >/dev/null 2>&1; then
            fd_state="$(command -v flightdeck-state)"
        else
            return 0
        fi
    fi

    local payload
    payload=$(jq -cn \
        --arg source "$source" \
        --arg type "$type" \
        --arg severity "$severity" \
        --arg importance "$importance" \
        --arg summary "$summary" \
        --arg entry_id "$entry_id" \
        --arg pr_number "$pr_number" \
        --arg issue_id "$issue_id" \
        --arg linear_id "$linear_id" \
        --arg commit "$commit" \
        --arg check_name "$check_name" \
        --arg branch "$branch" \
        --argjson details "$details_json" '
        {
            source: $source,
            type: $type,
            severity: $severity,
            importance: $importance,
            summary: $summary,
            details: ($details + {dedup_key: ([ $source, $type, $entry_id, $pr_number, $issue_id, $linear_id, $commit, $check_name, $branch, ($details | tostring) ] | join(":"))})
        }
        + (if $entry_id != "" then {entry_id: $entry_id} else {} end)
        + ({refs: (
            {}
            + (if ($pr_number | test("^[0-9]+$")) then {pr_number: ($pr_number | tonumber)} else {} end)
            + (if $issue_id != "" then {issue_id: $issue_id} else {} end)
            + (if $linear_id != "" then {linear_id: $linear_id} else {} end)
            + (if $commit != "" then {commit: $commit} else {} end)
            + (if $check_name != "" then {check_name: $check_name} else {} end)
            + (if $branch != "" then {branch: $branch} else {} end)
        )} | if (.refs | length) == 0 then del(.refs) else . end)
    ') || return 0

    local session="${FLIGHTDECK_SESSION:-}"
    if [ -z "$session" ] && [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
        session="$(tmux display-message -p '#S' 2>/dev/null || true)"
    fi
    session="${session:-flightdeck}"
    "$fd_state" activity --session "$session" append "$payload" >/dev/null 2>&1 || true
    return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    flightdeck_activity_emit "$@" || true
    exit 0
fi
