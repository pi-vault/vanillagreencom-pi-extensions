---
name: flightdeck
description: "Master session lifecycle for multi-issue parallel dev work: dashboard, spawn, oversee tmux panes, answer prompts, plan merges, drive every tracked issue to merged or aborted."
license: MIT
user-invocable: true
dependencies:
  required: [github, linear, project-management]
  optional: [decider, worktree]
metadata:
  author: vanillagreen
  version: "0.2.0"
---

# Flightdeck

## STOP — Required Setup

1. Verify `$TMUX` is set. If unset, **exit immediately with no-op**: print `Flightdeck requires tmux; skipping.` and return control to the caller. Flightdeck does nothing outside tmux.
2. Load `github`, `linear`, and `project-management` skills if not already loaded. Redundant loads are no-ops.

If a required skill cannot be loaded, stop and tell the user. Do not proceed without them.

---

> **MODE SWITCH**: Loading this skill puts you in **master mode**. You are NOT a dev agent. You do not write code in any worktree, you do not run cargo/npm/builds, and you do NOT invoke per-issue orchestration workflows directly. Your role is **observe-and-direct**: from the moment a user invokes flightdeck's `start` from main, you own the master arc — dashboard → research/plan evaluation → spawn (`open-terminal`) → watch loop → merge planning → unwind. Per-issue work happens entirely inside the spawned panes; you observe their prompts via the per-harness adapter — opencode (HTTP `/session/<id>/message`), claude (Channels MCP webhook + JSONL transcript tail), pi (Unix-socket session bridge), codex (JSON-RPC over WebSocket app-server) — and `pane-respond` routes into the matching per-harness send path (`opencode run --attach`, channel POST, `pi-bridge send`, `codex-bridge send`). Tmux `capture-pane` / `send-keys` is the fallback path only, used when bridge metadata is absent. You query PR/issue facts via `gh` and `linear` and direct the per-issue agents by sending responses to their prompts. You never run `bot-review-wait`, `ci-wait`, `merge-pr`, or any other orchestration workflow yourself.
>
> **Pause for the user only on**: detected scope creep that requires reverting an agent's work, force-merging when a real content conflict exists (not just `UNKNOWN`), aborting an issue, flightdeck mutating `main` directly via raw `gh pr merge` when no orchestrator pane is alive to drive it, or a novel prompt shape no rule covers.
>
> **Architectural boundary**: flightdeck does NOT re-implement gates that orchestration owns. When the orchestrator surfaces a prompt (merge-now, audit-relation, fix-suggestions, etc.), its upstream conditions have already been checked — that's why it's asking. Master answers the prompt; it does not re-validate CI / mergeable / thread state. The only checks master adds are ones master alone has (cross-session conflict graph, multi-pane scope drift). Don't conflate "the orchestrator is asking permission to mutate main" with "flightdeck would be mutating main directly" — they're different actions.
>
> Flightdeck is multi-harness. The same logic applies whether the spawned pane is claude code, codex, opencode, or pi. Each harness has its own structured-input adapter (see `patterns/tmux-monitoring.md` § per-harness signals); tmux `capture-pane` / `send-keys` remains as the documented fallback when an adapter's bridge metadata is missing for a particular pane.

## Commands

### Session

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `start` | `[ISSUE_ID]` | `workflows/start.md` | From-main entry. Dashboard, issue selection, research evaluation, parallel-check, spawn (`open-terminal`), enter watch loop. |
| `start new` | `[title]` | `workflows/start-new.md` | Create new issue + spawn. |
| `start self` | — | inline | Initialize master session only, await further commands. |
| `parallel-check` | `[ISSUE_IDS]` | `workflows/parallel-check.md` | Verify a candidate set is safe to spawn in parallel. |
| `watch` | `[ISSUE_IDS]` | `workflows/watch.md` | Master oversight loop. Invoked at the end of `start.md` after spawn; can be re-entered manually after compaction. |
| `status` | — | inline | Print current pane registry + state machine snapshot from `tmp/flightdeck-state-<TMUX_SESSION>.json`. Read-only. |

### Planning (cross-call to `project-management`)

