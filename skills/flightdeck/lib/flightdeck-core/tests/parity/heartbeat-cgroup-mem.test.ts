// Regression coverage for vstack#72: the daemon heartbeat should
// append owner cgroup v2 memory.current and memory.peak when probe
// succeeds, and degrade silently to the existing line on any failure
// (non-Linux, no cgroup v2, permission denied, owner pid gone).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	formatHumanBytes,
	ownerCgroupProbeEnabled,
	ownerMemHeartbeatFields,
	parseCgroupV2Path,
	probeOwnerCgroupMem,
} from "../../src/daemon/owner-cgroup-mem.ts";

describe("formatHumanBytes (vstack#72)", () => {
	test("< 1024 bytes -> '<N>B'", () => {
		expect(formatHumanBytes(0)).toBe("0B");
		expect(formatHumanBytes(512)).toBe("512B");
	});

	test("KB / MB / GB with one decimal place", () => {
		expect(formatHumanBytes(1024)).toBe("1.0K");
		expect(formatHumanBytes(1536)).toBe("1.5K");
		expect(formatHumanBytes(1024 * 1024)).toBe("1.0M");
		expect(formatHumanBytes(1024 * 1024 * 1024)).toBe("1.0G");
		// brief examples
		expect(formatHumanBytes(Math.floor(4.2 * 1024 * 1024 * 1024))).toBe("4.2G");
		expect(formatHumanBytes(Math.floor(12.8 * 1024 * 1024 * 1024))).toBe("12.8G");
	});

	test("null / negative / non-finite -> null", () => {
		expect(formatHumanBytes(null)).toBeNull();
		expect(formatHumanBytes(undefined)).toBeNull();
		expect(formatHumanBytes(-1)).toBeNull();
		expect(formatHumanBytes(Number.NaN)).toBeNull();
	});
});

