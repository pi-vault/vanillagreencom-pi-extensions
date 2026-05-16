// Master-gone recovery hint (vstack#70).
//
// When the daemon detects its master pane is gone and is about to exit,
// it writes a structured JSON breadcrumb so operators have a clear
// "what now?" pointer instead of just a log line.
//
// The file lives next to the daemon's other per-session state under
// FD_STATE_DIR / fdResolveStateDir(), named
// `fd-daemon-recovery-<SESSION_KEY>.json`. It is overwritten on every
// exit (one most-recent hint per session). Write failure is warn-logged
// and must NEVER block the master-gone exit.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const RECOVERY_HINT_REASON = "master-gone" as const;

export interface RecoveryHint {
	reason: typeof RECOVERY_HINT_REASON;
	session_id: string;
	owner_pid: number | null;
	owner_pane_id: string;
	exited_at: string;
	next_steps: string[];
	state_file: string | null;
	events_file: string | null;
}

export interface RecoveryHintInput {
	sessionId: string;
	sessionKey: string;
	masterPaneId: string;
	masterPid?: number | null;
	stateDir: string;
	eventsFile?: string;
	stateFile?: string | null;
	now?: () => Date;
}

export interface RecoveryHintWriteResult {
	ok: boolean;
	path: string;
	error?: string;
}

const NEXT_STEPS: ReadonlyArray<string> = [
	"Verify the master agent (Pi/Claude/Codex) is actually down and not just paused.",
	"If you want to resume the session: re-launch the master from the tracked owner cwd and run `flightdeck session watch` (or `/flightdeck` from the new master pane).",
	"If you want to abandon the session: `flightdeck-state archive` to roll the master state file.",
];

export function recoveryHintPath(stateDir: string, sessionKey: string): string {
	return join(stateDir, `fd-daemon-recovery-${sessionKey}.json`);
}

/**
 * Resolve the master pane's pid via `tmux display-message`. Returns
 * null on any failure — the master pane is gone by definition at this
 * point, so the lookup may legitimately return nothing.
 */
export function resolveMasterPidSafe(masterPaneId: string): number | null {
	if (!masterPaneId) return null;
	try {
		const r = spawnSync("tmux", ["display-message", "-p", "-t", masterPaneId, "#{pane_pid}"], { encoding: "utf8" });
		if (r.status !== 0) return null;
		const txt = (r.stdout ?? "").trim();
		if (!/^[1-9][0-9]*$/.test(txt)) return null;
		const pid = Number.parseInt(txt, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch { return null; }
}

export function buildRecoveryHint(input: RecoveryHintInput): RecoveryHint {
	const now = (input.now?.() ?? new Date()).toISOString();
	return {
		reason: RECOVERY_HINT_REASON,
		session_id: input.sessionId,
		owner_pid: input.masterPid ?? null,
		owner_pane_id: input.masterPaneId,
		exited_at: now,
		next_steps: [...NEXT_STEPS],
		state_file: input.stateFile ?? null,
		events_file: input.eventsFile ?? null,
	};
}

export function writeRecoveryHint(input: RecoveryHintInput): RecoveryHintWriteResult {
	const path = recoveryHintPath(input.stateDir, input.sessionKey);
	const hint = buildRecoveryHint(input);
	try {
		writeFileSync(path, `${JSON.stringify(hint, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return { ok: true, path };
	} catch (err) {
		return { ok: false, path, error: (err as Error)?.message ?? String(err) };
	}
}