| Command | Workflow | Notes |
|---------|----------|-------|
| `cycle-plan` | `⤵ .agents/skills/project-management/workflows/cycle-plan.md` | TPM-driven cycle planning |
| `audit-issues` | `⤵ .agents/skills/project-management/workflows/audit-issues.md` | Issue audit (project / project-order / issue [IDs] / --issues file) |
| `roadmap plan` / `create` | `⤵ .agents/skills/project-management/workflows/roadmap-plan.md` / `roadmap-create.md` | Roadmap planning + execution |
| `research-spike` | `⤵ .agents/skills/project-management/workflows/research-spike.md` | Initiate a research issue with assets |
| `research-complete` | `⤵ .agents/skills/project-management/workflows/research-complete.md` | Route a completed research issue |

## Skill Rules

Lessons distilled from real multi-issue session experience are grouped by domain under `patterns/`. Read the relevant pattern doc whenever the matching prompt class appears.

### Tmux monitoring (`patterns/tmux-monitoring.md`)

- **Pane-0 rule**: always target the explicit pane index `<session>:<window>.0` for orchestrator-pane reads. `tmux capture-pane -t <session>:<window>` defaults to the active pane, which may not be the orchestrator's UI when sub-agents have spawned additional panes. Pin the orchestrator-pane index per window at registry init via fingerprinting if a TUI lays out differently.
- **Bell clearing**: after sending any input, run the chained-command idiom to clear the bell flag without flicker:
  ```
  tmux select-window -t <session>:<window> \; select-window -t <ORIG>
  ```
  The chain is atomic — the client never has to render the intermediate window.
- **Capture-pane scrollback**: use `-S -200` for prompt classification (enough history to see the full prompt + options without grabbing the entire scrollback).

### Prompt handlers (`patterns/prompt-handlers.md`)

- **Cleanup scope** — for prompts asking about worktree/branch cleanup, answer YES iff the target path equals the asking pane's registered worktree. NEVER answer YES for sibling worktrees. Some agents propose batch cleanup; that's wrong because parallel sessions are still using them.
- **Combine guidance with response** — when a prompt-option pick triggers immediate sub-agent delegation (rebase resolution, fix delegation), guidance for the sub-agent must be in the SAME input as the option pick. Use "Type your own answer" / "Chat about this" to combine. Follow-up messages arrive after delegation has already left and are too late to influence the sub-agent.
- **Bot-review prompt response** — when a per-issue agent's `bot-review-wait` times out and surfaces a Skip/Wait/Abort prompt, master decides based on the **actual PR check state** queried via `gh pr view <PR> --json statusCheckRollup,reviewDecision,labels`. If the bot's check (e.g., `Claude Code claude`) is `SUCCESS` and reviewDecision is `APPROVED` (or unset and no requested reviewers pending), Skip is safe. If a real reviewer is genuinely pending → escalate. Master does NOT re-invoke `bot-review-wait` — that script runs inside per-issue agent contexts.
- **Rebase-multi-choice guidance template** — when a rebase prompt requires preserving sibling-PR logic, the combined payload must follow the **preserve / apply / verify** triplet:
  - **Preserve**: name the function signatures, parameter splits, or new wrappers that arrived from the upstream merge and must NOT be reverted
  - **Apply**: name the field renames, type updates, or local refactors that go ON TOP of the preserved upstream shape
  - **Verify**: name the exact test invocation that proves both sides are intact
- **Parent vs related (audit prompts)** — child issues are MANDATED by orchestration to land in the parent's branch/PR. Accept `child of <current-PR-issue>` when the new issue's scope doesn't intersect with any other live worktree's PR files (expansion bias). Reject (use `related` instead, or rearrange to a different parent) when there's a real conflict. Capture each new issue's proposed parent/project/scope at decision time so the end-of-session report can summarize what was created where.
- **Verify-don't-trust** — after any agent claims a structural change is complete (rebase done, conflicts resolved, fields renamed), run a verification grep against the worktree before advancing the issue's state. For rebase post-actions: check function signatures and field-rename counts in each conflict file.

### Conflict detection (`patterns/conflict-detection.md`)

