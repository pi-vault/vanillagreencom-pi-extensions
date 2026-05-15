---
name: flightdeck
description: "Generic tmux session manager for AI harness panes; optional issue mode supervises issue/PR workflows, prompt handling, merge planning, and unwind."
license: MIT
user-invocable: true
dependencies:
  required: []
  optional: [decider, github, linear, project-management, worktree]
metadata:
  author: vanillagreen
  version: "0.2.0"
---

# Flightdeck

> If you're modifying flightdeck scripts, the daemon, or `lib/flightdeck-core/` — read [`DEVELOPMENT.md`](./DEVELOPMENT.md) first for the test workflow, debugging entry points, and operational caveats.

## STOP — Required Setup

1. Verify `$TMUX` is set for every Flightdeck command. If unset, **exit immediately with no-op**: print `Flightdeck requires tmux; skipping.` and return control to the caller. Flightdeck does nothing outside tmux.
2. Determine the command mode before loading dependencies:
   - Generic session commands (`session start`, `session attach`, `session watch`, `session status`, `session stop`, `session remove`) require only tmux plus the selected harness adapter (`pi-bridge`, OpenCode HTTP, Claude Channels, Codex app-server, or tmux fallback). Do **not** load `github`, `linear`, `project-management`, or `worktree` for generic session commands.
   - Issue workflow commands (`start [ISSUE_ID]`, `start new`, `parallel-check`, issue `watch`, `merge-plan`, `close-issue`, `terminate` when any tracked entry is `kind=issue`) load `github`, `linear`, `project-management`, and `worktree` on demand. Redundant loads are no-ops.
3. If an issue workflow dependency cannot be loaded after entering issue mode, stop and tell the user. Do not proceed with issue/PR/worktree actions without it.

---

## Dependency modes

Core Flightdeck is a generic session manager. It requires tmux and the harness adapters needed for the tracked panes only; it does not require GitHub, Linear, project-management, or worktree skills.

### Issue-mode dependencies (load when entering issue workflows)

- `github` — PR inspection, merge state, checks, review threads, file lists.
- `linear` — issue metadata, created follow-ups, cycle/todo recommendation checks.
- `worktree` — issue branch/worktree ownership and cleanup scope.
- `project-management` — cycle planning, audits, roadmaps, research issue wrappers used by issue workflows.

`decider` remains optional for agents that want an extra decision aid, but core session management does not require it.

---

## Mode

You are in **master mode**. Observe-and-direct only.

Generic session mode is the core path: launch/attach with `flightdeck-session`, supervise with `session-watch.md`, answer generic prompts, and summarize sessions. It skips issue selection, research/plan evaluation, `open-terminal`, merge planning, GitHub/Linear/worktree actions, and project-management flows.

Issue-mode global arc begins only after entering an Issue workflows command:

- **You do NOT** write code in worktrees, run builds/tests, or invoke per-issue orchestration workflows (`bot-review-wait`, `ci-wait`, `merge-pr`, etc.). Per-issue work happens inside the spawned panes; you supervise.
- **You DO** own the issue-mode master arc end to end — dashboard → research/plan evaluation → spawn (`open-terminal`) → watch loop → merge planning → unwind — and answer prompts that surface from the spawned panes via `pane-respond`.
- **You communicate with spawned agents through their native channels**: opencode via HTTP `/session/<id>/message`, claude via Channels MCP push + JSONL tail, pi via Unix-socket bridge, codex via JSON-RPC over WebSocket. `pane-respond` routes into the matching send path. Tmux `capture-pane` / `send-keys` is only the fallback when the channel is unavailable (see `patterns/tmux-monitoring.md`).
- **You pause for the user only on**: scope creep that requires reverting agent work, force-merging against a real content conflict (not `UNKNOWN`), an issue abort, flightdeck mutating `main` directly when no orchestrator pane is alive, or a novel prompt shape no rule covers.
- **You do NOT re-implement orchestration gates**. When the orchestrator surfaces a prompt (merge-now, audit-relation, fix-suggestions), its upstream conditions are already checked. Answer the prompt; don't re-validate CI / mergeable / thread state. The only checks master adds are cross-session conflict graph and multi-pane scope drift — things only master sees.

