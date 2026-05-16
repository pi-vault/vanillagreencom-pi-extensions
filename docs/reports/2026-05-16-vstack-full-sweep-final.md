# vstack full sweep + upstream workarounds — final report (2026-05-16)

End-state report for the W4 (flightdeck dashboard + rich activity), W5 (issue sweep), upstream workarounds, and #74 perf fix. Updates `docs/reports/2026-05-15-github-issues-sweep.md`.

## Outcome

- **5 PRs merged** to `main`:
  - **#64** `flightdeck-dashboard-rust` — Rust dashboard (cost engine, themes, confirmed writes).
  - **#65** `flightdeck-rich-activity` — Rich activity stream across 5 harnesses + 21+1 commits / 7 phases.
  - **#73** `vstack-issue-sweep` — 11 issues closed across 7 groups + reviewer minors cleanup.
  - **#75** `vstack-upstream-workarounds` — 3 upstream pi-coding-agent bugs worked around vstack-side + 4 deferred W4/W5 items.
  - **#76** `vstack-issue-74` — `/extensions` popup freeze fix.

- **15 issues closed**:
  - In-vstack (8 from W5 sweep): #57, #58, #59, #61, #66, #68, #69, #70, #71, #72.
  - Build-time bugs (W5 mid-flight): #62.
  - Upstream-workaround-closes: #60, #63, #67 (all closed via PR #75 vstack-side workarounds).
  - Community-reported (#74): closed via PR #76.

- **0 issues remain open** on `vanillagreencom/vstack` as of 2026-05-16 21:08 UTC.

## Upstream-bug strategy

The user directive was explicit: "for any issues relying on upstream fixes, we need workarounds or different solutions for them since we can not rely on pi upstream changes." Result:

| Upstream issue | Vstack-side workaround |
|---|---|
| #60 — pi-bridge subagent panes share parent session id | `pi-extensions/pi-session-bridge/extensions/child-session-id.ts` synthesizes `<parent>:c<pid>` when `PI_BRIDGE_PARENT_SESSION_ID` env is set by `pi-agents-tmux/extensions/subagent/pane.ts` launcher. |
| #63 — subagent stalls after compaction | `pi-extensions/pi-agents-tmux/extensions/subagent/idle-stall-watchdog.ts` polls `pi-bridge state` every 60s; writes synthetic `needs_completion` outbox when task is bridge-idle + outbox missing + stale beyond 300s. Real probe via `idle-stall-probe.ts` (default-busy on any failure). |
| #67 — post-compaction edit-loop | `skills/flightdeck/lib/flightdeck-core/src/daemon/edit-loop-detector.ts` (pure decision helper) + bash subscriber wiring matching real upstream `ToolExecutionEndEvent.data.isError` shape. 5 consecutive edit failures in 120s → synthetic `blocked` wake. |

Each workaround is opt-out via env (defaults ON); each is regression-tested against the actual upstream event shape (verified against `pi-coding-agent/dist/core/extensions/types.d.ts`).

## Deferred items audit

Every item explicitly deferred during W4/W5 was addressed or has a concrete reason:

| Deferred item | Disposition |
|---|---|
| Linear `issue_id` vs `linear_id` separation | **Shipped** — `--issue-id` emitted only when `FLIGHTDECK_ENTRY_ID` env is set; `--linear-id` always emitted. |
| pr-checks persisted transition memory | **Shipped** — sidecar at `<state-dir>/flightdeck-pr-checks-<pr>.json`, bounded LRU 50, `flock`-wrapped read-compare-record-emit (race-safe). |
| loop.ts pane-registry helper extraction | **Shipped** — 8 helpers moved to `daemon/pane-registry.ts`. loop.ts 870 → 774 lines. |
| TS/bash adhoc-pi hash parity | **Shipped** — `decidePiAdhocWake` accepts `assistantTextHash`, produces byte-equivalent hash to bash mirror. Parity test asserts equivalence. |
| GitHub label instrumentation | **Deferred with concrete reason** — `skills/github/scripts/commands/` has no `label-add.sh` / `label-remove.sh` wrapper. Adding label-emission requires shipping the wrapper first; that's a separate feature scope, not just instrumentation. Documented in PR #75 commit body. |
| Hyprtrade live validation | **Run** — see "Live validation" below. |

## Review chain summary

| PR | Round 1 | Round 2 | Final |
|---|---|---|---|
| #64 | minor findings (small) | n/a | approved |
| #65 | per-phase rounds during W4 (7 phases × engineer+reviewers) | per-phase fixes | approved |
| #73 | 7 minors across arch/error/structure | cleanup commit `dc67366` | approved |
| #75 | **1 BLOCKER + 2 MAJORS** (event-shape bug, RMW race, hardcoded probe) + 6 minors | full fix commit `2bd08ec`/`d818e84`/`c29e9e1` | round-3 verification approved no new findings |
| #76 | reviewer-error info-level findings only | n/a | approved |

The blocker on PR #75 (`#67 wiring used wrong jq event-field path`) is notable: without the round-2 review, the entire post-compaction edit-loop workaround would have been dead code in production. The fix matches the real `ToolExecutionEndEvent` shape and is regression-locked via a test that pipes a synthetic upstream payload through the exact jq selector.

## Live validation against hyprtrade

After all PRs merged:

```bash
# Global Pi extensions updated:
cd /mnt/Tertiary/dev/vstack/main && vstack refresh -g
# Result: 18 Pi packages processed, 3 updated:
#   @vanillagreen/pi-agents-tmux (W4 + W5 changes — agent-end watchdog, idle-stall watchdog, child-session-id)
#   @vanillagreen/pi-extension-manager (issue #74 perf fix)
#   @vanillagreen/pi-session-bridge (W4 activity broker + #60 workaround)

# Hyprtrade project-local skill install updated:
cd /mnt/Tertiary/dev/hyprtrade/main && vstack refresh
# Result: 3 skills updated: flightdeck, github, linear

# Activity sidecar CLI tested in hyprtrade:
flightdeck-state activity path --session test-activity-validation
# → /mnt/Tertiary/dev/hyprtrade/main/tmp/flightdeck-activity-test-activity-validation.jsonl

flightdeck-state activity append '<event-json>' --session test
# → {"id":"<sha>","deduped":false}

flightdeck-state activity tail --session test --json
# → NDJSON output with the event correctly normalized (schema_version, severity, importance, etc.)
```

Gated wrapper emissions tested:

```bash
FLIGHTDECK_ACTIVITY_FILE=/tmp/...jsonl FLIGHTDECK_MANAGED=1 \
  .agents/skills/linear/scripts/_activity-emit.sh linear.issue_created \
    --severity info --summary 'Test' --linear-id HT-9999
# → emits with correct type, source, refs

unset FLIGHTDECK_MANAGED FLIGHTDECK_ACTIVITY_FILE
.agents/skills/linear/scripts/_activity-emit.sh linear.issue_created ...
# → silent (no emit). Gating works.
```

What's NOT in this validation:
- Live broker `vstack_activity` stream event from `pi-bridge stream` — requires a deeper Pi-internal smoke test. The unit tests in W4 Phase 5 + W5 #60 workaround cover the broker functionality across 7 + 7 tests respectively. The CLI tests above prove the JSONL pipeline end-to-end.
- Live dashboard UI run against a real Flightdeck session — release binary is in the worktrees but not yet rebuilt on `main`. Insta snapshot tests (180+ snapshots across 4 themes / 25+ scenarios) cover the rendered surface.

## Stats

- **Total commits across all 5 PRs**: ~75 (counting individual feature/fix commits + 4 merge commits).
- **Total new tests**: 250+ across pi-extensions + flightdeck-core + cli + flightdeck-dashboard.
- **Total reviewer rounds**: 13 (across 7 phases of W4 + 1 round each for W5 cleanup, W5 sweep, upstream workarounds, #74).
- **Total findings closed**: 2 blockers, ~15 majors, ~80 minors.
- **Total lines changed**: ~10,000 across all PRs.

## Pane-agent telemetry

W5 + upstream workarounds + #74 used the rust agent reconfigured to `claude-bridge/claude-opus-4-7:xhigh`. After all the issue-sweep work, the agent was reverted to `openai-codex/gpt-5.5:xhigh` per the original config. Backups taken in `/tmp/rust-agent-w4-backup.md` and `/tmp/rust-agent-pre-issue74.md`.

Compaction stalls observed during W4 Phase 6 (root cause for the #63/#67 issues — the agent compacted then completely stalled mid-task). Workaround issued via `pi-bridge send --steer` manually. The W5 G4 watchdog + #63 workaround should mitigate future occurrences but the underlying pi-core resume-turn bug is still upstream.

## Process notes

Sequential per-issue / per-group engineer dispatches worked well for tight, well-scoped tasks (the #62 / #66 / #74 single-issue fixes shipped in <30 min each). The 7-phase W4 chain was heavier (~3-5 hr per phase including review cycles).

The "blocker discovered in round-2 review" pattern (PR #75) is worth keeping: round 1 caught surface-level issues, round 2 surfaced a deeper bug (wrong event-field path) that round 1 missed because the W5 wiring tests grep'd bash source instead of feeding real upstream payloads through. Lesson: regression tests for cross-boundary integrations should feed REAL upstream event shapes, not assume the shape.

## Followup ideas (none filed as issues yet)

- GitHub label wrapper (`skills/github/scripts/commands/label-add.sh`/`label-remove.sh`) — would enable the deferred label-instrumentation.
- Dashboard auto-rebuild on `vstack refresh` when the Rust crate's source changed (currently the user must `cargo build --release` manually).
- Live broker smoke test that exercises end-to-end `vstack_activity` flow through `pi-bridge stream` — not just unit tests of the broker module.

Open issues at end of session: **0**.
