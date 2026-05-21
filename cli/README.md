# vstack CLI

Rust CLI that installs vstack skills, agents, hooks, and Pi extensions into Claude Code, Cursor, OpenCode, Codex, and Pi.

Architecture, conventions, and per-harness translation rules live in [`AGENTS.md`](../AGENTS.md) and the project [`CLAUDE.md`](../CLAUDE.md). This file documents how to build and test the CLI itself.

## Build

```bash
cargo build
```

## Test

Unit + integration tests:

```bash
cargo test
```

Integration test against this repo's source tree (writes into a temp dir, then exits — does not mutate the working copy):

```bash
cargo run -- add .. --all --copy
```

## Skill / Pi extension test surfaces

The CLI does not run skill or extension tests. Each test surface lives next to the code it covers:

- Linear-orch shell tests: [`../skills/linear-orch/README.md#tests`](../skills/linear-orch/README.md#tests)
- Flightdeck parity + live-wake: [`../skills/flightdeck/DEVELOPMENT.md#tests`](../skills/flightdeck/DEVELOPMENT.md#tests)
- Pi extension Bun tests: each `pi-extensions/<name>/tests/` directory
