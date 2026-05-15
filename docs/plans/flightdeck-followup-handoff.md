# Flightdeck Follow-Up Handoff

> One document for everything queued after the 2026-05-15 Rust-dashboard ship. A fresh session reading this should be able to pick up cold and run the remaining work autonomously, including review cycles. Keep this doc tight.

## Where things stand

**Worktree:** `/mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust`, branch `flightdeck-dashboard-rust`. Not merged to main yet.

**Shipped in this run (commits on the worktree branch):**

- Rust dashboard binary at `skills/flightdeck/lib/flightdeck-dashboard/` — Phases 1–12 of `docs/plans/flightdeck-dashboard-rust-tui-plan.md`. Six tabs, six demo fixtures, daemon read-shim with UDS snapshot stream, Pi subscriber absorption gated behind `FLIGHTDECK_DAEMON_RUST=1`, launch integration via `flightdeck-session start`, parity sign-off vs `pi-flightdeck`.
- Theme system: 4 selectable themes via `--theme moon|dawn|pantera|system` or `FLIGHTDECK_DASHBOARD_THEME`. 16-slot `Palette` struct. Default `moon`.
- UX v3: HitMap-based mouse support, 5 popups (help+legend, theme picker, decision detail, session detail, filter input), plain-language state/kind labels via `src/app/labels.rs`, hierarchical info layout, header rewrite with chip-style status indicators.
- UX-v2 polish: compact mode column spacing, activity feed empty-state messaging, all-noise summary row.

**Already landed in this run that the handoff sequencing notes below assume:**

- **Cost + writes** (commits `cb13325 cost engine`, `d9f34a6 cost UI + confirmed write actions`, `01f5660 tests`, `e54e72a docs`). The cost engine, the Cost column / Costs tab / status-bar chip, and the prune + focus session-window confirmed write actions are all SHIPPED. Brief was `tmp/cost-and-writes-brief.md`.

**In flight when this handoff was written, about to land:**

- **Polish round** (task id `rust-1778880337921-57300ee9857ec421`, brief `tmp/uxv3-polish-brief.md`) — actively running. Covers P1-A header overflow / P1-B merges tab missing row / P1-C decisions tab missing row / P1-F theme bg paint / P1-G popup key capture / P2-D paused chip drop / P2-E stale-warn rename. **When the next session starts, this should have landed as 2–3 fresh commits past `e54e72a`.** If those commits aren't present, investigate: the polish task got stuck or was dropped from the queue.

**Daemon state:** flightdeck-daemon for session `VS` is **stopped** to silence `rendering / bell` wake noise from rapid engineer iteration (see `tmp/2026-05-15-vstack-followups.md` § 3a). pi-agents-tmux completion wakes are the only signal channel; that's what the polish task completion will arrive on. The next session can leave the daemon stopped or restart it via `skills/flightdeck/scripts/flightdeck-daemon start --session VS --master $TMUX_PANE --inner <engineer-pane-id>` after attaching the next engineer pane through `flightdeck-session attach`.

**Reference docs:**

- `tmp/2026-05-15-memory-incident.md` — OOM post-mortem; explains why heavy cargo work must run inside subagent pane scopes, not from master pane.
- `tmp/2026-05-15-vstack-followups.md` — 7 followup issues filed against `pi-agents-tmux`, `flightdeck-daemon`, and `vstack` install. File these on the github issues list when the work cycle ends.

## What this handoff covers

Four workstreams, in execution order. Each is self-contained — the next session can pick any one up if priorities shift.

1. **Verify the polish round landed cleanly** — short audit + screenshot pass.
2. **Cost + writes** — the engineer task that was queued but paused.
3. **Doc audit** — scan flightdeck skill + dashboard docs + root docs for stale claims about the dashboard's surface.
4. **Activity-events plan execution** — full autonomous run of `docs/plans/flightdeck-rich-activity-events.md`, Phases 1–7, with review cycles.

After workstream 4, open a PR for `flightdeck-dashboard-rust` (parent dashboard branch) and a separate PR for the activity-events worktree.

---

## Workstream 1 — Verify polish round

When you take over, the polish task should be complete. Confirm by inspecting:

