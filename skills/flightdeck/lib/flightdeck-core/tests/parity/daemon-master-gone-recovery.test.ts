// Regression coverage for vstack#70: when the daemon detects its master
// pane is gone it must write a structured recovery hint to
// fd-daemon-recovery-<SESSION_KEY>.json with the documented schema, and
// emit an `[exit] master-gone; recovery hint at ...` log line.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildRecoveryHint,
	RECOVERY_HINT_REASON,
	recoveryHintPath,
	writeRecoveryHint,
} from "../../src/daemon/recovery-hint.ts";

const FIXED_NOW = () => new Date("2026-05-15T12:00:00.000Z");

function tempStateDir(): string {
	return mkdtempSync(join(tmpdir(), "fd-recovery-"));
}

describe("recoveryHintPath / buildRecoveryHint (vstack#70)", () => {
	test("file lives next to the daemon's other per-session state", () => {
		const stateDir = "/run/user/1000/flightdeck";
		expect(recoveryHintPath(stateDir, "s143")).toBe("/run/user/1000/flightdeck/fd-daemon-recovery-s143.json");
	});

	test("hint shape matches the documented schema", () => {
		const hint = buildRecoveryHint({
			sessionId: "$143",
			sessionKey: "s143",
			masterPaneId: "%7",
			masterPid: 12345,
			stateDir: "/run/user/1000/flightdeck",
			eventsFile: "/run/user/1000/flightdeck/fd-daemon-events-s143.jsonl",
			stateFile: "/proj/tmp/flightdeck-state-mysession.json",
			now: FIXED_NOW,
		});
		expect(hint.reason).toBe(RECOVERY_HINT_REASON);
		expect(hint.session_id).toBe("$143");
		expect(hint.owner_pid).toBe(12345);
		expect(hint.owner_pane_id).toBe("%7");
		expect(hint.exited_at).toBe("2026-05-15T12:00:00.000Z");
		expect(hint.state_file).toBe("/proj/tmp/flightdeck-state-mysession.json");
		expect(hint.events_file).toBe("/run/user/1000/flightdeck/fd-daemon-events-s143.jsonl");
		expect(Array.isArray(hint.next_steps)).toBe(true);
		expect(hint.next_steps.length).toBe(3);
		expect(hint.next_steps[0]).toMatch(/Verify the master agent/);
		expect(hint.next_steps[1]).toMatch(/resume the session/);
		expect(hint.next_steps[2]).toMatch(/abandon the session.*flightdeck-state archive/);
	});

	test("owner_pid is null when masterPid is omitted", () => {
		const hint = buildRecoveryHint({
			sessionId: "$200",
			sessionKey: "s200",
			masterPaneId: "%9",
			stateDir: "/tmp/x",
		});
		expect(hint.owner_pid).toBeNull();
	});
});

describe("writeRecoveryHint (vstack#70)", () => {
	test("writes JSON to fd-daemon-recovery-<session>.json with mode 0600", () => {
		const stateDir = tempStateDir();
		const result = writeRecoveryHint({
			sessionId: "$143",
			sessionKey: "s143",
			masterPaneId: "%7",
			masterPid: 99,
			stateDir,
			eventsFile: "/x/events.jsonl",
			now: FIXED_NOW,
		});
		expect(result.ok).toBe(true);
		expect(result.path).toBe(join(stateDir, "fd-daemon-recovery-s143.json"));
		expect(existsSync(result.path)).toBe(true);
		const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
		expect(onDisk.reason).toBe("master-gone");
		expect(onDisk.session_id).toBe("$143");
		expect(onDisk.owner_pid).toBe(99);
		expect(onDisk.owner_pane_id).toBe("%7");
		expect(onDisk.exited_at).toBe("2026-05-15T12:00:00.000Z");
		expect(onDisk.events_file).toBe("/x/events.jsonl");
		expect(onDisk.next_steps.length).toBe(3);
	});

	test("write failure returns ok=false with error and does not throw", () => {
		const result = writeRecoveryHint({
			sessionId: "$1",
			sessionKey: "sX",
			masterPaneId: "%1",
			stateDir: "/no/such/dir/that/should/not/exist/xyz123",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("subsequent writes overwrite the previous hint (single most-recent)", () => {
		const stateDir = tempStateDir();
		writeRecoveryHint({ sessionId: "$1", sessionKey: "s1", masterPaneId: "%1", masterPid: 100, stateDir, now: FIXED_NOW });
		const second = writeRecoveryHint({ sessionId: "$1", sessionKey: "s1", masterPaneId: "%1", masterPid: 200, stateDir, now: FIXED_NOW });
		expect(second.ok).toBe(true);
		const onDisk = JSON.parse(readFileSync(second.path, "utf8"));
		expect(onDisk.owner_pid).toBe(200);
	});
});

describe("loop.ts master-gone wiring (vstack#70)", () => {
	const loopSrc = readFileSync(new URL("../../src/daemon/loop.ts", import.meta.url), "utf8");

	test("imports the recovery-hint helpers", () => {
		expect(loopSrc).toContain("writeRecoveryHint");
		expect(loopSrc).toContain("resolveMasterPidSafe");
		expect(loopSrc).toContain("recoveryHintPath");
	});

	test("writes the hint inside the master-gone branch before break", () => {
		const masterGoneIdx = loopSrc.indexOf("`master ${masterId} gone; exiting`");
		const writeIdx = loopSrc.indexOf("writeRecoveryHint({");
		const breakIdx = loopSrc.indexOf("break;", masterGoneIdx);
		expect(masterGoneIdx).toBeGreaterThan(-1);
		expect(writeIdx).toBeGreaterThan(masterGoneIdx);
		expect(writeIdx).toBeLessThan(breakIdx);
	});

	test("logs '[exit] master-gone; recovery hint at <path>' on success", () => {
		expect(loopSrc).toMatch(/log\("exit"[^\)]*master-gone; recovery hint at/);
	});

	test("failure path warn-logs and does NOT throw", () => {
		expect(loopSrc).toContain("exit-warn");
		expect(loopSrc).toMatch(/recovery hint write failed|recovery hint write threw/);
	});
});