describe("parseCgroupV2Path", () => {
	test("extracts the v2 path from a cgroup v2 line", () => {
		const procText = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/myapp\n`;
		expect(parseCgroupV2Path(procText)).toBe("/user.slice/user-1000.slice/user@1000.service/app.slice/myapp");
	});

	test("ignores legacy v1 controller lines and prefers the 0:: line", () => {
		const procText = `13:freezer:/\n11:devices:/\n0::/user.slice/example\n`;
		expect(parseCgroupV2Path(procText)).toBe("/user.slice/example");
	});

	test("returns null when no v2 line exists", () => {
		expect(parseCgroupV2Path("13:freezer:/\n11:devices:/\n")).toBeNull();
	});

	test("returns null when v2 line has malformed payload", () => {
		expect(parseCgroupV2Path("0::not-a-path\n")).toBeNull();
	});
});

describe("probeOwnerCgroupMem with mocked deps (vstack#72)", () => {
	test("success path returns current+peak in bytes and the resolved sys files", () => {
		const procText = "0::/user.slice/example.service\n";
		const reads: Record<string, string> = {
			"/proc/123/cgroup": procText,
			"/sys/fs/cgroup/user.slice/example.service/memory.current": "4509715764\n",
			"/sys/fs/cgroup/user.slice/example.service/memory.peak": "13743895347\n",
		};
		const snapshot = probeOwnerCgroupMem(123, {
			readFile: (path) => {
				if (!(path in reads)) { const e: NodeJS.ErrnoException = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
				return reads[path]!;
			},
		});
		expect(snapshot.cgroupPath).toBe("/user.slice/example.service");
		expect(snapshot.current).toBe(4509715764);
		expect(snapshot.peak).toBe(13743895347);
		expect(snapshot.currentFile).toBe("/sys/fs/cgroup/user.slice/example.service/memory.current");
		expect(snapshot.peakFile).toBe("/sys/fs/cgroup/user.slice/example.service/memory.peak");
	});

	test("missing /proc/<pid>/cgroup -> all fields null, no throw", () => {
		const snapshot = probeOwnerCgroupMem(123, {
			readFile: () => { const e: NodeJS.ErrnoException = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
		});
		expect(snapshot.current).toBeNull();
		expect(snapshot.peak).toBeNull();
		expect(snapshot.cgroupPath).toBeNull();
	});

	test("missing memory.peak but present memory.current -> current set, peak null", () => {
		const procText = "0::/example\n";
		const snapshot = probeOwnerCgroupMem(123, {
			readFile: (path) => {
				if (path === "/proc/123/cgroup") return procText;
				if (path === "/sys/fs/cgroup/example/memory.current") return "1048576\n";
				const e: NodeJS.ErrnoException = new Error("ENOENT"); e.code = "ENOENT"; throw e;
			},
		});
		expect(snapshot.current).toBe(1048576);
		expect(snapshot.peak).toBeNull();
	});

	test("malformed memory.current (non-numeric) -> null without throwing", () => {
		const snapshot = probeOwnerCgroupMem(123, {
			readFile: (path) => {
				if (path === "/proc/123/cgroup") return "0::/example\n";
				return "garbage\n";
			},
		});
		expect(snapshot.current).toBeNull();
		expect(snapshot.peak).toBeNull();
	});

	test("non-positive pid returns empty snapshot without reading", () => {
		let readCount = 0;
		const snapshot = probeOwnerCgroupMem(0, { readFile: () => { readCount += 1; return ""; } });
		expect(snapshot.current).toBeNull();
		expect(readCount).toBe(0);
		expect(probeOwnerCgroupMem(null).current).toBeNull();
	});
});

describe("ownerMemHeartbeatFields", () => {
	test("renders both fields when current+peak are present", () => {
		const fields = ownerMemHeartbeatFields({
			cgroupPath: "/x", currentFile: "x", peakFile: "x",
			current: 4509715764,
			peak: 13743895347,
		});
		expect(fields).toBe("owner_rss=4.2G owner_peak=12.8G");
	});

	test("omits peak when null but renders current", () => {
		const fields = ownerMemHeartbeatFields({
			cgroupPath: "/x", currentFile: "x", peakFile: null,
			current: 1048576,
			peak: null,
		});
		expect(fields).toBe("owner_rss=1.0M");
	});

	test("returns empty string when both null", () => {
		expect(ownerMemHeartbeatFields({ cgroupPath: null, currentFile: null, peakFile: null, current: null, peak: null })).toBe("");
	});
});

describe("ownerCgroupProbeEnabled", () => {
	test("unset env defaults to enabled", () => {
		expect(ownerCgroupProbeEnabled({} as NodeJS.ProcessEnv)).toBe(true);
	});

	test("FD_HEARTBEAT_OWNER_CGROUP=0 disables", () => {
		expect(ownerCgroupProbeEnabled({ FD_HEARTBEAT_OWNER_CGROUP: "0" } as any)).toBe(false);
		expect(ownerCgroupProbeEnabled({ FD_HEARTBEAT_OWNER_CGROUP: "false" } as any)).toBe(false);
		expect(ownerCgroupProbeEnabled({ FD_HEARTBEAT_OWNER_CGROUP: "off" } as any)).toBe(false);
	});

	test("truthy values keep enabled", () => {
		expect(ownerCgroupProbeEnabled({ FD_HEARTBEAT_OWNER_CGROUP: "1" } as any)).toBe(true);
		expect(ownerCgroupProbeEnabled({ FD_HEARTBEAT_OWNER_CGROUP: "true" } as any)).toBe(true);
	});
});

describe("loop.ts heartbeat wiring (vstack#72)", () => {
	const loopSrc = readFileSync(new URL("../../src/daemon/loop.ts", import.meta.url), "utf8");

	test("imports the cgroup helpers", () => {
		expect(loopSrc).toContain("probeOwnerCgroupMem");
		expect(loopSrc).toContain("ownerMemHeartbeatFields");
		expect(loopSrc).toContain("ownerCgroupProbeEnabled");
	});

	test("probe is invoked inside the heartbeat block and gated by FD_HEARTBEAT_OWNER_CGROUP", () => {
		const heartbeatIdx = loopSrc.indexOf("log(\"heartbeat\"");
		const probeIdx = loopSrc.indexOf("probeOwnerCgroupMem(");
		expect(heartbeatIdx).toBeGreaterThan(-1);
		expect(probeIdx).toBeGreaterThan(-1);
		expect(probeIdx).toBeLessThan(heartbeatIdx);
		expect(loopSrc).toContain("ownerCgroupProbeOn");
	});

	test("heartbeat log appends the owner_mem fields without an extra newline", () => {
		expect(loopSrc).toMatch(/busy_lock=\${bfState}\${ownerMemFields}/);
	});

	test("probe failure path is wrapped in try/catch (never blocks heartbeat)", () => {
		const block = loopSrc.match(/if \(ownerCgroupProbeOn\)[\s\S]{0,400}\bcatch\b/);
		expect(block).not.toBeNull();
	});
});