## Commands

Use the session-management table for the core Flightdeck product: tracked tmux-window sessions, harness IO, generic prompts, and summaries. Use the issue-workflow table only after the user enters the issue/PR/worktree domain; those workflows layer on `session-watch.md` / `session-handle-prompt.md` rather than replacing them.

### Session management

Generic tmux-window session tracking. These commands do not require a fake issue id.

| Command | Arguments | Workflow / Script | Notes |
|---------|-----------|-------------------|-------|
| `session start` | `--session-id <ID> --title <T> --cwd <path> --harness <H> (--cmd <cmd> \| --prompt <text>) [--kind adhoc\|workflow]` | `scripts/flightdeck-session start` | Creates a new tmux window (never a split), launches the command/harness, sets `FLIGHTDECK_MANAGED=1` + `FLIGHTDECK_CHILD_PANE=1`, and records a generic `.entries[ID]` row. Pi `--prompt` launch starts `pi` directly and records bridge metadata when discovery succeeds. |
| `session attach` | `--pane <%PANE_ID> --harness pi --title <T> [--session-id <ID>] [--kind adhoc]` | `scripts/flightdeck-session attach` | Attaches an existing pane without launching a new window. For Pi, probes `pi-bridge` by pane pid and records `pi_session_id`/socket metadata when available. |
| `session watch` | `[ENTRY_ID...]` | `workflows/session-watch.md` | Generic daemon/poll/handler loop for tracked entries. Routes only generic handlers and guards issue-only tags as `domain-mismatch`; no GitHub/Linear/worktree dependency. |
| `session prompt routing` | nested from `session watch` | `workflows/session-handle-prompt.md` | Generic prompt handlers for structured questions, bash permission prompts, safe bounded choices, terminal completion, `pi-bg-task-exit`, and `domain-mismatch`. |
| `session status` | — | inline / `flightdeck-state tracked-entries` | Read-only normalized `.entries` snapshot. |
| `session stop` / `session remove` | `<ENTRY_ID>` | `pane-registry teardown-entry` / `pane-registry remove` | Teardown uses stable `pane_id` and accepts the issue-mode lifecycle (`merged|aborted|dead`) plus the generic lifecycle (`complete|cancelled`) as terminal states. `remove` drops the `.entries` row. |

### Issue workflows

Issue/PR/worktree workflows. Entering these commands loads the issue-mode dependencies on demand.

| Command | Arguments | Workflow | Notes |
|---------|-----------|----------|-------|
| `start` | `[ISSUE_ID]` | `workflows/start.md` | From-main issue entry. Dashboard, issue selection, research evaluation, parallel-check, spawn (`open-terminal`), enter issue watch loop. |
| `start new` | `[title]` | `workflows/start-new.md` | Create new issue + spawn through the issue workflow path. |
| `start self` | — | inline | Initialize master issue session only, await further issue commands. |
| `parallel-check` | `[ISSUE_IDS]` | `workflows/parallel-check.md` | Verify a candidate issue set is safe to spawn in parallel. |
| `watch` | `[ISSUE_IDS]` | `workflows/watch.md` → `workflows/session-watch.md` | Issue-mode extension over the generic loop. Tracks issue-specific lifecycle states, routes PR/Linear/worktree handlers, and resumes merge planning. |
| `merge-plan` | — | `workflows/merge-plan.md` | Build PR conflict graph and choose smallest-safe merge order for issue entries. |
| `close-issue` | `<ISSUE_ID>` | `workflows/close-issue.md` | Verify terminal issue outcome, record issue fields, and tear down the issue window safely. |
| `terminate` | — | `workflows/terminate.md` | If any tracked entry is `kind=issue`, produce the issue/PR/new-issue recommendation summary; mixed sessions also include generic session summary. |
| `status` | — | inline | Print current pane registry + state machine snapshot from `tmp/flightdeck-state-<TMUX_SESSION>.json`. Read-only. |

