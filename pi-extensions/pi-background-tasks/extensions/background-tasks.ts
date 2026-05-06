/*
 * vstack Pi background tasks.
 *
 * Locally owned package based on ideas and portions of the MIT-licensed
 * @ifi/pi-background-tasks package. See ../THIRD_PARTY_NOTICES.md.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import {
	getShellConfig,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BG_COMMAND = "bg";
const DEFAULT_BACKGROUND_BASH_SHORTCUT = "alt+.";
const DEFAULT_BG_SHORTCUT = "alt+shift+h";
const DEFAULT_WIDGET_TOGGLE_SHORTCUT = "alt+h";
const BG_MESSAGE_TYPE = "vstack-background-tasks:event";
const BG_WIDGET_KEY = "vstack-background-tasks";
const BG_INSTALL_SYMBOL = Symbol.for("vstack.background-tasks.installed");
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");

const DEFAULT_TIMEOUT_MS = 0;
const DEFAULT_OUTPUT_SETTLE_MS = 1_500;
const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
const DEFAULT_OUTPUT_BUFFER_MAX_CHARS = 1_000_000;
const DEFAULT_OUTPUT_ALERT_MAX_CHARS = 10_000;
const DEFAULT_LOG_TAIL_MAX_CHARS = 50_000;
const DEFAULT_FORCED_BACKGROUND_WINDOW_MS = 5 * 60 * 1_000;
const DASHBOARD_WIDTH = 96;
const DASHBOARD_MAX_HEIGHT = "75%";
const DASHBOARD_PADDING_X = 2;
const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

function ansiGreen(text: string): string { return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`; }
function ansiYellow(text: string): string { return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`; }
const DASHBOARD_PADDING_Y = 1;
const DASHBOARD_MIN_FRAME_ROWS = 14;
const DASHBOARD_FRAME_VERTICAL_OVERHEAD = 2 + DASHBOARD_PADDING_Y * 2;
const TASK_PANE_MIN_WIDTH = 30;
const TASK_PANE_MAX_WIDTH = 42;
const WIDGET_PADDING_X = 1;
const TOOL_PREVIEW_TASKS = 3;
const TOOL_PREVIEW_LINES = 12;
const WIDGET_COMPACT_TASKS = 3;
const DEFAULT_WIDGET_FINISHED_RETENTION_MS = 15_000;

const liveSnapshots = new Map<string, BackgroundTaskSnapshot>();

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";
type TaskEventType = "output" | "exit";

interface VstackModalLock {
	depth: number;
}

type ManagedTask = BackgroundTaskSnapshot & {
	child: ChildProcess;
	closed: boolean;
	forceKillTimer: ReturnType<typeof setTimeout> | null;
	lastAnnouncedLength: number;
	matcher: ((text: string) => boolean) | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	output: string;
	outputTimer: ReturnType<typeof setTimeout> | null;
	stopReason: "user" | "timeout" | "shutdown" | null;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
};

interface BackgroundTaskSnapshot {
	id: string;
	title: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	expiresAt: number | null;
	status: BackgroundTaskStatus;
	exitCode: number | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	outputBytes: number;
}

interface BackgroundTaskEventDetails {
	eventAt: number;
	eventType: TaskEventType;
	matchedPattern?: string;
	newOutputTail?: string;
	outputTail: string;
	task: BackgroundTaskSnapshot;
}

interface BackgroundLogTruncation {
	direction: "tail";
	fullOutputPath: string;
	shownChars: number;
	totalChars: number;
	truncated: true;
}

interface SpawnTaskOptions {
	command: string;
	cwd?: string;
	notifyOnExit?: boolean;
	notifyOnOutput?: boolean;
	notifyPattern?: string;
	timeoutSeconds?: number;
	title?: string;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

type VstackConfig = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function piSettingsPaths(cwd = process.cwd()): string[] {
	const userDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
	return [join(userDir, "settings.json"), projectSettingsPath(cwd)];
}

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["pi-background-tasks"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config; keep safe defaults.
		}
	}
	return merged;
}

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function settingEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, cwd?: string): T {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function taskDir(): string {
	const configured = settingString("taskDir", "");
	return process.env.PI_BG_TASK_DIR?.trim() || (configured ? resolve(expandHome(configured)) : join(tmpdir(), "vstack-pi-bg"));
}

function safeLabel(input: string): string {
	return input.replaceAll(/[^a-z0-9-]+/gi, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48) || "task";
}

function logFilePath(id: string, now: number = Date.now()): string {
	const dir = taskDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, `${safeLabel(id)}-${now}.log`);
}

function tailText(text: string, maxChars: number = settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS)): string {
	if (text.length <= maxChars) return text;
	return `[...truncated]\n${text.slice(-maxChars)}`;
}

function taskLogTruncation(output: string, logFile: string, cwd?: string): BackgroundLogTruncation | undefined {
	const maxChars = Math.max(1, Math.floor(settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, cwd)));
	if (output.length <= maxChars) return undefined;
	return { direction: "tail", fullOutputPath: logFile, shownChars: maxChars, totalChars: output.length, truncated: true };
}

function formatTaskLog(output: string, logFile: string, cwd?: string): string {
	if (!output) return "(empty)";
	const truncation = taskLogTruncation(output, logFile, cwd);
	if (!truncation) return output;
	return `[...truncated]\n${output.slice(-truncation.shownChars)}\n\n[Background log truncated. Showing last ${truncation.shownChars} of ${truncation.totalChars} character(s). Full log: ${logFile}]`;
}

function trimOutputBuffer(output: string, lastAnnouncedLength: number): { output: string; lastAnnouncedLength: number } {
	const maxChars = settingNumber("outputBufferMaxChars", DEFAULT_OUTPUT_BUFFER_MAX_CHARS);
	if (output.length <= maxChars) return { output, lastAnnouncedLength };
	const overflow = output.length - maxChars;
	return {
		lastAnnouncedLength: Math.max(0, lastAnnouncedLength - overflow),
		output: output.slice(-maxChars),
	};
}

function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1_000) return `${safe}ms`;
	const seconds = safe / 1_000;
	if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = Math.floor(seconds % 60);
	if (minutes < 60) return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
	const diff = timestamp - now;
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? "from now" : "ago";
	if (abs < 1_000) return diff >= 0 ? "now" : "just now";
	if (abs < 60_000) return `${Math.floor(abs / 1_000)}s ${suffix}`;
	if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
	if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
	return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
}

function parseOutputMatcher(pattern: string | undefined): ((text: string) => boolean) | null {
	const needle = pattern?.trim();
	if (!needle) return null;

	const regexMatch = needle.match(/^\/(.*)\/([gimsuy]*)$/);
	if (regexMatch) {
		try {
			const regex = new RegExp(regexMatch[1], regexMatch[2]);
			return (text: string) => {
				regex.lastIndex = 0;
				return regex.test(text);
			};
		} catch {
			// Invalid regex falls through to substring matching.
		}
	}

	const lower = needle.toLowerCase();
	return (text: string) => text.toLowerCase().includes(lower);
}

function summarizeTaskStatus(status: BackgroundTaskStatus, exitCode: number | null): string {
	switch (status) {
		case "running":
			return "running";
		case "completed":
			return `completed (exit ${exitCode ?? 0})`;
		case "failed":
			return `failed (exit ${exitCode ?? "?"})`;
		case "timed_out":
			return exitCode === null ? "timed out" : `timed out (exit ${exitCode})`;
		case "stopped":
			return exitCode === null ? "stopped" : `stopped (exit ${exitCode})`;
	}
}

function taskDisplayName(task: Pick<BackgroundTaskSnapshot, "title" | "command">): string {
	return task.title.trim() || task.command.trim();
}

function buildTaskSummaryLine(task: BackgroundTaskSnapshot, now: number = Date.now()): string {
	const activityAt = task.lastOutputAt ?? task.updatedAt;
	return `${task.id} · ${summarizeTaskStatus(task.status, task.exitCode)} · pid ${task.pid} · ${taskDisplayName(
		task,
	)} · ${formatRelativeTime(activityAt, now)}`;
}

function taskActivityAt(task: Pick<BackgroundTaskSnapshot, "lastOutputAt" | "updatedAt">): number {
	return task.lastOutputAt ?? task.updatedAt;
}

function taskElapsedMs(task: Pick<BackgroundTaskSnapshot, "startedAt" | "status" | "updatedAt">, now: number = Date.now()): number {
	return (task.status === "running" ? now : task.updatedAt) - task.startedAt;
}

function compactText(value: string, maxChars = 80): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizedCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function parsePatternList(raw: string): RegExp[] {
	const patterns: RegExp[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^\/(.*)\/([gimsuy]*)$/);
		try {
			patterns.push(match ? new RegExp(match[1], match[2]) : new RegExp(trimmed, "i"));
		} catch {
			// Ignore malformed optional user patterns; built-in safe patterns still apply.
		}
	}
	return patterns;
}

function matchesAnyRegex(command: string, patterns: RegExp[]): boolean {
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(command)) return true;
	}
	return false;
}

function loopIterationCount(command: string): number | null {
	const match = command.match(/\$\(\s*seq\s+(?:(\d+)\s+)?(\d+)\s*\)/i);
	if (!match) return null;
	const start = match[1] ? Number.parseInt(match[1], 10) : 1;
	const end = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return Math.abs(end - start) + 1;
}

function sleepSeconds(command: string): number | null {
	const match = command.match(/\bsleep\s+((?:\d+(?:\.\d+)?)|(?:\.\d+))\s*([smhd])?\b/i);
	if (!match) return null;
	const value = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(value)) return null;
	const unit = (match[2] ?? "s").toLowerCase();
	if (unit === "d") return value * 86_400;
	if (unit === "h") return value * 3_600;
	if (unit === "m") return value * 60;
	return value;
}

function looksLikeSessionMonitor(command: string): boolean {
	return /\b(?:pi-bridge|tmux|capture-pane|list-panes|has-session|delegate-state|subagent|session)\b/i.test(command);
}

interface BashBackgroundDecision {
	forced: boolean;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	reason: string;
	title: string;
}

function autoBackgroundDecision(command: string, cwd?: string): BashBackgroundDecision | null {
	const normalized = normalizedCommand(command);
	if (!normalized) return null;
	if (matchesAnyRegex(normalized, parsePatternList(settingString("autoBackgroundPatterns", "", cwd)))) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "matched configured auto-background pattern",
			title: `auto: ${compactText(normalized, 72)}`,
		};
	}

	if (/(?:^|[;&|]\s*)watch(?:\s|$)/i.test(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "watch-style command",
			title: `watch: ${compactText(normalized, 72)}`,
		};
	}

	if (/\b(?:tail|journalctl)\b[^\n;|&]*\s-[^\s;|&]*f\b/i.test(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "follow-mode log command",
			title: `follow: ${compactText(normalized, 72)}`,
		};
	}

	const delaySeconds = sleepSeconds(normalized);
	if (delaySeconds !== null && delaySeconds >= 5 && looksLikeSessionMonitor(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "delayed session/tmux monitoring command",
			title: `monitor: ${compactText(normalized, 72)}`,
		};
	}

	const hasShellLoop = /\b(?:for|while|until)\b/i.test(normalized) && /\bdo\b/i.test(normalized) && /\bdone\b/i.test(normalized);
	const hasSleep = /\bsleep\s+(?:\d+(?:\.\d+)?|\.\d+)/i.test(normalized);
	if (hasShellLoop && hasSleep) {
		const iterations = loopIterationCount(normalized);
		const looksLikeMonitor = looksLikeSessionMonitor(normalized);
		const longFiniteLoop = iterations !== null && iterations >= 30;
		const openEndedLoop = /\bwhile\s+(?:true|:)\b/i.test(normalized) || /\buntil\b/i.test(normalized);
		if (looksLikeMonitor || longFiniteLoop || openEndedLoop) {
			return {
				forced: false,
				notifyOnExit: true,
				notifyOnOutput: false,
				reason: looksLikeMonitor ? "session/tmux monitoring loop" : "long-running polling loop",
				title: `monitor: ${compactText(normalized, 72)}`,
			};
		}
	}

	return null;
}

function forcedBackgroundDecision(command: string, cwd?: string): BashBackgroundDecision {
	return {
		forced: true,
		notifyOnExit: true,
		notifyOnOutput: settingBoolean("forcedBackgroundNotifyOnOutput", false, cwd),
		reason: "requested by background shortcut",
		title: `shortcut: ${compactText(normalizedCommand(command), 72)}`,
	};
}

function bashBackgroundAckText(task: BackgroundTaskSnapshot, decision: BashBackgroundDecision): string {
	return [
		`Started ${task.id} (pid ${task.pid}) in the background.`,
		`Reason: ${decision.reason}.`,
		`Command: ${task.command}`,
		`Cwd: ${task.cwd}`,
		`Log: ${task.logFile}`,
		`Wakeups: exit=${task.notifyOnExit ? "yes" : "no"}, output=${task.notifyOnOutput ? (task.notifyPattern ?? "yes") : "no"}`,
		"Continue the turn without waiting. Use bg_task list/log/stop to inspect or terminate this task.",
	].join("\n");
}

function bashBackgroundAck(task: BackgroundTaskSnapshot, decision: BashBackgroundDecision): string {
	const text = bashBackgroundAckText(task, decision);
	return `printf '%s\\n' ${shellQuote(text)}`;
}

function formatShortcutHint(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
		.join("+");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

function takeTailLines(text: string, maxLines: number): { hidden: number; lines: string[]; total: number } {
	const lines = text.trimEnd().length > 0 ? text.trimEnd().split(/\r?\n/) : [];
	const limit = Math.max(1, Math.floor(maxLines));
	return { hidden: Math.max(0, lines.length - limit), lines: lines.slice(-limit), total: lines.length };
}

function outputLineLimit(cwd?: string): number {
	return Math.max(1, Math.floor(settingNumber("toolExpandedLogLines", 80, cwd)));
}

function activePill(theme: Theme, label: string): string {
	return theme.fg("accent", theme.inverse(theme.bold(label)));
}

function inactivePill(theme: Theme, label: string): string {
	return theme.bg("selectedBg", theme.fg("accent", label));
}

function taskSnapshot(task: ManagedTask): BackgroundTaskSnapshot {
	return {
		command: task.command,
		cwd: task.cwd,
		exitCode: task.exitCode,
		expiresAt: task.expiresAt,
		id: task.id,
		lastOutputAt: task.lastOutputAt,
		logFile: task.logFile,
		notifyOnExit: task.notifyOnExit,
		notifyOnOutput: task.notifyOnOutput,
		notifyPattern: task.notifyPattern,
		outputBytes: task.outputBytes,
		pid: task.pid,
		startedAt: task.startedAt,
		status: task.status,
		title: task.title,
		updatedAt: task.updatedAt,
	};
}

function rememberSnapshot(task: ManagedTask): BackgroundTaskSnapshot {
	const snapshot = taskSnapshot(task);
	liveSnapshots.set(snapshot.id, snapshot);
	return snapshot;
}

function latestSnapshot(snapshot: BackgroundTaskSnapshot | undefined): BackgroundTaskSnapshot | undefined {
	if (!snapshot) return undefined;
	return liveSnapshots.get(snapshot.id) ?? snapshot;
}

function latestSnapshots(snapshots: BackgroundTaskSnapshot[]): BackgroundTaskSnapshot[] {
	return snapshots.map((snapshot) => latestSnapshot(snapshot) ?? snapshot);
}

function resolveTaskByToken<T extends Pick<BackgroundTaskSnapshot, "id" | "pid">>(
	tasks: Iterable<T>,
	token: string | number | undefined,
): T | null {
	if (token === undefined || token === null || token === "") return null;
	const normalized = String(token).trim();
	if (!normalized) return null;
	for (const task of tasks) {
		if (task.id === normalized || String(task.pid) === normalized) return task;
	}
	return null;
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function splitOutputLines(output: string): string[] {
	const text = tailText(output, settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS)).trimEnd();
	if (text.length === 0) return ["(no output yet)"];
	const lines = text.split(/\r?\n/);
	const maxLines = Math.max(20, Math.floor(settingNumber("dashboardOutputMaxLines", 800)));
	if (lines.length <= maxLines) return lines;
	return [`… ${lines.length - maxLines} older line(s) omitted from dashboard; use bg_task log or the Log file for full output`, ...lines.slice(-maxLines)];
}

function acquireVstackModalLock(): () => void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[VSTACK_MODAL_LOCK_SYMBOL] as VstackModalLock | undefined;
	const lock = existing && typeof existing.depth === "number" ? existing : { depth: 0 };
	host[VSTACK_MODAL_LOCK_SYMBOL] = lock;
	lock.depth += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lock.depth = Math.max(0, lock.depth - 1);
	};
}

function dashboardContentWidth(width: number): number {
	return Math.max(1, width - 2 - DASHBOARD_PADDING_X * 2);
}

function frameDashboard(lines: string[], width: number, theme: Theme, title = "", right = ""): string[] {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));

	const border = (text: string) => theme.fg("borderAccent", text);
	const contentWidth = dashboardContentWidth(width);
	const blank = `${border("┃")}${" ".repeat(width - 2)}${border("┃")}`;
	const top = () => {
		if (!title) return `${border("┏")}${border("━".repeat(width - 2))}${border("┓")}`;
		const rightPlain = right ? ` ${right} ` : "";
		const titleBudget = Math.max(1, width - 2 - visibleWidth(rightPlain) - 1);
		const titlePlain = ` ${truncateToWidth(title, Math.max(1, titleBudget - 2), "…")} `;
		const fill = Math.max(1, width - 2 - visibleWidth(titlePlain) - visibleWidth(rightPlain));
		return `${border("┏")}${ansiGreen(titlePlain)}${border("━".repeat(fill))}${right ? theme.fg("dim", rightPlain) : ""}${border("┓")}`;
	};
	const framed = [top()];

	for (let i = 0; i < DASHBOARD_PADDING_Y; i += 1) framed.push(blank);
	for (const line of lines) {
		const content = padAnsi(line, contentWidth);
		framed.push(`${border("┃")}${" ".repeat(DASHBOARD_PADDING_X)}${content}${" ".repeat(DASHBOARD_PADDING_X)}${border("┃")}`);
	}
	for (let i = 0; i < DASHBOARD_PADDING_Y; i += 1) framed.push(blank);
	framed.push(`${border("┗")}${border("━".repeat(width - 2))}${border("┛")}`);
	return framed.map((line) => truncateToWidth(line, width, ""));
}

function frameWidget(lines: string[], width: number, theme: Theme): string[] {
	const safeWidth = Math.max(1, width);
	if (safeWidth < 8) return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	const border = (text: string) => theme.fg("borderAccent", text);
	const contentWidth = Math.max(1, safeWidth - 2 - WIDGET_PADDING_X * 2);
	return [
		`${border("┏")}${border("━".repeat(safeWidth - 2))}${border("┓")}`,
		...lines.map((line) => `${border("┃")}${" ".repeat(WIDGET_PADDING_X)}${padAnsi(line, contentWidth)}${" ".repeat(WIDGET_PADDING_X)}${border("┃")}`),
		`${border("┗")}${border("━".repeat(safeWidth - 2))}${border("┛")}`,
	].map((line) => truncateToWidth(line, safeWidth, ""));
}

class RenderedLines {
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(private readonly text: string) {}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const targetWidth = Math.max(1, width);
		this.cachedLines = wrapAnsiLines(this.text, targetWidth);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

function renderLines(text: string): RenderedLines {
	return new RenderedLines(text);
}

function renderEmpty() {
	return { invalidate() {}, render: () => [] as string[] };
}

type TreeBranch = "├" | "└" | "│";

function bgTreeGlyph(branch: TreeBranch, cwd?: string): string {
	const style = readVstackConfig(cwd).treeStyle === "ascii" ? "ascii" : "unicode";
	if (style === "ascii") {
		if (branch === "│") return "|  ";
		return branch === "└" ? "`-- " : "|-- ";
	}
	if (branch === "│") return "│  ";
	return `${branch}─ `;
}

function bgTree(theme: Theme, branch: TreeBranch = "├", cwd?: string): string {
	return theme.fg("muted", bgTreeGlyph(branch, cwd));
}

function bgToolLabel(theme: Theme, label: string): string {
	return theme.fg("text", theme.bold(label));
}

function bgStatusColor(status: BackgroundTaskStatus): "success" | "error" | "warning" | "muted" {
	if (status === "running") return "warning";
	if (status === "completed") return "success";
	if (status === "failed" || status === "timed_out") return "error";
	return "muted";
}

function bgStatusIcon(status: BackgroundTaskStatus, theme: Theme): string {
	if (status === "running") return theme.fg("warning", "●");
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "failed" || status === "timed_out") return theme.fg("error", "✗");
	return theme.fg("muted", "■");
}

function bgStatusText(task: Pick<BackgroundTaskSnapshot, "status" | "exitCode">, theme: Theme): string {
	return theme.fg(bgStatusColor(task.status), summarizeTaskStatus(task.status, task.exitCode));
}

function renderToolTaskRow(task: BackgroundTaskSnapshot, theme: Theme, branch: TreeBranch, cwd?: string): string {
	return `${bgTree(theme, branch, cwd)}${bgStatusIcon(task.status, theme)} ${theme.fg("accent", task.id)} ${bgStatusText(task, theme)}${theme.fg(
		"dim",
		` · pid ${task.pid} · ${compactText(taskDisplayName(task), 56)} · ${formatRelativeTime(taskActivityAt(task))}`,
	)}`;
}

function renderTaskDetails(task: BackgroundTaskSnapshot, theme: Theme, cwd?: string): string[] {
	const current = latestSnapshot(task) ?? task;
	const lines = [
		`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Status")}: ${bgStatusText(current, theme)} ${theme.fg("dim", `· pid ${current.pid}`)}`,
		`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Title")}: ${taskDisplayName(current)}`,
		`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Command")}: ${current.command}`,
		`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Cwd")}: ${current.cwd}`,
		`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Log")}: ${current.logFile}`,
	];
	if (current.status === "running" && current.expiresAt != null) lines.push(`${bgTree(theme, "├", cwd)}${theme.fg("muted", "Timeout")}: ${formatRelativeTime(current.expiresAt)}`);
	lines.push(
		`${bgTree(theme, "└", cwd)}${theme.fg("muted", "Wakeups")}: exit=${current.notifyOnExit ? "yes" : "no"}, output=${
			current.notifyOnOutput ? (current.notifyPattern ?? "yes") : "no"
		}`,
	);
	return lines;
}

function toolRenderMode(cwd?: string): "compact" | "stacked" {
	return settingEnum("toolRenderMode", ["compact", "stacked"] as const, "stacked", cwd);
}

function makeToolResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function backgroundRule(theme: Theme, width: number): string {
	const rule = "─".repeat(Math.max(1, width));
	for (const token of ["borderMuted", "muted"] as const) {
		try {
			const styled = theme.fg(token, rule);
			if (styled !== rule) return styled;
		} catch {
			// Try the next token/fallback below.
		}
	}
	return `\x1b[90m${rule}\x1b[39m`;
}

function wrapAnsiLines(text: string, width: number): string[] {
	const targetWidth = Math.max(1, width);
	return text.split(/\r?\n/).flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, targetWidth);
		return wrapped.length > 0 ? wrapped : [""];
	});
}

function renderRuledBackgroundMessage(text: string, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const rule = backgroundRule(theme, width);
			return [rule, ...wrapAnsiLines(text, width), rule];
		},
	};
}

function renderBackgroundMessage(text: string, theme: Theme): Component {
	return renderRuledBackgroundMessage(text, theme);
}

function isBackgroundTaskEventDetails(value: unknown): value is BackgroundTaskEventDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<BackgroundTaskEventDetails>;
	return (
		(candidate.eventType === "output" || candidate.eventType === "exit") &&
		Boolean(candidate.task) &&
		typeof candidate.outputTail === "string"
	);
}

function renderTaskEventMessage(
	message: { content?: unknown; details?: unknown },
	expanded: boolean,
	theme: Theme,
): Component {
	if (!isBackgroundTaskEventDetails(message.details)) {
		return renderBackgroundMessage(String(message.content ?? "Background task update"), theme);
	}

	const details = message.details;
	const task = latestSnapshot(details.task) ?? details.task;
	if (!expanded) {
		const prefix = details.eventType === "exit" ? theme.fg("success", "●") : theme.fg("accent", "●");
		const label = details.eventType === "exit"
			? `${theme.fg("toolTitle", theme.bold("Background task "))}${theme.fg("success", "finished")}`
			: theme.fg("toolTitle", theme.bold("Background task output"));
		return renderRuledBackgroundMessage(
			`${prefix} ${label} ${theme.fg("accent", task.id)}${theme.fg("dim", ` · ${compactText(taskDisplayName(task), 64)} · Ctrl+O details`)}`,
			theme,
		);
	}

	const headingLabel = details.eventType === "exit"
		? `${theme.fg("toolTitle", theme.bold("Background task "))}${theme.fg("success", "finished ")}`
		: bgToolLabel(theme, "Background task output ");
	const headingIcon = details.eventType === "exit" ? theme.fg("success", "●") : theme.fg("accent", "●");
	const lines = [
		`${headingIcon} ${headingLabel}${theme.fg("accent", task.id)}${theme.fg(
			"dim",
			` · ${compactText(taskDisplayName(task), 72)}`,
		)}`,
		...renderTaskDetails(task, theme),
	];
	if (details.matchedPattern) lines.push(`${bgTree(theme, "└")}${theme.fg("muted", "Pattern")}: ${details.matchedPattern}`);

	const preview = details.eventType === "output" ? details.newOutputTail || details.outputTail : details.outputTail;
	const output = takeTailLines(preview, outputLineLimit());
	lines.push("", theme.fg("accent", theme.bold("Recent output")));
	if (output.hidden > 0) lines.push(`${bgTree(theme, "│")}${theme.fg("muted", `… ${output.hidden} older line(s); full log: ${task.logFile}`)}`);
	lines.push(...(output.lines.length ? output.lines : ["(no output yet)"]).map((line) => `${bgTree(theme, "│")}${theme.fg("dim", line)}`));
	if (output.total >= outputLineLimit()) lines.push(`${bgTree(theme, "└")}${theme.fg("muted", `Full background log: ${task.logFile}`)}`);
	return renderRuledBackgroundMessage(lines.join("\n"), theme);
}

function bgToolAction(args: any, details: any): string {
	return typeof details?.action === "string" ? details.action : typeof args?.action === "string" ? args.action : "status";
}

function renderBgToolPartial(args: any, theme: Theme, cwd?: string): RenderedLines {
	const action = bgToolAction(args, undefined);
	const target = args?.id ?? args?.pid ?? "tasks";
	const verb = action === "spawn" ? "starting" : action === "log" ? "tailing" : action === "stop" ? "stopping" : action === "clear" ? "clearing" : "checking";
	const title = action === "spawn" ? compactText(String(args?.title || args?.command || "background task"), 72) : String(target);
	return renderLines(`${theme.fg("warning", "● ")}${bgToolLabel(theme, `Background task ${verb}`)} ${theme.fg("accent", title)}${theme.fg("dim", "…")}`);
}

function renderBgTaskList(tasks: BackgroundTaskSnapshot[], theme: Theme, expanded: boolean, cwd?: string): string {
	tasks = latestSnapshots(tasks);
	const running = tasks.filter((task) => task.status === "running").length;
	const failed = tasks.filter((task) => task.status === "failed" || task.status === "timed_out").length;
	const finished = tasks.length - running;
	const status = failed > 0 ? theme.fg("warning", ` · ${failed} failed`) : running > 0 ? theme.fg("warning", ` · ${running} running`) : theme.fg("success", " · idle");
	let text = `${theme.fg("accent", "● ")}${bgToolLabel(theme, "Background tasks")}${theme.fg("dim", ` ${running} running · ${finished} finished`)}${status}`;
	if (tasks.length === 0) return `${text}${theme.fg("dim", " · none")}`;
	if (toolRenderMode(cwd) === "compact" && !expanded) return `${text}${theme.fg("dim", " · Ctrl+O details")}`;
	const shown = tasks.slice(0, expanded ? tasks.length : TOOL_PREVIEW_TASKS);
	shown.forEach((task, index) => {
		const isLast = index === shown.length - 1 && shown.length === tasks.length;
		text += `\n${renderToolTaskRow(task, theme, isLast ? "└" : "├", cwd)}`;
	});
	const hidden = tasks.length - shown.length;
	if (hidden > 0) text += `\n${bgTree(theme, "└", cwd)}${theme.fg("muted", `… ${hidden} more · Ctrl+O to expand`)}`;
	return text;
}

function renderBgLogResult(task: BackgroundTaskSnapshot | undefined, output: string, theme: Theme, expanded: boolean, cwd?: string): string {
	task = latestSnapshot(task);
	const taskLabel = task ? `${theme.fg("accent", task.id)} ${bgStatusText(task, theme)}` : theme.fg("accent", "log");
	const outputLines = takeTailLines(output, expanded ? outputLineLimit(cwd) : TOOL_PREVIEW_LINES);
	let text = `${theme.fg("accent", "● ")}${bgToolLabel(theme, "Background log ")}${taskLabel}${theme.fg(
		"dim",
		` · ${lineCount(output)} line${lineCount(output) === 1 ? "" : "s"}${expanded ? "" : " · Ctrl+O to expand"}`,
	)}`;
	if (expanded && task) text += `\n${renderTaskDetails(task, theme, cwd).join("\n")}`;
	if (expanded && output) {
		if (outputLines.hidden > 0) text += `\n${bgTree(theme, "│", cwd)}${theme.fg("muted", `… ${outputLines.hidden} older line(s); full log: ${task?.logFile ?? "available in details"}`)}`;
		text += `\n${outputLines.lines.map((line) => `${bgTree(theme, "│", cwd)}${theme.fg("dim", line)}`).join("\n")}`;
		if (task) text += `\n${bgTree(theme, "└", cwd)}${theme.fg("muted", `Full background log: ${task.logFile}`)}`;
	} else if (!expanded && output && toolRenderMode(cwd) === "stacked") {
		if (outputLines.lines.length > 0) text += `\n${bgTree(theme, "└", cwd)}${theme.fg("muted", compactText(outputLines.lines[outputLines.lines.length - 1] ?? "", 120))}`;
	}
	return text;
}

function renderBgToolResult(result: any, options: any, theme: Theme, context: any): RenderedLines | ReturnType<typeof renderEmpty> {
	if (options?.isPartial) return renderBgToolPartial(context?.args ?? {}, theme, context?.cwd);
	const action = bgToolAction(context?.args ?? {}, result?.details);
	const cwd = context?.cwd;
	const expanded = Boolean(options?.expanded);
	const details = result?.details ?? {};
	const raw = typeof result?.content?.find === "function" ? result.content.find((part: any) => part?.type === "text")?.text ?? "" : "";

	if (context?.isError || result?.isError) {
		const first = raw.split(/\r?\n/)[0] || "background task failed";
		return renderLines(`${theme.fg("error", "✗ ")}${bgToolLabel(theme, "Background task")} ${theme.fg("error", first)}`);
	}

	if (action === "list") return renderEmpty();

	if (action === "spawn") {
		const task = details.task as BackgroundTaskSnapshot | undefined;
		if (!task) return renderLines(`${theme.fg("warning", "● ")}${bgToolLabel(theme, "Background task started")}`);
		let text = `${theme.fg("warning", "● ")}${bgToolLabel(theme, "Background task started ")}${theme.fg("accent", task.id)}${theme.fg(
			"dim",
			` · pid ${task.pid} · ${compactText(taskDisplayName(task), 72)}${expanded ? "" : " · Ctrl+O details"}`,
		)}`;
		if (expanded) text += `\n${renderTaskDetails(task, theme, cwd).join("\n")}`;
		return renderLines(text);
	}

	if (action === "log") return renderLines(renderBgLogResult(details.task as BackgroundTaskSnapshot | undefined, raw, theme, expanded, cwd));

	if (action === "stop") {
		const task = latestSnapshot(details.task as BackgroundTaskSnapshot | undefined);
		const label = task ? `${theme.fg("accent", task.id)} ${bgStatusText(task, theme)}` : theme.fg("muted", compactText(raw, 80));
		let text = `${theme.fg("warning", "● ")}${bgToolLabel(theme, "Background task stop ")}${label}`;
		if (expanded && task) text += `\n${renderTaskDetails(task, theme, cwd).join("\n")}`;
		return renderLines(text);
	}

	if (action === "clear") {
		const removed = Number(details.removed ?? 0);
		return renderLines(`${theme.fg("success", "● ")}${bgToolLabel(theme, "Background tasks cleared")}${theme.fg("dim", ` · removed ${removed} finished`)}`);
	}

	return raw ? renderLines(raw) : renderEmpty();
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[BG_INSTALL_SYMBOL]) return;
	guard[BG_INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	let activeCtx: ExtensionContext | null = null;
	let requestWidgetRender: (() => void) | null = null;
	let forceNextBashBackgroundAt: number | null = null;
	const backgroundBashShortcut = settingString("backgroundBashShortcut", DEFAULT_BACKGROUND_BASH_SHORTCUT);
	const dashboardShortcut = settingString("dashboardShortcut", DEFAULT_BG_SHORTCUT);
	const widgetToggleShortcut = settingString("widgetToggleShortcut", DEFAULT_WIDGET_TOGGLE_SHORTCUT);
	let widgetMode: "compact" | "expanded" | "hidden" = settingEnum("widgetDefaultMode", ["compact", "expanded", "hidden"] as const, "compact");
	let taskCounter = 0;
	let shuttingDown = false;
	const tasks = new Map<string, ManagedTask>();

	const sortedTasks = (): ManagedTask[] => [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);

	const getTaskOutput = (task: ManagedTask): string => {
		if (task.output.length > 0) return task.output;
		if (!existsSync(task.logFile)) return "";
		try {
			return readFileSync(task.logFile, "utf8");
		} catch {
			return "";
		}
	};

	const clearTaskTimers = (task: ManagedTask) => {
		if (task.outputTimer) clearTimeout(task.outputTimer);
		if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
		if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
		task.outputTimer = null;
		task.timeoutTimer = null;
		task.forceKillTimer = null;
	};

	const clearWidget = () => {
		activeCtx?.ui.setWidget(BG_WIDGET_KEY, undefined);
		requestWidgetRender = null;
	};

	const renderWidgetLines = (theme: Theme): string[] => {
		const sorted = widgetTasks();
		const running = sorted.filter((task) => task.status === "running");
		const display = [...running, ...sorted.filter((task) => task.status !== "running")];
		const finished = sorted.length - running.length;
		const toggleHint = widgetToggleShortcut === "none" ? "" : ` · ${formatShortcutHint(widgetToggleShortcut)} toggle`;
		const dashboardHint = dashboardShortcut === "none" ? "" : ` · ${formatShortcutHint(dashboardShortcut)} dashboard`;
		const summary = `${theme.fg("customMessageLabel", theme.bold("Background tasks"))} ${theme.fg(
			"muted",
			`${running.length} running · ${finished} finished${toggleHint}${dashboardHint}`,
		)}`;
		if (display.length === 0) return [summary];
		const shown = display.slice(0, widgetMode === "expanded" ? display.length : WIDGET_COMPACT_TASKS);
		const lines = [summary];
		shown.forEach((task, index) => {
			const isLast = index === shown.length - 1 && shown.length === display.length;
			const activityAt = task.lastOutputAt ?? task.updatedAt;
			lines.push(`${bgTree(theme, isLast ? "└" : "├", activeCtx?.cwd)}${bgStatusIcon(task.status, theme)} ${theme.fg("accent", task.id)} ${theme.fg(
				"dim",
				`${summarizeTaskStatus(task.status, task.exitCode)} · ${compactText(taskDisplayName(task), 72)} · ${formatRelativeTime(activityAt)}`,
			)}`);
		});
		const hidden = display.length - shown.length;
		if (hidden > 0) lines.push(`${bgTree(theme, "└", activeCtx?.cwd)}${theme.fg("muted", `… ${hidden} more`)}`);
		return lines;
	};

	const widgetFinishedRetentionMs = (cwd?: string): number => Math.max(0, Math.floor(settingNumber("widgetFinishedRetentionSeconds", DEFAULT_WIDGET_FINISHED_RETENTION_MS / 1_000, cwd) * 1_000));

	const widgetTasks = (now: number = Date.now()): ManagedTask[] => {
		const retention = widgetFinishedRetentionMs(activeCtx?.cwd);
		return sortedTasks().filter((task) => task.status === "running" || now - task.updatedAt <= retention);
	};

	const syncWidget = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (tasks.size === 0 || widgetTasks().length === 0 || !ctx.hasUI || widgetMode === "hidden" || !settingBoolean("showWidget", true, ctx.cwd)) {
			clearWidget();
			return;
		}

		ctx.ui.setWidget(
			BG_WIDGET_KEY,
			(tui, theme) => {
				requestWidgetRender = () => tui.requestRender();
				let timer: ReturnType<typeof setInterval> | null = null;

				const ensureTimer = () => {
					const visible = widgetTasks();
					const shouldTick = visible.some((task) => task.status === "running") || visible.some((task) => task.status !== "running");
					if (!shouldTick) {
						if (timer) clearInterval(timer);
						timer = null;
						clearWidget();
						return;
					}
					if (timer) return;
					timer = setInterval(() => tui.requestRender(), 1_000);
					timer.unref?.();
				};

				return {
					dispose() {
						if (timer) clearInterval(timer);
						if (requestWidgetRender) requestWidgetRender = null;
					},
					invalidate() {},
					render(width: number) {
						ensureTimer();
						return frameWidget(renderWidgetLines(theme), width, theme);
					},
				};
			},
			{ placement: settingString("widgetPlacement", "aboveEditor", ctx.cwd) === "belowEditor" ? "belowEditor" : "aboveEditor" },
		);
	};

	const refreshUi = () => {
		for (const task of tasks.values()) rememberSnapshot(task);
		if (activeCtx) syncWidget(activeCtx);
		requestWidgetRender?.();
	};

	const sendTaskEvent = (
		eventType: TaskEventType,
		task: ManagedTask,
		options: { matchedPattern?: string; newOutputTail?: string } = {},
	) => {
		if (shuttingDown) return;
		if (eventType === "output" && !task.notifyOnOutput) return;
		if (eventType === "exit" && !task.notifyOnExit) return;

		const details: BackgroundTaskEventDetails = {
			eventAt: Date.now(),
			eventType,
			matchedPattern: options.matchedPattern,
			newOutputTail: options.newOutputTail,
			outputTail: tailText(getTaskOutput(task), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			task: rememberSnapshot(task),
		};
		const headline =
			eventType === "exit"
				? `Background task ${task.id} finished.`
				: `Background task ${task.id} emitted new output.`;

		pi.sendMessage(
			{
				content: `${headline}\nCommand: ${task.command}`,
				customType: BG_MESSAGE_TYPE,
				details,
				display: true,
			},
			eventType === "exit" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer", triggerTurn: true },
		);
	};

	const scheduleOutputReaction = (task: ManagedTask) => {
		if (!task.notifyOnOutput || task.status !== "running") return;
		if (task.outputTimer) clearTimeout(task.outputTimer);
		task.outputTimer = setTimeout(() => {
			task.outputTimer = null;
			const output = getTaskOutput(task);
			const unseenOutput = output.slice(task.lastAnnouncedLength);
			if (!unseenOutput.trim()) {
				task.lastAnnouncedLength = output.length;
				return;
			}
			if (task.matcher && !(task.matcher(unseenOutput) || task.matcher(output))) return;
			task.lastAnnouncedLength = output.length;
			sendTaskEvent("output", task, {
				matchedPattern: task.notifyPattern,
				newOutputTail: tailText(unseenOutput, settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			});
			refreshUi();
		}, settingNumber("outputSettleMs", DEFAULT_OUTPUT_SETTLE_MS, activeCtx?.cwd));
		task.outputTimer.unref?.();
	};

	const finalizeTask = (task: ManagedTask, exitCode: number | null, statusOverride?: BackgroundTaskStatus): ManagedTask => {
		if (task.closed) return task;
		task.closed = true;
		task.updatedAt = Date.now();
		task.exitCode = exitCode;
		clearTaskTimers(task);

		if (statusOverride) {
			task.status = statusOverride;
		} else if (task.stopReason === "timeout") {
			task.status = "timed_out";
		} else if (task.stopReason) {
			task.status = "stopped";
		} else {
			task.status = exitCode === 0 ? "completed" : "failed";
		}
		rememberSnapshot(task);

		sendTaskEvent("exit", task);
		refreshUi();
		return task;
	};

	const appendLogLine = (task: ManagedTask, text: string) => {
		try {
			appendFileSync(task.logFile, text);
		} catch {
			// Keep in-memory output even if the log file is temporarily unavailable.
		}
	};

	const killTaskProcess = (task: ManagedTask, signal: NodeJS.Signals): boolean => {
		if (task.pid <= 0) return false;
		try {
			if (process.platform === "win32") {
				process.kill(task.pid, signal);
			} else {
				// We spawn detached on Unix, so -pid targets the task process group.
				process.kill(-task.pid, signal);
			}
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH") appendLogLine(task, `\n[kill error] ${String(error)}\n`);
			return false;
		}
	};

	const requestStop = (
		task: ManagedTask | null,
		reason: "user" | "timeout" | "shutdown" = "user",
	): { ok: boolean; message: string } => {
		if (!task) return { ok: false, message: "No background task matched that id or pid." };
		if (task.status !== "running") {
			return { ok: true, message: `${task.id} is already ${summarizeTaskStatus(task.status, task.exitCode)}.` };
		}

		task.stopReason = reason;
		task.updatedAt = Date.now();
		rememberSnapshot(task);
		if (task.outputTimer) clearTimeout(task.outputTimer);
		task.outputTimer = null;

		const sent = killTaskProcess(task, "SIGTERM");
		if (!sent) {
			finalizeTask(task, task.exitCode, reason === "timeout" ? "timed_out" : "stopped");
			return { ok: true, message: `Stopped ${task.id} (${task.command}).` };
		}

		const forceKillGraceMs = settingNumber("forceKillGraceMs", DEFAULT_FORCE_KILL_GRACE_MS, activeCtx?.cwd);
		task.forceKillTimer = setTimeout(() => {
			if (task.status === "running" && !task.closed) {
				appendLogLine(task, `\n[stop] Escalating to SIGKILL after ${formatDuration(forceKillGraceMs)}.\n`);
				killTaskProcess(task, "SIGKILL");
			}
		}, forceKillGraceMs);
		task.forceKillTimer.unref?.();
		refreshUi();
		return { ok: true, message: `Stopping ${task.id} (${task.command}).` };
	};

	const spawnTask = (options: SpawnTaskOptions): ManagedTask => {
		const command = options.command.trim();
		if (!command) throw new Error("command is required for background task spawn");

		const cwd = options.cwd?.trim() || activeCtx?.cwd || process.cwd();
		const id = `bg-${++taskCounter}`;
		const now = Date.now();
		const timeoutSeconds = typeof options.timeoutSeconds === "number" ? options.timeoutSeconds : settingNumber("defaultTimeoutSeconds", DEFAULT_TIMEOUT_MS / 1_000, cwd);
		const expiresAt = timeoutSeconds > 0 ? now + timeoutSeconds * 1_000 : null;
		const logFile = logFilePath(id, now);
		writeFileSync(logFile, "");

		const { shell, args } = getShellConfig();
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const task: ManagedTask = {
			child,
			closed: false,
			command,
			cwd,
			exitCode: null,
			expiresAt,
			forceKillTimer: null,
			id,
			lastAnnouncedLength: 0,
			lastOutputAt: null,
			logFile,
			matcher: parseOutputMatcher(options.notifyPattern),
			notifyOnExit: options.notifyOnExit ?? true,
			notifyOnOutput: options.notifyOnOutput ?? false,
			notifyPattern: options.notifyPattern?.trim() || undefined,
			output: "",
			outputBytes: 0,
			outputTimer: null,
			pid: child.pid ?? 0,
			startedAt: now,
			status: "running",
			stopReason: null,
			timeoutTimer: null,
			title: options.title?.trim() || command,
			updatedAt: now,
		};
		tasks.set(task.id, task);
		rememberSnapshot(task);

		const handleChunk = (chunk: Buffer) => {
			const text = chunk.toString();
			task.updatedAt = Date.now();
			task.lastOutputAt = task.updatedAt;
			task.outputBytes += chunk.byteLength;
			task.output += text;
			const trimmed = trimOutputBuffer(task.output, task.lastAnnouncedLength);
			task.output = trimmed.output;
			task.lastAnnouncedLength = trimmed.lastAnnouncedLength;
			appendLogLine(task, text);
			rememberSnapshot(task);
			scheduleOutputReaction(task);
			refreshUi();
		};

		child.stdout?.on("data", handleChunk);
		child.stderr?.on("data", handleChunk);
		child.on("close", (code) => finalizeTask(task, typeof code === "number" ? code : null));
		child.on("error", (error) => {
			handleChunk(Buffer.from(`\n[spawn error] ${error.message}\n`));
			finalizeTask(task, 1, "failed");
		});

		if (expiresAt != null) {
			task.timeoutTimer = setTimeout(() => {
				appendLogLine(task, `\n[timeout] Background task exceeded ${formatDuration(timeoutSeconds * 1_000)}.\n`);
				requestStop(task, "timeout");
			}, Math.max(1, timeoutSeconds * 1_000));
			task.timeoutTimer.unref?.();
		}

		refreshUi();
		return task;
	};

	const clearFinishedTasks = (): number => {
		let removed = 0;
		for (const [id, task] of tasks) {
			if (task.status === "running") continue;
			clearTaskTimers(task);
			tasks.delete(id);
			liveSnapshots.delete(id);
			removed += 1;
		}
		refreshUi();
		return removed;
	};

	const formatTaskListText = (): string => {
		const sorted = sortedTasks();
		if (sorted.length === 0) return "No background tasks.";
		return sorted.map((task) => buildTaskSummaryLine(taskSnapshot(task))).join("\n\n");
	};

	const resolveTask = (id?: string, pid?: number): ManagedTask | null => resolveTaskByToken(tasks.values(), id ?? pid);

	const forcedBackgroundWindowMs = (cwd?: string): number => Math.max(1_000, settingNumber("forcedBackgroundWindowSeconds", DEFAULT_FORCED_BACKGROUND_WINDOW_MS / 1_000, cwd) * 1_000);

	const consumeForcedBackground = (cwd?: string): boolean => {
		if (forceNextBashBackgroundAt == null) return false;
		if (Date.now() - forceNextBashBackgroundAt > forcedBackgroundWindowMs(cwd)) {
			forceNextBashBackgroundAt = null;
			return false;
		}
		forceNextBashBackgroundAt = null;
		return true;
	};

	const armForcedBackground = (ctx: ExtensionContext | ExtensionCommandContext, source: "shortcut" | "command") => {
		forceNextBashBackgroundAt = Date.now();
		const seconds = Math.max(1, Math.round(forcedBackgroundWindowMs(ctx.cwd) / 1_000));
		const sourceText = source === "shortcut" ? formatShortcutHint(backgroundBashShortcut) : `/${BG_COMMAND} next`;
		const note = ctx.isIdle?.()
			? `${sourceText} armed. Next bash command in the next ${seconds}s will start as a background task.`
			: `${sourceText} armed. Next not-yet-started bash command in this turn will start as a background task. Already-running bash cannot be detached safely.`;
		ctx.ui.notify(note, "info");
	};

	const backgroundBashCommand = (command: string, cwd: string | undefined, decision: BashBackgroundDecision): ManagedTask => {
		return spawnTask({
			command,
			cwd,
			notifyOnExit: decision.notifyOnExit,
			notifyOnOutput: decision.notifyOnOutput,
			notifyPattern: decision.notifyPattern,
			title: decision.title,
		});
	};

	const decisionForBashCommand = (command: string, cwd?: string): BashBackgroundDecision | null => {
		if (!command.trim()) return null;
		if (consumeForcedBackground(cwd)) return forcedBackgroundDecision(command, cwd);
		if (!settingBoolean("autoBackgroundBash", true, cwd)) return null;
		return autoBackgroundDecision(command, cwd);
	};

	const openDashboard = async (
		ctx: ExtensionCommandContext | ExtensionContext,
		initialTask: ManagedTask | null = null,
	): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatTaskListText(), "info");
			return;
		}

		const releaseModalLock = acquireVstackModalLock();
		try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				let selectedId: string | null = initialTask?.id ?? sortedTasks()[0]?.id ?? null;
				let taskScroll = 0;
				let outputScroll = 0;
				let followOutput = true;
				let activePane: "tasks" | "output" = "tasks";
				let timer: ReturnType<typeof setInterval> | null = null;

				const ensureDashboardTimer = () => {
					const hasRunning = sortedTasks().some((task) => task.status === "running");
					if (!hasRunning) {
						if (timer) clearInterval(timer);
						timer = null;
						return;
					}
					if (timer) return;
					timer = setInterval(() => tui.requestRender(), 1_000);
					timer.unref?.();
				};

				const selectedTask = (): ManagedTask | null => {
					const sorted = sortedTasks();
					if (sorted.length === 0) return null;
					const current = selectedId ? tasks.get(selectedId) : undefined;
					if (current) return current;
					selectedId = sorted[0]?.id ?? null;
					return selectedId ? (tasks.get(selectedId) ?? null) : null;
				};

				const dashboardFrameRows = (): number => {
					const rows = Number(tui.terminal?.rows ?? 32);
					return Math.max(DASHBOARD_MIN_FRAME_ROWS, Math.floor(Math.max(1, rows) * 0.72));
				};
				const dashboardInnerRows = (): number => Math.max(4, dashboardFrameRows() - DASHBOARD_FRAME_VERTICAL_OVERHEAD);
				const dashboardBodyRows = (): number => Math.max(1, dashboardInnerRows() - 2);
				const taskRows = (): number => Math.max(1, dashboardBodyRows() - 1);
				const outputRows = (): number => Math.max(3, dashboardBodyRows() - 10);

				const getOutputLines = (task: ManagedTask | null): string[] => splitOutputLines(task ? getTaskOutput(task) : "");
				const maxOutputScroll = (task: ManagedTask | null): number => Math.max(0, getOutputLines(task).length - outputRows());

				const syncTaskScroll = () => {
					const sorted = sortedTasks();
					const index = Math.max(
						0,
						sorted.findIndex((task) => task.id === selectedId),
					);
					const rows = taskRows();
					const max = Math.max(0, sorted.length - rows);
					if (index < taskScroll) taskScroll = index;
					if (index >= taskScroll + rows) taskScroll = index - rows + 1;
					taskScroll = clamp(taskScroll, 0, max);
				};

				const syncOutputScroll = (forceBottom = false) => {
					const max = maxOutputScroll(selectedTask());
					if (forceBottom || followOutput) outputScroll = max;
					else outputScroll = clamp(outputScroll, 0, max);
				};

				const moveSelection = (delta: number) => {
					const sorted = sortedTasks();
					if (sorted.length === 0) {
						selectedId = null;
						return;
					}
					const currentIndex = Math.max(
						0,
						sorted.findIndex((task) => task.id === selectedId),
					);
					selectedId = sorted[clamp(currentIndex + delta, 0, sorted.length - 1)]?.id ?? null;
					syncTaskScroll();
					syncOutputScroll(true);
					tui.requestRender();
				};

				const moveOutput = (delta: number) => {
					followOutput = false;
					outputScroll = clamp(outputScroll + delta, 0, maxOutputScroll(selectedTask()));
					if (outputScroll >= maxOutputScroll(selectedTask())) followOutput = true;
					tui.requestRender();
				};

				const renderLines = (width: number): string[] => {
					const sorted = sortedTasks();
					const running = sorted.filter((task) => task.status === "running").length;
					const selected = selectedTask();
					const bodyRows = dashboardBodyRows();
					const taskViewportRows = taskRows();
					const outputViewportRows = outputRows();
					syncTaskScroll();
					syncOutputScroll();

					const lines: string[] = [];
					const footer = `${ansiYellow("←/→ tab")} ${theme.fg("dim", "pane · ")}${ansiYellow("↑↓")} ${theme.fg("dim", activePane === "tasks" ? "select · " : "scroll output · ")}${ansiYellow("s")} ${theme.fg("dim", "stop · ")}${ansiYellow("c")} ${theme.fg("dim", "clear · ")}${ansiYellow("f")} ${theme.fg("dim", "follow · ")}${ansiYellow("PgUp/PgDn")} ${theme.fg("dim", "page output · ")}${ansiYellow("esc")} ${theme.fg("dim", "close")}`;

					if (sorted.length === 0) {
						lines.push(theme.fg("dim", "No background tasks yet. Use /bg run <command> or the bg_task tool."));
						while (lines.length < bodyRows) lines.push("");
						lines.push("", ...wrapTextWithAnsi(footer, Math.max(1, width)));
						return lines.map((line) => truncateToWidth(line, width, ""));
					}

					const taskPaneWidth = clamp(Math.floor(width * 0.34), TASK_PANE_MIN_WIDTH, TASK_PANE_MAX_WIDTH);
					const detailPaneWidth = Math.max(24, width - taskPaneWidth - 3);
					const left: string[] = [];
					const right: string[] = [];

					left.push(`${activePane === "tasks" ? activePill(theme, " Tasks ") : inactivePill(theme, " Tasks ")} ${theme.fg("dim", `(${sorted.length})`)}`);
					if (taskScroll > 0) left.push(theme.fg("dim", `↑ ${taskScroll} earlier task(s)`));
					for (const task of sorted.slice(taskScroll, taskScroll + taskViewportRows)) {
						const isSelected = task.id === selected?.id;
						const row = ` ${bgStatusIcon(task.status, theme)} ${theme.fg("accent", task.id)} ${theme.fg(
							isSelected ? "text" : "dim",
							`${summarizeTaskStatus(task.status, task.exitCode)} · ${compactText(taskDisplayName(task), Math.max(12, taskPaneWidth - 24))}`,
						)}`;
						left.push(isSelected ? theme.bg("selectedBg", padAnsi(row, taskPaneWidth)) : row);
					}
					const hiddenBelow = Math.max(0, sorted.length - (taskScroll + taskViewportRows));
					if (hiddenBelow > 0) left.push(theme.fg("dim", `↓ ${hiddenBelow} more task(s)`));

					if (!selected) {
						right.push(theme.fg("dim", "Select a task to inspect output."));
					} else {
						const outputLines = getOutputLines(selected);
						const visibleOutput = outputLines.slice(outputScroll, outputScroll + outputViewportRows);
						right.push(`${activePane === "output" ? activePill(theme, ` Watch ${selected.id} `) : inactivePill(theme, ` Watch ${selected.id} `)} ${theme.fg("dim", followOutput ? "follow" : `line ${outputScroll + 1}`)}`);
						right.push(`${theme.fg("muted", "Status")}: ${bgStatusText(taskSnapshot(selected), theme)} · pid ${selected.pid}`);
						right.push(`${theme.fg("muted", "Started")}: ${formatRelativeTime(selected.startedAt)} · ${formatDuration(taskElapsedMs(selected))} elapsed`);
						if (selected.expiresAt != null) right.push(`${theme.fg("muted", "Expiry")}: ${formatRelativeTime(selected.expiresAt)}`);
						right.push(`${theme.fg("muted", "Command")}: ${selected.command}`);
						right.push(`${theme.fg("muted", "Cwd")}: ${selected.cwd}`);
						right.push(`${theme.fg("muted", "Log")}: ${selected.logFile}`);
						right.push(
							`${theme.fg("muted", "Wakeups")}: exit=${selected.notifyOnExit ? "yes" : "no"}, output=${
								selected.notifyOnOutput ? (selected.notifyPattern ?? "yes") : "no"
							}`,
						);
						right.push("", theme.fg("muted", theme.bold("Output")));
						if (outputScroll > 0) right.push(theme.fg("dim", `↑ ${outputScroll} older line(s)`));
						right.push(...visibleOutput);
						const below = Math.max(0, outputLines.length - (outputScroll + outputViewportRows));
						if (below > 0) right.push(theme.fg("dim", `↓ ${below} newer line(s)`));
					}

					const rowCount = Math.min(bodyRows, Math.max(left.length, right.length));
					for (let i = 0; i < rowCount; i += 1) {
						lines.push(`${padAnsi(left[i] ?? "", taskPaneWidth)}${theme.fg("dim", " │ ")}${truncateToWidth(right[i] ?? "", detailPaneWidth, "")}`);
					}
					while (lines.length < bodyRows) lines.push("");
					lines.push("", ...wrapTextWithAnsi(footer, Math.max(1, width)));
					return lines.map((line) => truncateToWidth(line, width, ""));
				};

				return {
					dispose() {
						if (timer) clearInterval(timer);
						timer = null;
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done(undefined);
							return;
						}
						if (matchesKey(data, "left")) { activePane = "tasks"; tui.requestRender(); return; }
						if (matchesKey(data, "right")) { activePane = "output"; tui.requestRender(); return; }
						if (matchesKey(data, "tab")) { activePane = activePane === "tasks" ? "output" : "tasks"; tui.requestRender(); return; }
						if (matchesKey(data, "up")) return activePane === "tasks" ? moveSelection(-1) : moveOutput(-1);
						if (matchesKey(data, "down")) return activePane === "tasks" ? moveSelection(1) : moveOutput(1);
						if (matchesKey(data, "home")) { if (activePane === "tasks") return moveSelection(-Number.MAX_SAFE_INTEGER); followOutput = false; outputScroll = 0; tui.requestRender(); return; }
						if (matchesKey(data, "end")) { if (activePane === "tasks") return moveSelection(Number.MAX_SAFE_INTEGER); syncOutputScroll(true); tui.requestRender(); return; }
						if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) return moveOutput(-outputRows());
						if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) return moveOutput(outputRows());
						if (data === "f") {
							followOutput = !followOutput;
							syncOutputScroll(followOutput);
							tui.requestRender();
							return;
						}
						if (data === "s") {
							requestStop(selectedTask(), "user");
							tui.requestRender();
							return;
						}
						if (data === "c") {
							clearFinishedTasks();
							tui.requestRender();
						}
					},
					invalidate() {},
					render(width: number) {
						ensureDashboardTimer();
						const sorted = sortedTasks();
						const running = sorted.filter((task) => task.status === "running").length;
						return frameDashboard(renderLines(dashboardContentWidth(width)), width, theme, "Background Tasks", `${running} running · ${sorted.length - running} finished`);
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: DASHBOARD_MAX_HEIGHT, width: DASHBOARD_WIDTH } },
		);
		} finally {
			releaseModalLock();
		}
	};

	pi.registerMessageRenderer(BG_MESSAGE_TYPE, (message, { expanded }, theme) => renderTaskEventMessage(message, expanded, theme));

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const task of tasks.values()) {
			if (task.status === "running") {
				task.stopReason = "shutdown";
				killTaskProcess(task, "SIGTERM");
				killTaskProcess(task, "SIGKILL");
			}
			clearTaskTimers(task);
		}
		clearWidget();
		activeCtx = null;
	});

	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (event?.toolName !== "bash") return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		const decision = decisionForBashCommand(command, ctx.cwd);
		if (!decision) return undefined;

		const task = backgroundBashCommand(command, ctx.cwd, decision);
		event.input.command = bashBackgroundAck(rememberSnapshot(task), decision);
		if (ctx.hasUI) {
			const label = decision.forced ? "Shortcut moved bash to background" : "Auto-backgrounded bash";
			ctx.ui.notify(`${label}: ${task.id} (pid ${task.pid})`, "info");
		}
		return undefined;
	});

	pi.on("user_bash", (event: any, ctx: ExtensionContext) => {
		activeCtx = ctx;
		const command = typeof event?.command === "string" ? event.command : "";
		const decision = decisionForBashCommand(command, event?.cwd ?? ctx.cwd);
		if (!decision) return undefined;

		const task = backgroundBashCommand(command, event?.cwd ?? ctx.cwd, decision);
		const output = bashBackgroundAckText(rememberSnapshot(task), decision);
		if (ctx.hasUI) {
			const label = decision.forced ? "Shortcut moved user bash to background" : "Auto-backgrounded user bash";
			ctx.ui.notify(`${label}: ${task.id} (pid ${task.pid})`, "info");
		}
		return { result: { output, exitCode: 0, cancelled: false, truncated: false } };
	});

	pi.registerTool({
		renderShell: "self",
		name: "bg_status",
		label: "Background Process Status",
		description: "List, tail, or stop background tasks spawned by bg_task or /bg. Use pid for log/stop.",
		parameters: Type.Object({
			action: StringEnum(["list", "log", "stop"] as const, {
				description: "list=show tracked tasks, log=view task output by pid, stop=terminate by pid",
			}),
			pid: Type.Optional(Type.Number({ description: "Task pid for action=log or action=stop" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.action === "list") return makeToolResult(formatTaskListText(), { action: "list", tasks: sortedTasks().map(rememberSnapshot) });
			const task = resolveTask(undefined, params.pid);
			if (!task) throw new Error("No background task matched that pid.");
			if (params.action === "log") {
				const output = getTaskOutput(task);
				const truncation = taskLogTruncation(output, task.logFile, activeCtx?.cwd);
				return makeToolResult(formatTaskLog(output, task.logFile, activeCtx?.cwd), {
					action: "log",
					task: rememberSnapshot(task),
					...(truncation ? { fullOutputPath: task.logFile, truncation } : {}),
				});
			}
			const stopped = requestStop(task, "user");
			if (!stopped.ok) throw new Error(stopped.message);
			return makeToolResult(stopped.message, { action: "stop", task: rememberSnapshot(task) });
		},
		renderCall() {
			return renderEmpty();
		},
		renderResult(result: any, options: any, theme: Theme, context: any) {
			return renderBgToolResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		renderShell: "self",
		name: "bg_task",
		label: "Background Task",
		description:
			"Spawn, inspect, and stop explicit background shell tasks without blocking the current turn. Tasks write persistent logs, do not time out by default, stop as a process group on Unix, and can wake the agent on exit or matching output. The background-tasks extension also auto-diverts recognized bash monitoring loops before they block.",
		promptSnippet: "Spawn, inspect, and stop explicit non-blocking background shell tasks.",
		promptGuidelines: [
			"Use bg_task instead of bash backgrounding/nohup when the user wants a long-running command to continue while the conversation remains usable.",
			"Use bg_task list/log/stop to inspect or terminate tasks started by bg_task or /bg.",
			"Use bg_task for pi-bridge, session, tmux, subagent, or log monitoring instead of raw foreground bash polling loops.",
			"If a bash monitor is auto-backgrounded, continue the turn and inspect it later with bg_task log/list/stop rather than waiting on foreground bash.",
		],
		parameters: Type.Object({
			action: StringEnum(["spawn", "list", "log", "stop", "clear"] as const, {
				description: "spawn=start a task, list=show tasks, log=view output, stop=terminate, clear=remove finished tasks",
			}),
			command: Type.Optional(Type.String({ description: "Shell command for action=spawn" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=spawn" })),
			id: Type.Optional(Type.String({ description: "Task id for action=log or action=stop" })),
			notifyOnExit: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits. Defaults to true." })),
			notifyOnOutput: Type.Optional(Type.Boolean({ description: "Wake the agent when new output arrives. Defaults to false." })),
			notifyPattern: Type.Optional(Type.String({ description: "Substring or /regex/flags gate for output wakeups." })),
			pid: Type.Optional(Type.Number({ description: "PID for action=log or action=stop" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout for spawned tasks. Defaults to 0 (disabled)." })),
			title: Type.Optional(Type.String({ description: "Optional display label for action=spawn" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.action === "list") return makeToolResult(formatTaskListText(), { action: "list", tasks: sortedTasks().map(rememberSnapshot) });
			if (params.action === "clear") {
				const removed = clearFinishedTasks();
				return makeToolResult(`Removed ${removed} finished background task(s).`, { action: "clear", removed });
			}

			if (params.action === "spawn") {
				const task = spawnTask({
					command: params.command ?? "",
					cwd: params.cwd,
					notifyOnExit: params.notifyOnExit,
					notifyOnOutput: params.notifyOnOutput,
					notifyPattern: params.notifyPattern,
					timeoutSeconds: params.timeoutSeconds,
					title: params.title,
				});
				return makeToolResult(
					`Started ${task.id} (pid ${task.pid}) in the background.\nCommand: ${task.command}\nCwd: ${task.cwd}\nLog: ${task.logFile}\nExpiry: ${
						task.expiresAt != null ? formatRelativeTime(task.expiresAt) : "none"
					}\nWakeups: exit=${task.notifyOnExit ? "yes" : "no"}, output=${
						task.notifyOnOutput ? (task.notifyPattern ?? "yes") : "no"
					}`,
					{ action: "spawn", task: rememberSnapshot(task) },
				);
			}

			const task = resolveTask(params.id, params.pid);
			if (!task) throw new Error("No background task matched that id or pid.");
			if (params.action === "log") {
				const output = getTaskOutput(task);
				const truncation = taskLogTruncation(output, task.logFile, activeCtx?.cwd);
				return makeToolResult(formatTaskLog(output, task.logFile, activeCtx?.cwd), {
					action: "log",
					task: rememberSnapshot(task),
					...(truncation ? { fullOutputPath: task.logFile, truncation } : {}),
				});
			}
			const stopped = requestStop(task, "user");
			if (!stopped.ok) throw new Error(stopped.message);
			return makeToolResult(stopped.message, { action: "stop", task: rememberSnapshot(task) });
		},
		renderCall() {
			return renderEmpty();
		},
		renderResult(result: any, options: any, theme: Theme, context: any) {
			return renderBgToolResult(result, options, theme, context);
		},
	});

	pi.registerCommand(BG_COMMAND, {
		description: "Background shell task dashboard and controls.",
		getArgumentCompletions(prefix) {
			const trimmed = prefix.trimStart();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length === 0 || (parts.length === 1 && !trimmed.endsWith(" "))) {
				return [
					{ label: "list", value: "list", description: "Show tracked tasks" },
					{ label: "next", value: "next", description: "Move the next bash command to background" },
					{ label: "run", value: "run ", description: "Spawn a background shell task" },
					{ label: "log", value: "log ", description: "Show task log tail" },
					{ label: "watch", value: "watch ", description: "Open the dashboard focused on a task" },
					{ label: "stop", value: "stop ", description: "Terminate a running task" },
					{ label: "clear", value: "clear", description: "Remove finished tasks" },
				].filter((option) => option.value.trim().startsWith(trimmed.toLowerCase()));
			}
			const [subcommand] = parts;
			if (!(subcommand === "log" || subcommand === "stop" || subcommand === "watch")) return null;
			if (parts.length > 2 || (parts.length === 2 && trimmed.endsWith(" "))) return null;
			const taskQuery = parts[1]?.toLowerCase() ?? "";
			const taskItems = sortedTasks()
				.filter((task) => !taskQuery || task.id.toLowerCase().startsWith(taskQuery) || String(task.pid).startsWith(taskQuery))
				.map((task) => ({
					description: `${summarizeTaskStatus(task.status, task.exitCode)} · ${task.command}`,
					label: task.id,
					value: `${subcommand} ${task.id}`,
				}));
			return taskItems.length > 0 ? taskItems : null;
		},
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed) {
				await openDashboard(ctx);
				return;
			}
			if (trimmed === "list") {
				ctx.ui.notify(formatTaskListText(), "info");
				return;
			}
			if (trimmed === "next") {
				armForcedBackground(ctx, "command");
				return;
			}
			if (trimmed === "clear") {
				ctx.ui.notify(`Removed ${clearFinishedTasks()} finished background task(s).`, "info");
				return;
			}
			if (trimmed.startsWith("run ")) {
				const task = spawnTask({ command: trimmed.slice(4), cwd: ctx.cwd });
				ctx.ui.notify(`Started ${task.id} (pid ${task.pid}) in the background.`, "info");
				return;
			}
			const inspectMatch = trimmed.match(/^(?:watch|log)\s+(.+)$/);
			if (inspectMatch) {
				const task = resolveTask(inspectMatch[1]?.trim());
				if (!task) {
					ctx.ui.notify("No background task matched that id or pid.", "warning");
					return;
				}
				if (trimmed.startsWith("log ")) ctx.ui.notify(formatTaskLog(getTaskOutput(task), task.logFile, ctx.cwd), "info");
				else await openDashboard(ctx, task);
				return;
			}
			if (trimmed.startsWith("stop ")) {
				const stopped = requestStop(resolveTask(trimmed.slice(5).trim()), "user");
				ctx.ui.notify(stopped.message, stopped.ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify(
				`Unknown /${BG_COMMAND} action. Try run <command>, list, log <id>, watch <id>, stop <id>, or clear.`,
				"warning",
			);
		},
	});

	if (dashboardShortcut !== "none") {
		pi.registerShortcut(dashboardShortcut, {
			description: "Open the background task dashboard",
			handler: async (ctx) => {
				activeCtx = ctx as ExtensionContext;
				await openDashboard(ctx as ExtensionContext);
			},
		});
	}
	if (backgroundBashShortcut !== "none") {
		pi.registerShortcut(backgroundBashShortcut, {
			description: "Move the next not-yet-started bash command to a background task",
			handler: async (ctx) => {
				activeCtx = ctx as ExtensionContext;
				armForcedBackground(ctx as ExtensionContext, "shortcut");
			},
		});
	}
	if (widgetToggleShortcut !== "none") {
		pi.registerShortcut(widgetToggleShortcut, {
			description: "Cycle background task mini-dashboard compact/expanded/hidden",
			handler: async (ctx) => {
				activeCtx = ctx as ExtensionContext;
				widgetMode = widgetMode === "compact" ? "expanded" : widgetMode === "expanded" ? "hidden" : "compact";
				syncWidget(ctx as ExtensionContext);
			},
		});
	}
}