```bash
cd /mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust
git log --oneline -10
ls /home/method/.pi/agent/vstack/sessions/*/pi-agents-tmux/processed/rust/ | head -3
```

Expected: 2–3 new commits past `153c64c docs(flightdeck): document pantera dashboard theme`. The expected commit set:

1. `polish(flightdeck-dashboard): header fit + merges/decisions full render + paused-chip drop` (P1-A, P1-B, P1-C, P2-D, P2-E)
2. `fix(flightdeck-dashboard): apply theme bg to outer frame and panels` (P1-F)
3. `fix(flightdeck-dashboard): popups capture all keys; arrow/vim keys no longer leak to base` (P1-G)

(Engineer may combine adjacent commits — that's fine. Read the engineer's `<output_format>` notes for what actually shipped.)

### Audit checklist

Rebuild release (use a subagent so the master pane's cgroup doesn't accumulate cargo working set — see memory-incident doc):

```bash
cd skills/flightdeck/lib/flightdeck-dashboard && cargo build --release
```

Launch the dashboard against the mock fixture and screenshot all four themes:

```bash
# Use fresh tmux windows for each theme (window dies on TUI exit; not reusable across themes).
DASH=/mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust/skills/flightdeck/lib/flightdeck-dashboard/target/release/flightdeck-dashboard
STATE=/mnt/Tertiary/dev/vstack/main/tmp/dashboard-mock-state.json
for theme in moon dawn pantera system; do
  tmux new-window -t VS -n "dash-${theme}" -d "exec $DASH tui --theme $theme --state-file $STATE"
  sleep 1.5
  WIN=$(tmux list-windows -t VS -F '#{window_index} #{window_name}' | awk -v n="dash-${theme}" '$2==n{print $1}')
  tmux select-window -t VS:${WIN} && sleep 0.7 && grim /tmp/dash-theme-${theme}.png
  tmux kill-window -t VS:${WIN} 2>/dev/null
done
tmux select-window -t VS:1
```

Audit the screenshots against this checklist:

- **Dawn** must render a light cream background (#faf4ed) — not the terminal's dark bg bleeding through. If Dawn still looks dark, P1-F regressed.
- **Pantera** must render a deep purple-black background (#201f26) painted onto panels, distinct from the surrounding terminal area.
- **Moon** must render a dark purple background (#232136) distinct from terminal default.
- **System** stays unpainted by design (uses `Color::Reset`); selected rows use `Modifier::REVERSED` for contrast.
- **Theme chip** in the header must NOT be truncated (P1-A). All four theme names (`moon`, `dawn`, `pantera`, `system`) plus the dropdown indicator should fit at 181 cells.
- **Header should NOT contain a `paused` chip** (P2-D dropped it; the banner below carries pause status).
- **Merges tab** must render BOTH entries from `merge_queue: ["HT-9002", "HT-9001"]` (P1-B regression fix).
- **Decisions tab** must render all 7 decision rows from the mock fixture (P1-C — `HT-9002 merge-ready-but-unknown @ 19:42:08` was previously missing).

Open the theme picker (`t` key or click theme chip):

- Press `j` / `k` / `Up` / `Down`. **The popup's radio selection must move; the underlying Overview tab's row selection must NOT.** (P1-G regression fix.)
- Press Enter on a non-current theme. Theme switches live.
- Press Esc on a non-current theme. Theme unchanged, popup closes.

Open each other popup (help: `?`, decision detail: select decisions tab + Enter, session detail: Enter on Overview row, filter: `/`). Same key-capture contract.

### Pantera cohesion check

User flagged Pantera as visually uncohesive even with correctly-sourced Charmtone RGB values. After P1-F lands and bg paints properly, re-check:

- Pantera's `#201f26` base should ground the high-saturation neons.
- All-six-states-at-once may still feel rainbow-soup. If so, swap to the softer Charmtone cousins in `src/app/theme.rs::PANTERA`:
  - `success`: `Julep #00FFB2` → `Bok #68FFD6` (softer mint)
  - `warning`: `Mustard #F5EF34` → `Zest #E8FE96` (softer yellow)
  - `error`: `Sriracha #EB4268` → `Coral #FF577D` (softer red)
  - `info`: `Malibu #00A4FF` → `Sardine #4FBEFE` (softer blue)
- All four cousins are official Charmtone — still palette-faithful, just less saturated.
- Single commit if you do this: `fix(flightdeck-dashboard): pantera cohesion — swap to softer Charmtone cousins`. Update the Pantera RGB table in `DEVELOPMENT.md` accordingly.

### Mock fixture

The mock state file at `/mnt/Tertiary/dev/vstack/main/tmp/dashboard-mock-state.json` is the canonical testing scenario:

- 6 tracked entries across 3 issues (HT-9001 prompting/paused, HT-9002 merge-ready, HT-9000 merged), 2 adhoc (one running, one stopped), 1 workflow (the dashboard itself).
- Non-empty `merge_queue`, `conflict_graph`, `paused_for_user`, `decisions_log` on each issue.
- pi-flightdeck (the legacy Pi extension) does NOT read this file — it watches `flightdeck-state-VS.json`. Keep the mock here and pi-flightdeck stays out of testing.

If the fixture gets stale (e.g. timestamps drift to where ages render oddly), refresh by editing `last_response_at` / `last_polled_at` / `spawned_at` to recent ISO timestamps.

### What "verify" passes

- All four theme screenshots show distinct backgrounds.
- All visible bug findings (P1-A through P1-G + P2-D, P2-E) eyeball-confirmed in screenshots.
- `cargo test` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo insta test` green (the engineer ran these but verify after rebuild).

If anything fails, dispatch a small follow-up engineer task on the rust pane:

```
agent: rust
cwd: /mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust
task: "Fix <specific finding>. Read tmp/<brief>.md. Single commit. All gates pass. End with output_format JSON via complete_subagent."
```

Use the existing brief in `tmp/` as a template if a clean one isn't already there.

---

## Workstream 2 — Verify cost + writes

Cost + writes already shipped during this run (see commits `cb13325`, `d9f34a6`, `01f5660`, `e54e72a`). The verify-pass mirrors Workstream 1 but for the cost surface specifically:

- **Cost engine** (`src/cost/mod.rs` + per-harness impls). Verify `CostMetrics` has separate `input_tokens` / `output_tokens` / `cache_creation_tokens` / `cache_read_tokens` slots — user requirement that totals not be conflated.
- **Per-harness sources** — inspect what shipped. The Codex source was expected to ship as a stub if its usage RPC isn't documented; check the engineer's notes in the cost+writes processed JSON for what got stubbed vs implemented.
- **Bundled pricing.toml** — verify the header comment includes a verified-date, and the rates are reasonable against current Anthropic + OpenAI pricing.
- **UI surfaces** — launch the dashboard with the mock fixture, confirm a Cost column appears in the sessions table, the Costs tab renders, the status bar has a cost chip, the right rail has a Cost section. Mock fixture entries won't have real transcripts, so cost should render as `—` per the design.
- **Write actions** — verify a `Prune` button appears for the stopped entry (`doc-spike` in the mock fixture) since its pane_id is absent from `tmux list-panes`. Verify `Focus` works on a live entry's row. Confirm both gate behind a confirmation popup with explicit Cancel.

If any of the above is broken or missing, dispatch a small fix-up engineer task. Otherwise mark Workstream 2 done and move to Workstream 3.

**Review cycle (skipped if shipped clean):** reviewers were not run yet on cost+writes; the engineer's own validation was the only check. If anything below is off, do a fresh review pass:

```
parallel:
  - reviewer-arch (focus: layering of cost engine vs UI, per-harness source isolation, write-action authority boundaries, pricing data flow)
  - reviewer-error (focus: source failure handling, no unwrap outside main/tests, write actions confirm before subprocess, subprocess errors surfaced)
  - reviewer-test (focus: per-harness JSONL parsing tests, pricing assertion tests, aggregator sum correctness, stale-detection tests, write-action mock tests)
```

Reviewer-doc runs LAST as part of the final docs sweep before opening the PR.

---

## Workstream 3 — Doc audit

After Workstreams 1 + 2 land, audit docs for stale info. Scan and update tight — corrections only, no rewriting for prose's sake.

**Files to scan:**

- `skills/flightdeck/SKILL.md` — check the Scripts table (`flightdeck-dashboard` script row), the Configuration env vars table (FLIGHTDECK_DASHBOARD_* vars), the Workflows table, and the Implementation Constraints (especially #3 about pi-flightdeck which is now deprecated for new sessions).
- `skills/flightdeck/README.md` — Rust dashboard section should mention 4 themes, mouse support, popups, prune/focus, cost engine, and the legend in help overlay. Verify the catalog of env vars matches what's actually wired in `src/cli.rs` and `src/launch.rs`.
- `skills/flightdeck/DEVELOPMENT.md` — Rust dashboard section. Sections to verify: build/test commands, snapshot conventions (`TestBackend::new(200, 60)`), theme tokens (16-slot Palette), motion catalog (`app/motion.rs` + `app/view/fx.rs`), daemon subscriber layout (`daemon/subscribers/pi/{lifecycle,bridge,stream_parse,classifier,wake_emitter}.rs`), cost engine layout (`cost/{mod,claude,pi,opencode,codex,aggregator}.rs`), HitMap mouse architecture, popup framework.
- `skills/flightdeck/lib/flightdeck-dashboard/README.md` — if it exists, verify the `--theme`, `--socket`, `--state-file`, `--session` flag docs match `cli.rs`.
- `pi-extensions/pi-flightdeck/README.md` — deprecation banner should point at the Rust dashboard. Verify it's still accurate (mentions 4 themes, mouse, cost).
- `docs/work-in-progress/flightdeck-dashboard-handoff.md` — update the HEAD reference to current branch tip; verify the "what's done" section matches actuals.
- `docs/work-in-progress/flightdeck-dashboard-parity-smokes.md` — verify the auto-focus-removed claim is still accurate; verify smoke procedures still apply.
- `docs/plans/flightdeck-dashboard-rust-tui-plan.md` — this is the SOURCE plan. Mark closed/shipped phases. The plan was already fully shipped through Phase 12 (per the handoff at `docs/work-in-progress/`); just verify nothing in the plan claims something is "deferred" when it's actually shipped (theme system, mouse, popups were all "future work" originally and are now done).
- Root `README.md` — if it mentions flightdeck, add a one-line nod to the Rust dashboard.

**Tight-edit policy:**

- If a section is still accurate, don't touch it.
- If a fact is stale, replace it with the current fact. No "previously this was X, now it's Y" hedging.
- If a section described work as "future" or "Phase 2+" and that work is now done, just drop the deferred framing.
- No new sections unless a shipped feature has zero documentation home.

**Dispatch:** doc audit doesn't need engineer review cycles; do it inline as the master agent. Single commit when done:

```
docs(flightdeck): refresh skill + dashboard docs after polish/theme/UX-v3/cost ship
```

---

## Workstream 4 — Activity-events plan execution

**Plan:** `docs/plans/flightdeck-rich-activity-events.md` (refreshed 2026-05-15 by this handoff; reads against the post-purge + post-dashboard-ship baseline).

### Worktree setup (first action)

Branch off the dashboard branch since `JsonlActivitySource` (Phase 6 of the activity plan) needs the `EventSource` trait that lives on `flightdeck-dashboard-rust`:

```bash
cd /mnt/Tertiary/dev/vstack/main
skills/worktree/scripts/worktree create flightdeck-rich-activity --from flightdeck-dashboard-rust
cd /mnt/Tertiary/dev/vstack/trees/flightdeck-rich-activity
ls -la tmp/                                  # WORKTREE_MKDIRS auto-creates this
git status --short                           # should be clean
```

Scratch (engineer task briefs, intermediate JSONs, fixtures) goes in `<worktree>/tmp/` per `WORKTREE_MKDIRS`.

### Execution order

Strict serial. Each phase passes review before the next phase starts.

#### Phase 1 — Core activity sidecar + `flightdeck-state activity` CLI

Goal: ship the data-plane primitives so all later phases have a single canonical append path.

**Engineer brief (write to `tmp/activity-phase1-engineer-brief.md`):**

- Add `skills/flightdeck/lib/flightdeck-core/src/activity/{types,paths,append,read,format}.ts` per the plan's Phase 1 section.
- `flightdeck-state activity` subcommands: `path`, `append`, `tail`, `export`.
- `flightdeck-state init` writes `activity_path` if absent.
- `terminate.md` / terminate helpers archive the activity sidecar alongside the master state archive (use the existing `archiveState` flow so a `*.json.archive` and matching `*.jsonl.archive` always land together).
- Tests: schema normalization, id generation/dedup, lock-held append under concurrent writers, CLI surface.
- Validation: `bun test && bun run typecheck` in `skills/flightdeck/lib/flightdeck-core/`.

**Engineer dispatch:**

```
agent: rust  (using rust agent for cross-language work since brief is bun/TS-heavy but uses our subagent pattern)
cwd: /mnt/Tertiary/dev/vstack/trees/flightdeck-rich-activity
task: read tmp/activity-phase1-engineer-brief.md and execute it. Up to 3 commits. End with output_format JSON via complete_subagent.
```

**Review (round 1, parallel):**

- reviewer-arch — schema design, paths layering, archive integration, append idempotency
- reviewer-error — lock semantics, no silent failures, malformed-row handling, write-failure surfaces

Round 2 only if changes-requested. reviewer-doc reserved for Phase 7.

#### Phase 2 — State-transition instrumentation

Goal: emit activity events from the canonical `pane-registry` write paths so every flightdeck state change is auditable.

**Brief points (write `tmp/activity-phase2-engineer-brief.md`):**

- Mirror every `pane-registry log-decision` → `decision.recorded` activity emit.
- `pane-registry init-entry` → `entry.registered`.
- `pane-registry set-state` → `entry.state_changed`; `set-substate` → `entry.state_changed` with substate.
- `pane-registry teardown-entry` / `remove` → `entry.completed` / `entry.cancelled` / `entry.dead` based on terminal state.
- Reconcile drift/drop/backfill → `daemon.warning` or `entry.dead`.
- Tests: existing pane-registry tests still green; activity emit count exactly once per mutation; deduplication holds under concurrent writers.

Review cycle: arch + error + test (test added because this touches the canonical write path).

#### Phase 3 — Dashboard `JsonlActivitySource` + Activity tab rename

Goal: dashboard renders the activity sidecar as primary source.

**Brief points (write `tmp/activity-phase3-engineer-brief.md`):**

- Add `src/events/jsonl_activity.rs` impl of `EventSource` trait. Reads `<FLIGHTDECK_STATE_DIR>/flightdeck-activity-<session>.jsonl` and archives.
- Wire into `events::default_sources` as the primary source (before existing `JsonlEventSource(fd-wake-events)` and `DaemonTextLogSource(fd-daemon-log)`).
- Rename Live feed tab to Activity once the sidecar is the primary source. Tab label lives in `src/app/labels.rs::tab_label()` (or wherever UX v3 put it).
- Snapshot tests for the renamed tab + populated activity rows.
- Click each row via HitMap → open detail popup (use UX v3 popup framework).
- Theme palette used for severity colors and type chips (NO raw `Color::Green`).

Review cycle: arch + error + structure (touches event-source wiring + view module + labels).

#### Phase 4 — Daemon + subscriber curated events

Goal: daemon emits curated activity (start/stop, subscriber lifecycle, classified wake mappings) without conflating with the existing wake-routing log.

**Brief points (write `tmp/activity-phase4-engineer-brief.md`):**

- Add activity-append path to `flightdeck-daemon start` options/env; pass to subscriber loops.
- Daemon emits: `daemon.started`, `daemon.stopped` (mapping `reason` to severity per the existing daemon-exited shape), `daemon.warning`, `subscriber.started`, `subscriber.dead`, `domain.mismatch`, wake-delivery-failure.
- Subscriber-side activity mirrors wake classification: question.opened, agent.task_*, bg_task.*, etc. Severity + importance defaults per the table in the plan.
- Wake routing unchanged.
- Tests: activity emit doesn't change wake behavior; bad subagent completion still wakes; successful subagent completion appears in activity but does not wake.

Review cycle: arch + error + test.

#### Phase 5 — Pi activity broker via session-bridge

Goal: Pi-side extensions publish curated activity to a single broker symbol; flightdeck Pi subscriber consumes it via `pi-bridge stream`.

**Brief points (write `tmp/activity-phase5-engineer-brief.md`):**

- Add `Symbol.for("vstack.pi.activity")` broker. Methods: `publish(event)`, `subscribe(listener)`, `recent(limit)`.
- `pi-session-bridge` publishes broker events on `stream` as `event="vstack_activity"`.
- Wire producers: `pi-background-tasks` (bg_task.started, output_matched, completed/failed/timed_out/stopped), `pi-agents-tmux` (agent.spawned, task_queued, task_started, task_completed/failed/blocked/needs_completion, steered, empty_after_compact), `pi-questions` (question.opened/answered/rejected).
- Flightdeck Pi subscriber consumes `vstack_activity` from `pi-bridge stream` and appends to the activity sidecar.

Review cycle: arch + error.

Note: this phase touches 5 Pi extension packages. After it lands, run `vstack refresh -g` (NOT `--all`; just the changed extensions). Commit + refresh before claiming done (per `.claude/CLAUDE.md`'s Pi-extension workflow).

#### Phase 6 — Issue-domain workflow instrumentation

Goal: GitHub / Linear / workflow-step events surface as activity.

**Brief points (write `tmp/activity-phase6-engineer-brief.md`):**

- Workflow markdown (`start.md`, `session-watch.md`, `handle-prompt.md`, `merge-plan.md`, `close-issue.md`, `terminate.md`) emits activity at instrumented points.
- Gate emission on `FLIGHTDECK_MANAGED=1` or `FLIGHTDECK_ACTIVITY_FILE` so standalone use of github/linear skills stays silent.
- GitHub/Linear wrapper updates: PR opened, comments left, checks failed/passed, PR merged, Linear issue created/updated/relation created/finished/cancelled.

Review cycle: arch + error.

#### Phase 7 — Editor/export + docs polish

Goal: ship the `e` editor-export shortcut and complete the docs sweep.

**Brief points (write `tmp/activity-phase7-engineer-brief.md`):**

- `e` keybinding in Activity and Decisions tabs writes filtered stream to `tmp/flightdeck-activity-view-<SESSION>-<ts>.md`; opens in `$VISUAL`/`$EDITOR` via new tmux window when safe.
- CLI: `flightdeck-state activity export --format markdown --filter ...`.
- Persistent filters via `FLIGHTDECK_ACTIVITY_FILTER_TYPES` / `FLIGHTDECK_ACTIVITY_FILTER_SESSIONS`.

Docs sweep:

- `skills/flightdeck/SKILL.md` — activity in Scripts table + Configuration env vars
- `skills/flightdeck/README.md`, `DEVELOPMENT.md` — Activity tab + sidecar paths + producer broker
- `skills/flightdeck/lib/flightdeck-dashboard/` — `JsonlActivitySource`, Activity tab rename, type chips
- `pi-extensions/pi-flightdeck/README.md` — Activity tab presence
- Pi extension READMEs/DEVELOPMENT.md for the producer packages

Review cycle: arch + error + structure + reviewer-doc LAST. Apply reviewer-doc feedback as a single docs commit before opening the PR.

### Activity-events PR

After Phase 7 + reviewer-doc clean, write `docs/work-in-progress/flightdeck-rich-activity-handoff.md` mirroring the dashboard handoff structure:

- Branch: `flightdeck-rich-activity`
- Worktree: `/mnt/Tertiary/dev/vstack/trees/flightdeck-rich-activity`
- What's done (Phase 1 → 7 with one-line each)
- How to run
- Known limitations
- Follow-up backlog

Open the PR. PR body summarizes the review chain per `docs/plans/flightdeck-dashboard-rust-tui-plan.md`'s Phase 11 pattern: round counts, blocker/major/minor counts, files changed.

---

## Cross-cutting conventions

These hold for every workstream above.

### Review cycle pattern

Established in the dashboard work and proven across 30+ commits:

1. **Round 1 — parallel dispatch.** `reviewer-arch` + `reviewer-error` minimum. Add `reviewer-test` when test surface changes. Add `reviewer-structure` when files cross the 600 LOC cap or modules cross boundaries.
2. **Each reviewer returns** a structured JSON in `<output_format>` tags with `verdict: approve | changes-requested`, `findings: [{severity, file, summary, suggested_fix}]`, `notes`.
3. **Apply round-1 feedback** as 1–3 grouped commits referencing reviewer + finding id in the commit body. Run all validation gates before each commit.
4. **Round 2** only if any reviewer returned `changes-requested`. Re-dispatch only the flagging reviewers against fix commits. Halt at round 3 — escalate to user.
5. **reviewer-doc LAST.** Runs once, after final commit on the workstream. Doc review checks SKILL.md drift, README user-facing hygiene, AGENTS.md rules, pattern docs. Apply feedback as one docs commit.

### Engineer dispatch contract

Every brief MUST require:

- Engineer reads the brief FIRST.
- Engineer commits progress as 1–5 logical commits (one per finding-cluster or one per phase sub-step).
- Engineer runs the full validation gate (`cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test && cargo insta test` plus bun gates for TS work) before each commit.
- Engineer ends with `complete_subagent` and a JSON `<output_format>` summary describing commits, files changed, validation results, and notes.
- Engineer never returns early; either completes or commits-what-works and emits `status=blocked` with notes.

### Heavy cargo work goes in subagent pane scope

The master pane (the agent reading this handoff) MUST NOT run `cargo clippy --all-targets --all-features` repeatedly during verification. The 2026-05-15 OOM was caused by accumulated cargo + page-cache + pi-context in the master pane's cgroup. Mitigations recorded in `tmp/2026-05-15-memory-incident.md`. Verifications use engineer task dispatch instead.

### Mouse + popup hygiene

UX v3 established the HitMap registry pattern and the popup key-capture contract. Any new tab or popup added in Phases 3–7 MUST:

- Register all interactive elements via HitMap (`ClickAction::*` variants).
- Capture all keyboard input while open; never leak keys to the base layer.
- Use the existing `popup` framework (`src/app/view/popup.rs`); don't roll new chrome.
- Use palette tokens (`Theme::palette().*`); never hardcode `Color::*` literals.

### Plain-language labels

UX v3 added `src/app/labels.rs` with `state_label()`, `kind_label()`, `kind_badge()`. Phase 3 and Phase 7 of the activity plan extend this with `activity_type_label()` for plain-language event type names (e.g. `pr.checks_failed` → "PR checks failed"). Do not invent a parallel labels module.

### Followups to file as github issues at the end

After both PRs land, file the seven issues in `tmp/2026-05-15-vstack-followups.md` against the github issues list. Three of them (`#1` silent abandonment, `#2` compaction edit loop, `#3a` daemon bell wake-storm) are high-impact reliability fixes that affect this workflow today.

---

## TL;DR for the next session

1. Read `git log --oneline -10` on the dashboard worktree branch — confirm 2–3 polish commits past `e54e72a`. If they're missing, the polish task got stuck in flight; check `pi-agents-tmux/processing/rust/` for the orphaned task and either steer it or stop the rust agent and dispatch a fresh polish task using `tmp/uxv3-polish-brief.md`.
2. Rebuild release in a subagent pane. Screenshot 4 themes. Audit per the checklist in Workstream 1.
3. Verify cost + writes per Workstream 2 (they already shipped — just inspect).
4. Inline the doc audit pass (Workstream 3).
5. Create the `flightdeck-rich-activity` worktree off the dashboard branch (Workstream 4 setup).
6. Execute activity Phases 1 → 7 sequentially, each with arch + error reviewers minimum + reviewer-doc last.
7. Open two PRs (one for `flightdeck-dashboard-rust`, one for `flightdeck-rich-activity`). File the 7 vstack followup issues in `tmp/2026-05-15-vstack-followups.md`.

Everything past step 1 runs autonomously via engineer dispatches + review cycles. No new architectural decisions are needed — the briefs are detailed and the conventions are codified above.