### Planning (cross-call to `project-management`, issue mode only)

| Command | Workflow | Notes |
|---------|----------|-------|
| `cycle-plan` | `⤵ .agents/skills/project-management/workflows/cycle-plan.md` | TPM-driven cycle planning |
| `audit-issues` | `⤵ .agents/skills/project-management/workflows/audit-issues.md` | Issue audit (project / project-order / issue [IDs] / --issues file) |
| `roadmap plan` / `create` | `⤵ .agents/skills/project-management/workflows/roadmap-plan.md` / `roadmap-create.md` | Roadmap planning + execution |
| `research-spike` | `⤵ .agents/skills/project-management/workflows/research-spike.md` | Initiate a research issue with assets |
| `research-complete` | `⤵ .agents/skills/project-management/workflows/research-complete.md` | Route a completed research issue |

## Skill Rules

Decision rules grouped by domain. Each pattern doc under `patterns/` has the full context, examples, and edge cases — the bullets below are the quick-reference rules. Read the matching pattern doc whenever its prompt class appears.

### Tmux monitoring (`patterns/tmux-monitoring.md`)

- **Pane-0 rule**: every read targets `<session>:<window>.<idx>` explicitly (enforced by `pane-poll`). Default-pane captures break when sub-agents spawn additional panes. Index is pinned per window at registry init via fingerprinting.
- **Bell clearing** after sending input — atomic chained idiom (no flicker, enforced by `pane-respond` / `pane-clear-bell`):
  ```
  tmux select-window -t <session>:<window> \; select-window -t <ORIG>
  ```
- **Capture-pane scrollback**: `-S -200` for classification (enough for prompt + options, not the whole buffer).

### Prompt handlers (`patterns/prompt-handlers.md`)

- **Cleanup scope** — answer YES iff the target path equals the asking pane's registered worktree. NEVER for sibling worktrees (parallel sessions still using them). Extract the path from the prompt text and compare to the registry entry. Some agents propose batch cleanup; that's wrong.
- **Combine guidance with the option pick** — when picking an option triggers immediate sub-agent delegation (rebase, fix), the sub-agent guidance must ride in the SAME input. `pane-respond` rejects rebase-multi-choice payloads missing the preserve/apply/verify triplet.
- **Bot-review prompt response** — on a Skip/Wait/Abort prompt, decide from `gh pr view <PR> --json statusCheckRollup,reviewDecision,labels`. Skip if the bot check is `SUCCESS` and `reviewDecision == APPROVED` (or unset with no pending reviewers). Real pending reviewer → escalate. Master never re-invokes `bot-review-wait` itself.
- **Rebase-multi-choice guidance** — payload must follow the **preserve / apply / verify** triplet:
  - **Preserve**: function signatures / parameter splits / new wrappers from the upstream merge that must NOT be reverted.
  - **Apply**: field renames / type updates / local refactors that go ON TOP of the preserved shape.
  - **Verify**: the exact test invocation proving both sides intact.
- **Parent vs related** (audit prompts) — accept `child of <current-PR-issue>` when scopes don't intersect another live worktree's PR files (expansion bias). Reject → use `related` or pick a different parent. Capture each new issue's proposed parent/project/scope at decision time for the end-of-session report.
- **Verify-don't-trust** — never advance an issue's state on an agent's claim alone. After any structural change (rebase done, conflicts resolved, fields renamed), run a verification grep against the worktree. For rebases: check function signatures and rename counts in every conflict file.

### Conflict detection (`patterns/conflict-detection.md`)

