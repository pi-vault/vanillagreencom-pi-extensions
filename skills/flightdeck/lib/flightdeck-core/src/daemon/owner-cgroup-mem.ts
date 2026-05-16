// Owner cgroup memory probe for the daemon heartbeat (vstack#72).
//
// Cheap cgroup v2 read that turns a heartbeat line into something
// post-mortem-actionable without the operator hunting through
// /proc/<pid>/status by hand. Failures are silent: this is purely
// observability and must NEVER block heartbeat emission.
//
// The probe is gated by FD_HEARTBEAT_OWNER_CGROUP (default 1). Set to
// 0 to disable entirely.

import { readFileSync } from "node:fs";

const HEARTBEAT_CGROUP_PROBE_ENV = "FD_HEARTBEAT_OWNER_CGROUP";
const SYS_CGROUP_BASE = "/sys/fs/cgroup";

export interface OwnerCgroupMemFields {
	current: number | null;
	peak: number | null;
}

export interface OwnerCgroupMemSnapshot extends OwnerCgroupMemFields {
	cgroupPath: string | null;
	currentFile: string | null;
	peakFile: string | null;
}

export interface OwnerCgroupMemDeps {
	readFile?: (path: string) => string;
}

export function ownerCgroupProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[HEARTBEAT_CGROUP_PROBE_ENV]?.trim();
	if (raw === undefined || raw === "") return true;
	return raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off";
}

function defaultRead(path: string): string {
	return readFileSync(path, "utf8");
}

/**
 * Parse /proc/<pid>/cgroup output for the cgroup v2 unified path. The
 * v2 line always starts with `0::` per the cgroupv2 kernel docs.
 */
export function parseCgroupV2Path(procCgroupText: string): string | null {
	for (const rawLine of procCgroupText.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("0::")) continue;
		const rest = line.slice("0::".length);
		if (!rest.startsWith("/")) return null;
		return rest;
	}
	return null;
}

function safeReadNumber(read: (path: string) => string, path: string): number | null {
	try {
		const txt = read(path).trim();
		if (!txt) return null;
		const n = Number.parseInt(txt, 10);
		if (!Number.isFinite(n) || n < 0) return null;
		return n;
	} catch { return null; }
}

export function probeOwnerCgroupMem(pid: number | null | undefined, deps: OwnerCgroupMemDeps = {}): OwnerCgroupMemSnapshot {
	const empty: OwnerCgroupMemSnapshot = { cgroupPath: null, currentFile: null, peakFile: null, current: null, peak: null };
	if (!pid || pid <= 0 || !Number.isFinite(pid)) return empty;
	const read = deps.readFile ?? defaultRead;
	let cgroupText: string;
	try { cgroupText = read(`/proc/${pid}/cgroup`); }
	catch { return empty; }
	const cgroupPath = parseCgroupV2Path(cgroupText);
	if (!cgroupPath) return empty;
	const base = `${SYS_CGROUP_BASE}${cgroupPath.replace(/\/$/, "")}`;
	const currentFile = `${base}/memory.current`;
	const peakFile = `${base}/memory.peak`;
	return {
		cgroupPath,
		currentFile,
		peakFile,
		current: safeReadNumber(read, currentFile),
		peak: safeReadNumber(read, peakFile),
	};
}

/**
 * Human-readable byte formatting with one decimal place. Matches the
 * brief's examples (4.2G, 12.8G). Bytes < 1024 are returned as "<N>B".
 */
export function formatHumanBytes(bytes: number | null | undefined): string | null {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
	if (bytes < 1024) return `${bytes}B`;
	const units = ["K", "M", "G", "T", "P"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = Math.round(value * 10) / 10;
	const trimmed = Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
	return `${trimmed}${units[unit]}`;
}

export function ownerMemHeartbeatFields(snapshot: OwnerCgroupMemSnapshot): string {
	const fields: string[] = [];
	const currentHuman = formatHumanBytes(snapshot.current);
	const peakHuman = formatHumanBytes(snapshot.peak);
	if (currentHuman) fields.push(`owner_rss=${currentHuman}`);
	if (peakHuman) fields.push(`owner_peak=${peakHuman}`);
	return fields.join(" ");
}
