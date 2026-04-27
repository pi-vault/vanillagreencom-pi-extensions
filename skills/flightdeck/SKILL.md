---
name: flightdeck
description: "Master session lifecycle for multi-issue parallel dev work: dashboard, spawn, oversee tmux panes, answer prompts, plan merges, drive every tracked issue to merged or aborted."
license: MIT
user-invocable: true
dependencies:
  required: [github, linear, project-management]
  optional: [worktree]
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

> **MODE SWITCH**: Loading this skill puts you in **master mode**. You are NOT a dev agent. You do not write code in any worktree, you do not run cargo/npm/builds, and you do NOT invoke per-issue orchestration workflows directly. Your role is **observe-and-direct**: from the moment a user invokes flightdeck's `start` from main, you own the master arc — dashboard → research/plan evaluation → spawn (`open-terminal`) → watch loop → merge planning → unwind. Per-issue work happens entirely inside the spawned panes; you observe their prompts via `tmux capture-pane`, query PR/issue facts via `gh` and `linear`, and direct the per-issue agents by sending responses to their prompts. You never run `bot-review-wait`, `ci-wait`, `merge-pr`, or any other orchestration workflow yourself.
>
> **Pause for the user only on**: detected scope creep that requires reverting an agent's work, force-merging when a real content conflict exists (not just `UNKNOWN`), aborting an issue, flightdeck mutating `main` directly via raw `gh pr merge` when no orchestrator pane is alive to drive it, or a novel prompt shape no rule covers.
>
> **Architectural boundary**: flightdeck does NOT re-implement gates that orchestration owns. When the orchestrator surfaces a prompt (merge-now, audit-relation, fix-suggestions, etc.), its upstream conditions have already been checked — that's why it's asking. Master answers the prompt; it does not re-validate CI / mergeable / thread state. The only checks master adds are ones master alone has (cross-session conflict graph, multi-pane scope drift). Don't conflate "the orchestrator is asking permission to mutate main" with "flightdeck would be mutating main directly" — they're different actions.
>
> Flightdeck is multi-harness. The same logic applies whether the spawned pane is opencode, claude code, codex, pi, or any future TUI. Pane-0 targeting and capture-pane sentinel matching abstract over the harness.

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

## Scripts

```bash
.agents/skills/flightdeck/scripts/<script> [args]
```

| Script | Purpose |
|--------|---------|
| `open-terminal` | Launch worktree(s) for one or more issues with auto-detected harness — **never hand-roll tmux/terminal commands; use this for every session spawn** |
| `parallel-groups` | Read/manage parallel issue groups |
| `flightdeck-state` | Master-state CRUD wrapper — atomic init/get/set/append/increment for `tmp/flightdeck-state-<TMUX_SESSION>.json` |
| `pane-registry` | Issue↔pane mapping CRUD (init from spawned issue list, list, update state per issue, reconcile against live tmux windows to drop stale entries) |
| `pane-poll` | Single-window status read: bell flag + `capture-pane -t <session>:<window>.0 -p -S -200` + classify |
| `pane-respond` | Send a response to a pane. Three modes: positional `<payload>` for free-text, `--option N` for numeric option pick (harness-aware: Claude Code uses arrow navigation, NOT digit-as-shortcut), `--keys k1,k2,...` for multi-step forms (toggle / advance page / submit). Validates rebase-multi-choice payloads include the preserve/apply/verify triplet |
| `pane-clear-bell` | Atomic chained-command bell clear (no flicker) |
| `pr-conflict-graph` | Build file-intersection adjacency for a list of PR numbers via `gh pr view --json files` |
| `prompt-classify` | Regex/sentinel matcher mapping a captured prompt buffer to a handler tag (`cleanup-prompt`, `bot-review-wait-stuck`, `rebase-multi-choice`, `audit-relation-prompt`, `merge-ready-but-unknown`, `scope-creep-detected`, `generic-multi-choice`, `rendering`) |

## Schema — master state

`tmp/flightdeck-state-<TMUX_SESSION_ID>.json` is keyed by tmux session ID. It survives compaction and is rehydrated on `watch` re-entry.

```json
{
  "session_id": "<TMUX_SESSION_NAME>",
  "started_at": "<ISO8601>",
  "terminated": false,
  "issues": {
    "<ISSUE_ID>": {
      "window": "<window-name>",
      "pane_target": "<TMUX_SESSION>:<window>.0",
      "harness": "claude|opencode|codex|...",
      "worktree": "<absolute path>",
      "pr_number": 0,
      "state": "prompting",
      "substate": "merge-ready-but-unknown",
      "unknown_since": "<ISO8601>",
      "last_capture_hash": "sha256:...",
      "last_response_at": "<ISO8601>",
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

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLIGHTDECK_POLL_INTERVAL` | `30` | Seconds between poll cycles in `watch.md` § 2 |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | `240` | UNKNOWN-state wait threshold before considering force-merge (predicate also requires APPROVED + green + disjoint) |
| `FLIGHTDECK_STATE_DIR` | `tmp` | Override for master-state file directory |
| `FLIGHTDECK_DEBOUNCE_CYCLES` | `2` | Consecutive poll cycles required for "all-done" termination check |
| `FLIGHTDECK_AUTO_MERGE` | `1` | When `0`, the `merge-now` handler escalates instead of auto-answering. For sessions where the human gate is desired (compliance, big-blast-radius PRs) |
| `FLIGHTDECK_HIJACK_GRACE_SECS` | `90` | Seconds after spawn that master tolerates no orchestration `workflow-state-<ISSUE>.json` before escalating "orchestration-never-started". Catches hijacked panes / failed launches. |

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
6. **No blocking sleeps**. The harness blocks long `sleep` calls and they burn the prompt cache for no work. Yield via the harness's scheduler primitive between poll cycles and end the turn — the harness wakes you when the delay elapses.
   - **Claude Code**: `ScheduleWakeup({delaySeconds, prompt, reason})` — pass the same workflow input verbatim so the next firing re-enters this loop.
   - **Other harnesses**: use the equivalent (codex/opencode each have their own scheduling tool). If the harness has none, document the fallback in `patterns/tmux-monitoring.md` for that harness's adapter; do NOT introduce a `sleep` workaround.
7. **All scripts must appear in this SKILL.md's Scripts table.** No "hidden" scripts. README.md mirrors the table for human readers.

## Compaction Recovery

Master state is persisted on every state mutation. On `watch` re-entry:
1. Read `tmp/flightdeck-state-<SESSION>.json`.
2. Re-fingerprint each registered window's pane 0 (TUIs may have re-laid-out).
3. Recompute per-pane `state` from a fresh capture-pane — never trust the persisted `state` value alone.
4. Resume the merge queue from where it left off; recompute the conflict graph against current PR file lists (PRs may have moved).
5. Re-evaluate any `paused_for_user` entry — if the user has acted in the pane in the meantime, reclassify and proceed.

The `unknown_since` timer survives compaction so the force-merge clock isn't reset.