- **`defer-ci`** label blocks heavy CI lanes (Lint, Cross-Platform, Linux Integration, Bench, Fixture Sync) but NOT bot reviews. Bot review runs with `defer-ci`; CI runs after the label drops.
- **File-level conflict graph** — build edges from `gh pr view <N> --json files`. Two PRs with file-set intersection conflict; merge order is topological + smallest-scope-first.
- **UNKNOWN-state timer** — GitHub's `mergeStateStatus` stays `UNKNOWN` for minutes after upstream `main` moves. Force-merge predicate: `APPROVED ∧ all_checks_in {SUCCESS, SKIPPED} ∧ disjoint(PR_files, main_files_recently_changed) ∧ unknown_since > FLIGHTDECK_FORCE_MERGE_AFTER_SECS`.

### Decision biases (`patterns/decision-biases.md`)

- **Scope-creep detector** — `scope_files_actual` (from `gh pr view --json files`) vs `scope_files_declared` (parsed from issue description). `actual > 2× declared` → escalate. Don't auto-revert.
- **Smaller-PR-first** — when two PRs overlap, the smaller one merges first; the bigger absorbs the rebase. Reverse order forces the smaller PR to rebase against a bigger restructure.
- **Rule of three** — don't extract a shared helper across <3 sibling files. At 2 sites the abstraction shape isn't visible; at 3 the rule is satisfied.
- **Expansion bias** — prefer inline fixes in the current PR over new issues, UNLESS the reason is concrete (different scope, different agent, requires measurement, blocked dep, architectural decision). "Tidiness" is not a reason.
- **Merge-order tiebreakers**: (1) smallest scope first, (2) overlapping files: smaller first, (3) else: any order.

### Structured questions (`patterns/opencode-questions.md`, `patterns/pi-questions.md`)

- **Never pass off-list labels.** Pick `--answer` / `--answer-multi` values from `question.questions[i].options[].label`. Pi `--answer-text` only when the matching tab has `allowCustom=true`; opencode free-form requires `--reject` + a follow-up `opencode run --attach --session <SID> "<text>"`.
- **Pi inner agent completions** are advisory. Re-poll the outer orchestrator only; never call `subagent`/`steer_subagent`/`get_subagent_result` against an orchestrator's inner panes.

## Scripts

```bash
.agents/skills/flightdeck/scripts/<script> [args]
```

**Implementation:** Most scripts are TypeScript under
`skills/flightdeck/lib/flightdeck-core/`. Trampolines under `scripts/`
exec `bun .../src/bin/<script>.ts`; `flightdeck-dashboard` is the Rust dashboard trampoline under `lib/flightdeck-dashboard/`. `bun` remains a hard runtime dependency for the TypeScript scripts.
Functional + integration tests live under `lib/flightdeck-core/tests/`.

