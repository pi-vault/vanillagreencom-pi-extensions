# Linear Orchestration — development notes

Implementation details and contributor notes for the linear-orch skill. End-user setup and command reference live in [`README.md`](./README.md); AI / agent-facing instructions live in [`SKILL.md`](./SKILL.md).

## GitHub auth fallback

`bot-review-wait` and `ci-wait` share `scripts/lib/gh-auth.sh::linear_orch_sanitize_gh_env` to handle the case where a stale `GH_TOKEN` / `GITHUB_TOKEN` masks working `gh` keyring auth. The ladder is:

1. **Sanitize.** If env tokens are set but `gh auth status` fails, run `env -u GH_TOKEN -u GITHUB_TOKEN gh auth status`. If that succeeds, warn on stderr and `unset` the env tokens.
2. **Bot-token load.** If `GH_TOKEN` ends up empty, load a valid `GH_BOT_TOKEN` from `.env.local`/`.env`. `op://` references resolve via `op read` when the 1Password CLI is available.
3. **Fallback retry.** If auth still fails, drop the env tokens again and retry the bot-token load. Stale env tokens plus a broken keyring still recover when `.env.local` provides a valid bot token.
4. **Hard fail.** If no path works, exit `3` with a clear diagnostic so callers do not poll until timeout against an empty output.

## Tests

```
bash skills/linear-orch/tests/run-all.sh
# Filter:
bash skills/linear-orch/tests/run-all.sh flightdeck_mode
```

Each test stages a temp repo with a parametrized `gh` stub on `PATH` and exercises the auth ladder — stale-token sanitize, keyring fallback, `.env.local` `GH_BOT_TOKEN` fallback, and the hard "no working auth path" exit (code `3`). Suites:

- `bot_review_wait.sh` — review-wait state machine.
- `ci_wait.sh` — CI-wait state machine + auth ladder.
- `flightdeck_mode.sh` — managed-mode detection helper.
- `merge_pr_sweep.sh` — finalization branch sweep guard.
- `oc-flightdeck-managed.sh` — OpenCode adapter managed-env propagation.