- **defer-ci semantics** — the `defer-ci` GitHub label blocks heavy CI lanes (Lint, Cross-Platform, Linux Integration, Bench, Fixture Sync) but does NOT block bot reviews (Claude Code workflow). So bot review can run while defer-ci is on; CI only runs after the label is dropped.
- **File-level conflict graph** — build conflict edges from `gh pr view <N> --json files`. Two PRs with file-set intersection conflict; topologically order merges with smallest-scope-first.
- **UNKNOWN-state timer** — GitHub's `mergeStateStatus` stays `UNKNOWN` for ~minutes after upstream `main` moves. If `reviewDecision == APPROVED`, all checks `SUCCESS` or `SKIPPED`, zero `FAILURE`, AND content is disjoint from anything in main, force-merge is safe after the configured wait threshold.
- **Force-merge predicate**: `APPROVED ∧ all_checks_in {SUCCESS, SKIPPED} ∧ disjoint(PR_files, main_files_recently_changed) ∧ unknown_since > FLIGHTDECK_FORCE_MERGE_AFTER_SECS`.

### Decision biases (`patterns/decision-biases.md`)

- **Scope-creep detector** — compare `scope_files_actual` (from `gh pr view --json files`) against `scope_files_declared` (parsed from issue description's file references). If `actual > 2 × declared`, flag as scope creep and escalate to user. Don't auto-revert.
- **Smaller-PR-first merge order** — when two PRs overlap on files, merge the smaller-scoped one first. The bigger PR absorbs the rebase. Reverse order forces the smaller PR to rebase against the bigger restructure — much harder.
- **Rule of three** — don't extract test helpers across <3 sibling files. At 2 sites, the abstraction shape isn't visible; extraction is premature. At 3, rule satisfied. Track sibling count when reviewing test-helper consolidation suggestions.
- **PR/branch expansion bias** — prefer fixing additional findings inline in the current PR over deferring to new issues, UNLESS strong reason exists (different scope, different agent, requires measurement, blocked dependency, architectural decision needed). Strong reasons are concrete, not "tidiness".
- **Merge-order tiebreakers**: (1) smallest scope first, (2) overlapping-files: smaller goes first, (3) otherwise: any order is fine.

### Pi harness

- **Optional dashboard extension** — when the master agent runs under the Pi harness, the [`pi-flightdeck`](../../pi-extensions/pi-flightdeck/README.md) extension renders a read-only mission-control overlay reading the same on-disk artifacts master and the daemon already write (`tmp/flightdeck-state-<SESSION>.json`, `${FD_STATE_DIR}/fd-{daemon,master,wake-events}-<KEY>.*`). It surfaces a high-contrast pause banner whenever `paused_for_user` is set, a persistent dashboard widget, and a `/flightdeck` popup with Overview / Live feed / Conversations / Conflicts & merges / Decisions / Daemon tabs. The skill is fully harness-agnostic and works without the extension — the extension is purely additive UX. Master never relies on it.
- **No write coupling** — pi-flightdeck never mutates flightdeck state, the master-busy lock, the wake-events log, or pane registries. Daemon owns wake delivery, master owns state mutation via `flightdeck-state`, and `pane-respond` owns sending input to inner panes. Forwarded user decisions reach master via normal Pi chat (the user types a reply when the pause banner appears), never via the extension.
- **No equivalent for other harnesses** — claude code, opencode, and codex masters use `flightdeck-state get`, `pane-registry list`, and `flightdeck-daemon health` directly. The on-disk schema in this SKILL.md is the canonical interface; do not introduce harness-specific shortcuts that bypass it.

### Structured questions (`patterns/opencode-questions.md`, `patterns/pi-questions.md`)

- **Opencode wake events** — `oc-question` is canonical. Daemon emits the structured payload (header, options[], multiple) with classifier_tag `oc-question` and source `oc-question-event`. Master answers via `pane-respond --harness opencode --question <reqID> --answer "<label>"` / `--answer-multi "<l1,l2>"` / `--answers-json '[["tab1"],["tab2"]]'` / `--reject` — routes to `POST <oc_url>/question/<reqID>/{reply,reject}`. No tmux send-keys involved.
- **Pi wake events** — `pi-question` is canonical. Daemon emits the `pi-questions` payload (header, questions[], options[], multiple, allowCustom) from `pi-bridge stream`. Master answers via `pane-respond --harness pi --question <reqID> --answer "<label>"`, `--answer-multi "<l1,l2>"`, `--answer-text "<free text>"` when `allowCustom=true`, `--answers-json '[["tab1"],["custom text"]]'` for multi-tab requests, or `--reject`. This routes through `pi-bridge answer|reject`; do not drive the inline editor with tmux keys unless bridge metadata is missing.
- **Pi inner agent completions** — `pi-subagent-completion` is an advisory event from a Pi orchestration pane's `pi-agents-tmux` inner panes. Flightdeck still targets only the outer orchestrator pane (`pane_target`, usually pane 0); do not call `subagent`, `steer_subagent`, or `get_subagent_result` for that orchestrator's inner panes, and do not target them by cwd/session metadata. Re-poll the orchestrator and act only on the orchestrator's own prompt/state. If the orchestrator needs a decision about an inner result, it will surface a normal outer prompt/question; answer that outer prompt. The daemon only wakes canonically for blocked/failed/needs-completion inner completions to avoid noise from successful worker returns.
- **Never pass off-list labels except Pi custom text** — for opencode and normal Pi option picks, choose `--answer` labels from `question.questions[i].options[].label` (or opencode's equivalent `questions[i].options[].label`). For Pi only, use `--answer-text` for free-form responses and only when the wake payload's matching tab has `allowCustom=true`. For opencode free-form, `--reject` and follow up with `opencode run --attach --session <SID> "<text>"` instead.

## Scripts

```bash
.agents/skills/flightdeck/scripts/<script> [args]
```

| Script | Purpose |
|--------|---------|
| `open-terminal` | Launch worktree(s) for one or more issues with selected harness plus optional model/effort overrides — **never hand-roll tmux/terminal commands; use this for every session spawn** |
| `parallel-groups` | Read/manage parallel issue groups |
| `flightdeck-state` | Master-state CRUD wrapper — atomic init/get/set/append/increment/archive for `tmp/flightdeck-state-<TMUX_SESSION>.json`. `init` sweeps stale `.tmp.<PID>` orphans from prior crashed writes; `archive` rotates a terminated state file to `<file>-<terminated_at>.json.archive` so the next session in the same tmux name starts clean. `master-busy lock [--master-pane <%N>] [--owner-pid <PID>] \| unlock \| check` writes/clears the daemon's master-busy lockfile atomically (temp+mv). The lock records `{master_pane_id, started_at}` and optionally an `owner_pid`; daemon validates the lock via pane-alive + (owner-pid alive if recorded) + `FD_MASTER_TURN_TTL`. If `started_at` cannot be parsed on the host, daemon skips the TTL gate rather than treating the lock as epoch-0 stale. Do NOT pass the calling shell's `$$` as owner-pid — the wrapper exits before the daemon reads the file |
| `flightdeck-daemon` | External bash wake driver. Per-pane subscribers — opencode HTTP-attach (Phase 1), claude JSONL tail (Phase 2), pi-bridge stream (Phase 3), codex-bridge stream (Phase 4) — emit normalized turn-end events into a wake-events log; daemon main loop drains and routes canonical-tag events through wake_master. Panes without adapter metadata fall through to the legacy capture-pane / bell / hash-stable loop; the fallback path resolves pane targets, window bell/activity flags, and pane-in-mode once per tick via `tmux list-panes -aF`, then hashes each captured buffer as a SHA-12 value without the old `cut`/`head` helper pipeline. OpenCode subscribers exponentially back off unchanged `/question` + `/session/<id>/message` polls up to `FD_OC_BACKOFF_MAX_SEC` and reset immediately on new question ids, response hash change, or daemon bell marker. Per-tick subscriber liveness watchdog clears `OC_SUBSCRIBED[pane]` when the sidecar wrapper dies so the pane resumes on capture-pane fallback; pi and codex wrappers reconnect bridge streams every second after stream exit. Coalesces multiple ready panes into one wake. Wake delivery is per-harness: Pi via `pi-bridge send --pid <master_pid>` (auto-detected by process-tree match or unambiguous cwd + process/tty match, or `--master-harness pi` explicit), Codex via `$flightdeck` grammar, others via `/flightdeck` slash form; tmux paste-buffer is the fallback transport when bridge send fails. Same-pid self-exec resume after `FD_MAX_LIFETIME`. Actions: `start [--master-harness <h>] [--inner-harnesses <h1>,...] [--foreground\|--in-tmux-window] [--debug-pane <%N>] \| stop \| status \| health \| find-window \| events \| ack` |
| `pane-registry` | Issue↔pane mapping CRUD. `init` resolves and stores the immutable tmux `pane_id` (`%N`) alongside `pane_target` (gated on `tmux list-panes -t <pane>` so a bogus `--window` cannot poison `pane_id` with the active pane). `reconcile` and `remove-merged` check liveness by `pane_id` (with `window_name` fallback for legacy entries; legacy entries are backfilled opportunistically). Required because pi/codex auto-rename their tmux window once the TUI starts, which a `window_name`-keyed reconcile would interpret as the entry being stale. `list --format inner-panes` emits `pane_id` when present (daemon `--inner` accepts `%N` directly), `pane_target` otherwise. Adapter args (`oc-attach-args`, `cc-channel-args`, `pi-bridge-args`, `cx-bridge-args`) gate on freshness probes (`<h>_adapter_is_fresh`): dead pid/socket, failed HTTP health/message endpoint, or failed Codex bridge RPC → empty stdout → daemon falls back to capture-pane instead of marking the pane subscribed against a dead adapter. |
| `pane-poll` | Status read. Preferred watch-loop mode is `pane-poll --batch -`, reading a JSON array from `pane-registry list --format json`, resolving tmux pane/window metadata once, and emitting one JSONL object per issue. Legacy single-pane mode still accepts `<session>:<window> <pane-index>` or immutable `%N` pane ids directly for drift re-polls and manual debugging. Per-harness adapter routes: opencode → `GET /session/<id>/message`; claude → tail of `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; pi → `pi-bridge history`; codex → `codex-bridge turns`. Registry and spawn-file metadata fallbacks both run freshness gates before use; tmux `capture-pane` is the fallback when a pane has no fresh bridge metadata. Bell flag + classify. |
| `pane-respond` | Send a response to a pane. Modes: positional `<payload>` (free-text), `--option N` (numeric option pick — Claude Code uses arrow navigation, opencode/pi/codex adapters send digits as message text), `--option-multi N1,N2,...` (multi-select toggles), `--keys k1,k2,...` (raw key sequence — rejected unless `--keys-allow-tmux`), `--question <reqID> --answer "<label>" \| --answer-multi "l1,l2" \| --answer-text "free text" \| --answers-json '[[...]]' \| --reject` (opencode/Pi structured question APIs; Pi `--answer-text` is only for `allowCustom=true`; `--answers-json` is for multi-tab requests). Adapter routes: opencode → `opencode run --attach --format json` / HTTP question API; claude → channel POST; pi → `pi-bridge send` / `pi-bridge answer|reject`; codex → `codex-bridge send`. Tmux paste-buffer fallback when bridge metadata absent. Validates rebase-multi-choice payloads include the preserve/apply/verify triplet. |
| `pane-clear-bell` | Atomic chained-command bell clear (no flicker) |
| `pr-conflict-graph` | Build file-intersection adjacency for a list of PR numbers via `gh pr view --json files` |
| `prompt-classify` | Regex/sentinel matcher mapping a captured prompt buffer to a handler tag (`cleanup-prompt`, `bot-review-wait-stuck`, `rebase-multi-choice`, `audit-relation-prompt`, `merge-ready-but-unknown`, `scope-creep-detected`, `generic-multi-choice`, `rendering`) |

## Schema — master state

Master state lives at `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<TMUX_SESSION_NAME>.json` (default `<project-root>/tmp/flightdeck-state-<NAME>.json`). `flightdeck-state` keys the filename by `tmux display-message -p '#S'` — the human-readable session **name**, not the session id. Daemon-private files in `FD_STATE_DIR` (default `$XDG_RUNTIME_DIR/flightdeck`, fallback `/tmp/flightdeck-$UID`) are keyed instead by `SESSION_KEY=s<N>` derived from `#{session_id}` (e.g., session id `$21` → `s21`); they survive a tmux session rename, master state does not. The file survives compaction and is rehydrated on `watch` re-entry. On terminate, master state is rotated to `flightdeck-state-<TMUX_SESSION_NAME>-<terminated_at>.json.archive` (see `terminate.md § 5`).

```json
{
  "session_id": "<TMUX_SESSION_NAME>",
  "started_at": "<ISO8601>",
  "terminated": false,
  "issues": {
    "<ISSUE_ID>": {
      "window": "<window-name>",
      "pane_target": "<TMUX_SESSION>:<window>.0",
      "pane_id": "%403",
      "harness": "claude|opencode|codex|pi",
      "launch": { "model": "<model-or-null>", "effort": "<effort-or-null>" },
      "worktree": "<absolute path>",
      "pr_number": 0,
      "oc_url":  "<server-url-or-null>",  "oc_session_id": "<id-or-null>",  "oc_port": 0,
      "cc_url":  "<server-url-or-null>",  "cc_session_uuid": "<uuid-or-null>",  "cc_port": 0,  "cc_transcript": "<path-or-null>",
      "pi_bridge_pid": 0,  "pi_bridge_socket": "<path-or-null>",  "pi_session_id": "<id-or-null>",
      "cx_ws":   "<ws-url-or-null>",  "cx_thread_id": "<id-or-null>",
      "state": "prompting",
      "substate": "merge-ready-but-unknown",
      "unknown_since": "<ISO8601>",
      "last_capture_hash": "sha256:...",
      "last_response_at": "<ISO8601>",
      "spawned_at": "<ISO8601>",
      "last_polled_at": "<ISO8601>",
      "orchestration_started": true,
      "scope_files_declared": 5,
      "scope_files_actual": 27,
      "decisions_log": [
        {"ts": "<ISO8601>", "prompt_tag": "cleanup-prompt", "answer": "yes-own-only"}
      ]
    }
  },
  "merge_queue": ["<ISSUE_ID>", "<ISSUE_ID>"],
  "conflict_graph": {
    "edges": [["<ISSUE_A>", "<ISSUE_B>"]],
    "computed_at": "<ISO8601>"
  },
  "paused_for_user": null
}
```

State enum: `state ∈ {waiting, prompting, submitting, merge-ready, merged, aborted, dead}`. `paused_for_user` carries `{issue_id, reason, prompt_text}` when an aggressive-mode pause fires.

## Configuration

Master-loop (workflow) env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | `240` | UNKNOWN-state wait threshold before considering force-merge (predicate also requires APPROVED + green + disjoint) |
| `FLIGHTDECK_STATE_DIR` | `tmp` | Project-relative master-state file directory |
| `FLIGHTDECK_DEBOUNCE_CYCLES` | `2` | Consecutive poll cycles required for "all-done" termination check |
| `FLIGHTDECK_AUTO_MERGE` | `1` | When `0`, the `merge-now` handler escalates instead of auto-answering. For sessions where the human gate is desired (compliance, big-blast-radius PRs) |
| `FLIGHTDECK_HIJACK_GRACE_SECS` | `90` | Seconds after spawn that master tolerates no orchestration `workflow-state-<ISSUE>.json` before escalating "orchestration-never-started". Catches hijacked panes / failed launches. |
| `FLIGHTDECK_LAUNCH_MODEL` | unset | Default `open-terminal --model` override when the workflow/user does not pass `--model`. |
| `FLIGHTDECK_LAUNCH_EFFORT` | unset | Default `open-terminal --effort` / thinking override when the workflow/user does not pass `--effort`. |

Daemon env vars (read by `flightdeck-daemon`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `FD_POLL_SEC` | `2` | Inner-pane poll cadence |
| `FD_OC_POLL_SEC` | `2` | OpenCode subscriber base poll cadence |
| `FD_OC_BACKOFF_MAX_SEC` | `16` | Maximum OpenCode subscriber exponential backoff after unchanged `/question` + `/session/<id>/message` polls; resets to `FD_OC_POLL_SEC` on new question ids, response hash change, or daemon bell marker |
| `FD_GRACE_SEC` | `30` | Cold-start grace per pane; bells suppressed during this window |
| `FD_WAKE_PENDING_TTL` | `300` | Wake-pending revert threshold when master crashes mid-turn |
| `FD_MASTER_TURN_TTL` | `3600` | Maximum master turn duration before the busy lock is treated as stale even if the master pane is still alive |
| `FD_ADAPTER_FRESHNESS_TTL` | `5` | Seconds to cache adapter freshness probe results keyed by URL + session/thread; set `0` to disable cache during debugging |
| `FD_SPAWN_MODE` | `detach` | `detach` (setsid+nohup, default) or `tmux-window` (visible in-session daemon window). Recommended `tmux-window` for codex/opencode/pi/omp masters where backgrounding is unreliable |
| `FD_MAX_LIFETIME` | `14400` | Seconds before daemon exec()s itself for a fresh process (0 disables) |
| `FD_STATE_DIR` | `$XDG_RUNTIME_DIR/flightdeck` (or `/tmp/flightdeck-$UID`) | Daemon-private state directory (heartbeat, busy, wake-pending, subscriber pid files). Must be user-owned, mode 0700 |

## Testing

Local tests live under `tests/` (see `tests/README.md`). `tests/live-wake.sh` is the full daemon wake smoke test: it spawns a real Pi master in tmux, starts `flightdeck-daemon --in-tmux-window --master-harness pi`, rings a bash inner-pane bell, then asserts the wake reached Pi through `pi-bridge history` and that the daemon log recorded `harness=pi via=pi-bridge`. Runtime is roughly 2 minutes and requires tmux, a real `pi` binary, GNU bash 5+, GNU date, `jq`, and `git`.

Use `tests/live-wake.sh --no-tmux` for CI-friendly shape checks only. It validates GNU bash/date, executable script paths, and bash syntax without spawning tmux, Pi, or the daemon.

Daemon artifacts can be cleaned between runs with `rm -f /run/user/$UID/flightdeck/fd-*-s*.* /tmp/flightdeck-$UID/fd-*-s*.* 2>/dev/null || true`.

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/start.md` | `start` (from main) | From-main entry: dashboard, issue selection, research evaluation, parallel-check, spawn, enter watch |
| `workflows/start-new.md` | `start new` | Create new issue from main + spawn |
| `workflows/parallel-check.md` | `parallel-check` (also nested from `start.md` § 4) | Verify candidate issue set is safe to spawn in parallel |
| `workflows/watch.md` | `watch` (entry) or invoked at end of `start.md` after spawn | Master oversight loop — initialize state, poll panes, route prompts, plan merges, terminate |
| `workflows/handle-prompt.md` | Nested invocation from `watch` § 3 | Per-pane prompt classification + response |
| `workflows/close-issue.md` | Nested invocation from `watch` § 2 on `terminal-state-reached` | Verify two-signal terminal state, update master state, kill window, deregister pane |
| `workflows/merge-plan.md` | Nested invocation from `watch` § 4 | Conflict-graph build + smallest-first merge ordering |
| `workflows/terminate.md` | Nested invocation from `watch` § 6 | Final summary, new-issues report, next-cycle recommendation, master-state finalization |

## Workflow Execution

These rules apply to flightdeck's boundary workflows (`start.md`, `start-new.md`, `terminate.md`, `close-issue.md`, and per-tag handlers in `handle-prompt.md`). The `watch.md` loop body is reactive by nature — its inner decisions are judgment calls and not subject to these rules.

### Sequential Section Execution

Process sections sequentially. Execute all sub-sections within a section before proceeding to the next. Never skip steps because the outcome seems predictable, or rationalize skipping based on visible state ("nothing changed since last poll", "the summary is obvious", "the user can see this"). The workflow text is the decision authority, not the agent's assessment.

### Nested Workflow Invocation

Nested workflows (marked with `⤵`) must be invoked through the harness's workflow invocation mechanism — never inlined or substituted with ad-hoc commands. If the marker includes a return point (`→ § X`), record it before invoking.

### Format Tags Are Literal

`<output_format>`, `<recommendation_format>`, `<launch_now_format>`, and any other XML-tagged content blocks define exact content for emission. When emitting tagged content:

1. **Fill `[PLACEHOLDERS]`** with actual values.
2. **Omit lines/sections** where the placeholder value is empty or not applicable.
3. **Add nothing else** — no commentary, no extra fields, no rewording, no explanations before or after the content.
4. **Do not paraphrase** — use the exact structure, headings, and field names from the tag.

The user-visible output blocks at the end of `terminate.md` and `close-issue.md` are `<output_format>` tagged for this reason: the agent must emit them in full, not collapse to a summary line.

## Skill Rules — Implementation Constraints

1. **Pane-0 rule applies to every read**. Never call `tmux capture-pane` without an explicit pane index. The `pane-poll` script enforces this.
2. **Combine guidance with response**. Never send sub-agent guidance as a follow-up to an option pick. The `pane-respond` script rejects rebase-multi-choice payloads that don't include the preserve/apply/verify triplet.
3. **Verify-don't-trust**. Never advance an issue's state on an agent's claim alone. Run the verification grep first.
4. **Cleanup scope is anchored to the asking pane's registered worktree**, not to a global "what flightdeck thinks". Extract the path from the prompt text and compare to the registry entry for that pane.
5. **Aggressive autonomy on known shapes; escalate on novel shapes**. The classifier returns a tag for known prompt shapes. Unmatched prompts return `generic-multi-choice` and the handler escalates to user — it does NOT pick the first option.
6. **Daemon-driven wake; no blocking sleeps**. `flightdeck-daemon` (spawned at session start by `watch.md § 1`) is the canonical wake mechanism — it polls inner panes every `FD_POLL_SEC` seconds (default 2) and delivers a per-harness wake payload to the master when any pane needs attention. Master ends each turn after running `flightdeck-daemon ack` (atomic drain + clear-pending) and removing the master-busy lockfile. No `sleep` workaround, no harness scheduler primitive — the daemon owns wake delivery for every harness uniformly.
   - **Wake payload is harness-aware** (see `wake_payload_for_harness` in `flightdeck-daemon`). Codex receives `$flightdeck watch --from-daemon`, Pi receives `/skill:flightdeck watch --from-daemon`, Claude / OpenCode / unset receive `/flightdeck watch --from-daemon`. The daemon `start` call accepts `--master-harness <h>` for this; if omitted, the daemon auto-detects Pi via a `pi-bridge list` cwd match against the master pane and otherwise defaults to the slash form.
   - **Wake transport is harness-aware**. For Pi masters the daemon calls `pi-bridge send --pid <master_pid>` because tmux paste-buffer never reaches Pi's alt-screen input loop; for all other harnesses (and as a fallback when the Pi bridge is unresolved) the daemon uses `tmux load-buffer + paste-buffer + send-keys Enter` against `master_pane_id`.
   - **Claude Code optional**: `ScheduleWakeup({delaySeconds: 1800})` MAY be armed as a defensive fallback ("if daemon dies, wake me"). Not load-bearing.
   - **Other harnesses**: no scheduler needed. The daemon owns wake delivery uniformly via the per-harness payload + transport described above.
7. **All scripts must appear in this SKILL.md's Scripts table.** No "hidden" scripts. README.md mirrors the table for human readers.

## Operational caveats

The daemon (`flightdeck-daemon`) drives wake delivery; the master agent only runs when there's work. Operational caveats worth knowing:

- **Worst-case wake latency on master crash**: `FD_WAKE_PENDING_TTL + FD_POLL_SEC` (default 302s). If master crashes between turn-start and ack-clear, the daemon waits one TTL before reverting in-flight state and re-firing.
- **State directory privacy**: `FD_STATE_DIR` (default `$XDG_RUNTIME_DIR/flightdeck`, fallback `/tmp/flightdeck-$UID`) must be user-owned and mode 0700. Override via env if you need a different location.
- **PID reuse race**: stranded `.draining.<pid>` files and stale `BUSY_FILE` recovery can be delayed if the kernel reuses a PID before next startup GC. Acceptable in practice — startup GC sweeps within seconds of next daemon start.
- **Concurrent flightdecks per tmux session**: refused via flock. One daemon per tmux session_id at a time. Run separate sessions if you need parallel flightdeck instances.

## Compaction Recovery

Master state is persisted on every state mutation. On `watch` re-entry:
1. Read `tmp/flightdeck-state-<SESSION>.json`.
2. Re-fingerprint each registered window's pane 0 (TUIs may have re-laid-out).
3. Recompute per-pane `state` from a fresh capture-pane — never trust the persisted `state` value alone.
4. Resume the merge queue from where it left off; recompute the conflict graph against current PR file lists (PRs may have moved).
5. Re-evaluate any `paused_for_user` entry — if the user has acted in the pane in the meantime, reclassify and proceed.

The `unknown_since` timer survives compaction so the force-merge clock isn't reset.