| Script | Purpose |
|--------|---------|
| `open-terminal` | Spawn issue worktree(s) with selected harness + optional `--model`/`--effort`. **Never hand-roll issue tmux/terminal commands — use this for issue workflow spawns.** Tmux fallback now delegates to `flightdeck-session` in issue mode. |
| `flightdeck-session` | Generic session launcher/attacher. `start` creates a tmux window and registers `.entries[id]`; `attach` records an existing Pi pane by stable pane id. |
| `parallel-groups` | Read/manage parallel issue groups. |
| `flightdeck-state` | Atomic CRUD on `tmp/flightdeck-state-<TMUX_SESSION>.json` (`init`/`get`/`set`/`append`/`increment`/`tracked-entries`/`write-entry`/`archive`) and master-busy lock (`master-busy lock\|unlock\|check`). See `workflows/session-watch.md` § 1 for lock semantics. |
| `flightdeck-daemon` | External wake driver. Polls inner panes, normalizes turn-end events, wakes master with a per-harness payload. Actions: `start \| stop \| status \| health \| events \| ack`. `start` exits `4` for stale `--master` (distinct from usage/missing dependency exit `2`). Master respawn trigger: `status --session <S>` says `no daemon` while live entries exist; source panes via `pane-registry list --format inner-panes-live` / `inner-harnesses-live`, re-resolve `$TMUX_PANE` and retry once on exit `4`, and do not yield on unresolved start failure. Full contract: `workflows/session-watch.md` § 1 / § 6; adapter freshness: `patterns/tmux-monitoring.md`. |
| `flightdeck-dashboard` | Rust/ratatui dashboard. Phase 1 supports `tui --demo[=NAME]` with compiled fixtures, six tabs, help overlay, and snapshot-tested motion skeleton. Other subcommands are reserved and exit `2` until later phases. |
| `codex-app-server-spawn` / `-stop` | Idempotent bring-up/teardown of the per-session codex `app-server --listen ws://...` shared by all `codex --remote` panes. |
| `pane-registry` | TrackedEntry↔pane mapping CRUD. `init-entry` writes `.entries[id]`; `init <ISSUE>` is an alias for `init-entry --kind issue`. `find-by-pane` emits `{id,kind}` JSON. `list --format json\|inner-panes\|inner-harnesses\|inner-panes-live\|inner-harnesses-live` feeds `pane-poll --batch -` and `flightdeck-daemon start`; use the `*-live` pair for daemon respawn. |
| `pane-poll` | Pane state read. Preferred: `--batch -` from `pane-registry list --format json` (one JSONL object per tracked entry). Passes `kind` to `prompt-classify` so issue-only tags on ad-hoc entries become `domain-mismatch`. Legacy single-pane mode for drift re-polls / manual debug. See `patterns/tmux-monitoring.md` for per-harness adapter routes. |
| `pane-respond` | Send response to a pane. Modes: free-text payload, `--option N`, `--option-multi`, `--keys` (rejected without `--keys-allow-tmux`), `--question <reqID> --answer\|--answer-multi\|--answer-text\|--answers-json\|--reject`. Validates rebase-multi-choice payloads for the preserve/apply/verify triplet. See `patterns/prompt-handlers.md` for mode selection and `patterns/opencode-questions.md` / `patterns/pi-questions.md` for question routing. |
| `pane-clear-bell` | Atomic chained-command bell clear (no flicker). |
| `pr-conflict-graph` | File-intersection adjacency for a list of PR numbers via `gh pr view --json files`. |
| `prompt-classify` | Regex/sentinel + computed-tag matcher mapping pane state to a handler tag: `rendering`, `terminal-state-reached`, `bash-permission-prompt`, `force-merge-confirm`, `merge-ready-but-unknown`, `merge-now`, `bot-review-wait-stuck`, `rebase-multi-choice`, `force-push-prompt`, `cleanup-prompt`, `audit-relation-prompt`, `descope-related`, `external-fix-suggestions`, `cycle-fix-suggestions`, `scope-creep-detected` [computed], `multi-select-tabbed`, `awaiting-direction`, `generic-multi-choice`, `domain-mismatch`, `idle`. `--entry-kind` guards issue-only tags on non-issue entries; omitted kind and `--entry-kind-unknown` fail closed as `domain-mismatch`. Daemon/event-only tags: `oc-question`, `pi-question`, `pi-subagent-completion`, `pi-bg-task-exit`, `daemon-exited`.

`pi-bg-task-exit` (vstack#15): the Pi subscriber matches `pi-bridge stream` events of shape `{ type: "event", event: "message_end", data.message.customType: "vstack-background-tasks:event", data.message.details.eventType: "exit" }` and appends a canonical wake row to `WAKE_EVENTS_LOG`:

```
{"ts":"<iso>","pane_id":"%18","harness":"pi","event_type":"bg-task-exit","task":{"id":"bg-3","status":"failed","exitCode":null,"command":"...","outputBytes":89},"classifier_tag":"pi-bg-task-exit","hash":"<12hex>"}
```

The daemon (`lib/flightdeck-core/src/daemon/loop.ts`) treats the tag as canonical, appends to the per-session events file via `appendEvent`, extends `WAKE_PENDING.in_flight`, and wakes master. Master routes through `workflows/session-watch.md` § 2 → `workflows/session-handle-prompt.md` § 7; issue mode may then resume `workflows/handle-prompt.md` § 4 for PR/CI/bot-review recovery. The classifier never sees these messages — they are system-role customType messages, not assistant text — so `prompt-classify` has no matching tag and only the daemon path produces them.

`daemon-exited`: the daemon emits this lifecycle row during cleanup when it exits for `master-gone`, `signal-term`, `signal-int`, or another recorded reason. It writes directly to the per-session `EVENTS_FILE` under `SESSION_LOCK` (not `WAKE_EVENTS_LOG`), with `pane_id` set to the master pane id so pane-keyed drains include it:

```
{"ts":"<iso>","pane_id":"%25","event_type":"daemon-exited","reason":"master-gone","master_id":"%25","pid":12345,"hash":"<12hex>","tag":"daemon-exited","stable_age_sec":0,"details":{"event_type":"daemon-exited","reason":"master-gone","master_id":"%25","pid":12345}}
```

`session-watch.md` routes `daemon-exited` as a daemon-lifecycle signal, not a pane-prompt classification. It records the reason and follows the master respawn flow in `workflows/session-watch.md` § 1 / § 6 before yielding.

## Schema — master state

Master state lives at `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<TMUX_SESSION_NAME>.json` (default `tmp/`). Survives compaction; rotated to `*-<terminated_at>.json.archive` on terminate (see `terminate.md § 6`). The archive preserves the full session history (including merged-issue `decisions_log`, `pr_number`, `merge_commit`) so post-completion dashboards and post-mortem inspection have the whole session history — do not call `pane-registry remove-merged` between `set terminated true` and `archive`. pi-flightdeck's `buildSnapshot` falls back to the newest matching `*.json.archive` when the live file is gone, so the completed-session view in the dashboard / popup keeps rendering until a new `flightdeck start` rewrites the live file. Daemon-private files in `FD_STATE_DIR` are keyed by `SESSION_KEY=s<N>` instead (see `patterns/tmux-monitoring.md`).

Auto-archive on session start: `flightdeck-session start` rolls the live file to a `.json.archive` sibling before fresh init when (a) `terminated == true` or (b) the file has tracked entries but ZERO `pane_id` is currently alive in tmux. Removes the need to manually prune leftover state from prior tmux sessions or crashed masters.

Readers call `readTrackedEntries(state)` to get the canonical `TrackedEntry` map. Malformed non-object entry values are skipped with a stderr warning; malformed internal `entry.id` values warn and fall back to the map key. `writeTrackedEntry(state, id, entry)` validates non-empty ids (including `entry.domain.issue.id` when present) and writes `.entries[id]`. Issue-mode metadata lives under `entry.domain.issue` (`pr_number`, `worktree`, `merge_commit`, etc.); the pi-flightdeck renderer surfaces that nested view alongside the top-level tracked-entry state.

```json
{
  "session_id": "<TMUX_SESSION_NAME>",
  "started_at": "<ISO8601>",
  "terminated": false,
  "owner": {
    "harness": "claude|opencode|codex|pi|unknown",
    "pane_id": "%25",
    "pane_target": "<TMUX_SESSION>:<window>.<pane>",
    "cwd": "<absolute cwd>",
    "pid": 1752875,
    "pi_session_id": "<pi-session-id-or-null>",
    "pi_bridge_socket": "<pi-bridge-socket-or-null>",
    "discovery_error": "<warning-or-null>"
  },
  "entries": {
    "<ENTRY_ID>": {
      "id": "<ENTRY_ID>",
      "title": "<human label>",
      "kind": "adhoc|issue|workflow",
      "state": "waiting|prompting|submitting|ready|complete|cancelled|dead",
      "substate": null,
      "harness": "claude|opencode|codex|pi|unknown",
      "cwd": "<absolute cwd>",
      "window": "<window-name-or-index>",
      "pane_target": "<TMUX_SESSION>:<window>.<pane>",
      "pane_id": "%403",
      "launch": { "model": "<model-or-null>", "effort": "<effort-or-null>", "cmd": "<command-or-null>" },
      "adapter": {
        "pi_bridge_pid": 0, "pi_bridge_socket": "<path-or-null>", "pi_session_id": "<id-or-null>",
        "oc_url": "<server-url-or-null>", "oc_session_id": "<id-or-null>",
        "cc_url": "<server-url-or-null>", "cc_transcript": "<path-or-null>",
        "cx_ws": "<ws-url-or-null>", "cx_thread_id": "<id-or-null>"
      },
      "domain": {
        "issue": {
          "id": "<ISSUE_ID>",
          "worktree": "<absolute path>",
          "pr_number": 0,
          "scope_files_declared": 5,
          "scope_files_actual": 27,
          "orchestration_started": true
        }
      },
      "last_capture_hash": "sha256:...",
      "last_response_at": "<ISO8601>",
      "spawned_at": "<ISO8601>",
      "last_polled_at": "<ISO8601>",
      "decisions_log": []
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

Tracked entry state enum: `state ∈ {waiting, prompting, submitting, ready, complete, cancelled, dead}`. Issue-mode workflows additionally use `{merge-ready, merged, aborted}` for issue-specific lifecycle states; these still map onto the generic enum via `domain.issue.phase` / `domain.issue.outcome` (e.g. `merged → complete + outcome="merged"`). `entryIdForIssue(issueId)` returns the issue id unchanged after validation (empty/invalid ids return null); `issueIdForEntry(entry)` reads `entry.domain.issue.id` or, for `kind: "issue"`, `entry.id`. `owner` is metadata written by `flightdeck-state init`; `owner.pid` is the owner harness PID supplied by `FLIGHTDECK_OWNER_PID` (falling back to parent PID), and `owner.discovery_error` records Pi bridge metadata lookup failures when the owner harness is Pi. pi-flightdeck uses `owner.pane_id` to keep the persistent dashboard owner-scoped by default. `paused_for_user` carries `{entry_id|issue_id, reason, prompt_text}` when a guard or issue-mode pause fires.

## Configuration

Master-loop env vars consulted by workflows:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | `240` | UNKNOWN-state wait threshold before considering force-merge (predicate also requires APPROVED + green + disjoint) |
| `FLIGHTDECK_STATE_DIR` | `tmp` | Project-relative master-state file directory |
| `FLIGHTDECK_DEBOUNCE_CYCLES` | `2` | Consecutive poll cycles required for "all-done" termination check |
| `FLIGHTDECK_AUTO_MERGE` | `1` | When `0`, the `merge-now` handler escalates instead of auto-answering. For sessions where the human gate is desired (compliance, big-blast-radius PRs) |
| `FLIGHTDECK_HIJACK_GRACE_SECS` | `90` | Seconds after spawn that master tolerates no orchestration `workflow-state-<ISSUE>.json` before escalating "orchestration-never-started". Catches hijacked panes / failed launches. |
| `FLIGHTDECK_LAUNCH_MODEL` | unset | Default `open-terminal --model` override when the workflow/user does not pass `--model`. |
| `FLIGHTDECK_LAUNCH_EFFORT` | unset | Default `open-terminal --effort` / thinking override when the workflow/user does not pass `--effort`. |

Daemon tuning (`FD_*`) is in README.md. Most `FD_*` knobs run inside the
daemon and do not affect master operation directly, but two are
consulted on the master poll path through the TS `pane-poll`:
`FD_ADAPTER_READ_TIMEOUT_SEC` (default `2`, fractional values honored)
caps each adapter read subprocess so one stale adapter cannot dominate
a tick, and `FD_ADAPTER_FRESHNESS_TTL` (default `5`) gates freshness
probe caching.

Additional tuning:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FD_ADAPTER_READ_TIMEOUT_SEC` | `2` | Bounds per-adapter read subprocesses in `pane-poll` (fractional values honored). Stale adapters fall through to tmux capture rather than wedging the tick. |

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `workflows/start.md` | `start` (from main) | From-main entry: dashboard, issue selection, research evaluation, parallel-check, spawn, enter watch |
| `workflows/start-new.md` | `start new` | Create new issue from main + spawn |
| `workflows/parallel-check.md` | `parallel-check` (also nested from `start.md` § 4) | Verify candidate issue set is safe to spawn in parallel |
| `workflows/session-watch.md` | `session watch`, and core loop invoked by issue `watch` | Generic state init, entry reconciliation, daemon spawn/ack/yield, polling, generic prompt routing, compaction recovery |
| `workflows/session-handle-prompt.md` | Nested invocation from `session-watch` / issue `watch` for generic tags | Generic prompt response surface; no PR/Linear/GitHub/worktree dependency |
| `workflows/watch.md` | `watch` (issue entry) or invoked at end of `start.md` after spawn | Issue-mode extension over `session-watch`: load issue skills, track issue-specific lifecycle states, route issue-only handlers, plan merges, terminate |
| `workflows/handle-prompt.md` | Nested invocation from issue `watch` for issue-only tags | PR/Linear/worktree prompt response surface only |
| `workflows/close-issue.md` | Nested invocation from `watch` § 2 on `terminal-state-reached` | Verify two-signal terminal state, update master state, kill window, keep registry entry for terminate reporting/final cleanup |
| `workflows/merge-plan.md` | Nested invocation from `watch` § 4 | Conflict-graph build + smallest-first merge ordering |
| `workflows/terminate.md` | Nested invocation from issue `watch` or generic session unwind | Generic session summary for ad-hoc/workflow entries; issue/PR/new-issues recommendation summary when any issue entry exists; master-state finalization |

## Workflow Execution

These rules apply to flightdeck's boundary workflows (`start.md`, `start-new.md`, `terminate.md`, `close-issue.md`, and per-tag handlers in `session-handle-prompt.md` / `handle-prompt.md`). The `session-watch.md` generic loop and `watch.md` issue extension are reactive by nature — their inner decisions are judgment calls and not subject to these rules.

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

The user-visible output blocks at the end of `terminate.md` (`<generic_output_format>` / `<empty_output_format>` / `<issue_output_format>`) and `close-issue.md` (`<output_format>`) are tagged for this reason: the agent must emit them in full, not collapse to a summary line.

## Implementation Constraints

1. **Aggressive autonomy on known shapes; escalate on novel shapes.** The classifier returns a tag for known prompt shapes. Generic `generic-multi-choice` uses the bounded safe policy in `session-handle-prompt.md`; issue-only prompts use `handle-prompt.md`. Both escalate when options are destructive, ambiguous, or genuinely novel. They do NOT blindly pick the first option.
2. **Daemon-driven wake; no blocking sleeps.** `flightdeck-daemon` (spawned by `session-watch.md` § 1; issue `watch.md` reuses that core loop) owns wake delivery for every harness. Master ends each turn after `flightdeck-daemon ack` + `flightdeck-state master-busy unlock`. Never `sleep`. Wake payload reference: `/flightdeck` (claude/opencode/default), `$flightdeck` (codex), `/skill:flightdeck` (pi). Claude Code MAY optionally arm `ScheduleWakeup({delaySeconds: 1800})` as a defensive fallback.
3. **Pi dashboard is read-only and additive.** Optional `pi-flightdeck` extension renders mission-control UX from the on-disk artifacts master already writes; never bypasses the schema. No harness-specific shortcuts that bypass the on-disk schema in other harnesses either. See README.md.
4. **One daemon per tmux session.** Concurrent flightdecks within the same tmux session are refused via flock. Run separate sessions for parallel flightdeck instances.
5. **All scripts must appear in this SKILL.md's Scripts table.** No "hidden" scripts. README.md mirrors the table for human readers.

## Compaction Recovery

Master state is persisted on every state mutation and rehydrated on watch re-entry. Generic entry reconciliation and daemon recovery live in `workflows/session-watch.md` § 6; issue-specific recovery (pane fingerprinting, `unknown_since`, conflict graph, and paused issue re-evaluation) lives in `workflows/watch.md` § 8.
