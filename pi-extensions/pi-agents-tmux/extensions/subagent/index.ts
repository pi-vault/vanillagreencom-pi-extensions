/**
 * Agent delegation tool - delegate tasks to specialized agents.
 *
 * Spawns a separate `pi` process for each agent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from agents.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getMarkdownTheme,
	type Theme,
	truncateHead,
	truncateTail,
	type TruncationResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, matchesKey, Spacer, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const PACKAGE_ID = "pi-agents-tmux";
const CONFIG_ID = "@vanillagreen/pi-agents-tmux";
const SESSION_BRIDGE_PACKAGE_ID = "@vanillagreen/pi-session-bridge";
const INSTALL_SYMBOL = Symbol.for("vstack.pi-agents-tmux.installed");
const STATUSLINE_SYMBOL = Symbol.for("vstack.pi-agents-tmux.statusline");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PANE_LAUNCHER_VERSION = 9;
const SUBAGENT_WIDGET_KEY = "vstack-agents-dashboard";
const FIRST_AGENT_COLUMN_ROWS = 3;
const NEXT_AGENT_COLUMN_ROWS = 4;
const DETAIL_STRING_MAX_CHARS = 8 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 100 * 1024;
const DEFAULT_RESULT_MAX_LINES = 4_000;
const TRACE_VIEWER_WIDTH = "92%";
const TRACE_VIEWER_MAX_HEIGHT = "88%";
const AGENT_EDIT_CONFIRM_WIDTH = 96;
const MALFORMED_COMPLETION_GRACE_MS = 1_500;

type AgentAsciiColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";

interface SubagentStatuslineInfo {
	name: string;
	color?: AgentAsciiColor;
}

interface SubagentStatuslineBridge {
	getCurrentSubagent(cwd?: string): SubagentStatuslineInfo | undefined;
}

const AGENT_ASCII_COLOR_SEQUENCE: AgentAsciiColor[] = ["magenta", "green", "blue", "cyan", "yellow", "red"];

// Nerd Font glyphs (Font Awesome subset). All terminal output uses these
// instead of unicode geometric/emoji shapes so rendering is consistent
// regardless of font fallback behavior.
const ICONS = {
	check: "\uf00c",        // nf-fa-check (completed / done)
	times: "\uf00d",        // nf-fa-times (failed / blocked)
	circleFilled: "\uf111", // nf-fa-circle
	circleOpen: "\uf10c",   // nf-fa-circle_o
	clock: "\uf017",        // nf-fa-clock_o (queued / waiting)
	cog: "\uf013",          // nf-fa-cog (working / running)
	refresh: "\uf021",      // nf-fa-refresh (turns)
	hourglass: "\uf252",    // nf-fa-hourglass_half (legacy / unused)
	warning: "\uf071",      // nf-fa-exclamation_triangle (general warning)
	dotSmall: "\uf444",     // nf-fa-circle (smaller filled circle)
} as const;

type VstackConfig = Record<string, unknown>;

function normalizeAgentAsciiColor(value: string | undefined): AgentAsciiColor | undefined {
	const normalized = value?.trim().toLowerCase().replace(/[^a-z]/g, "");
	switch (normalized) {
		case "red": return "red";
		case "green": return "green";
		case "yellow":
		case "orange": return "yellow";
		case "blue": return "blue";
		case "magenta":
		case "purple":
		case "violet": return "magenta";
		case "cyan":
		case "teal": return "cyan";
		default: return undefined;
	}
}

function defaultAgentAsciiColor(agentName: string, agents: AgentConfig[]): AgentAsciiColor {
	const names = agents.map((agent) => agent.name).sort((a, b) => a.localeCompare(b));
	const index = Math.max(0, names.indexOf(agentName));
	return AGENT_ASCII_COLOR_SEQUENCE[index % AGENT_ASCII_COLOR_SEQUENCE.length] ?? "magenta";
}

function resolveSubagentStatuslineInfo(agentName: string | undefined, cwd?: string): SubagentStatuslineInfo | undefined {
	const name = agentName?.trim();
	if (!name) return undefined;
	const envColor = normalizeAgentAsciiColor(process.env.PI_SUBAGENT_CHILD_COLOR);
	try {
		const agents = discoverAgents(cwd ?? process.cwd(), "both").agents;
		const agent = agents.find((candidate) => candidate.name === name);
		const color = normalizeAgentAsciiColor(agent?.color) ?? envColor ?? defaultAgentAsciiColor(name, agents);
		return { name, color };
	} catch {
		return { name, color: envColor };
	}
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function piUserDir(): string {
	return path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function sessionIdForContext(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (id && id.trim()) return id;
	const file = ctx.sessionManager.getSessionFile();
	if (file) return path.basename(file, path.extname(file));
	return `ephemeral-${process.pid}`;
}

function runtimeSessionId(ctx: ExtensionContext): string {
	const parentSessionId = process.env.PI_SUBAGENT_PARENT_SESSION_ID?.trim();
	// Only child pane processes should inherit the parent runtime scope. If a normal
	// parent Pi process has this environment variable accidentally set, using it
	// would make pane registries and bridge targeting bleed across sessions.
	if (process.env.PI_SUBAGENT_CHILD_AGENT && parentSessionId) return parentSessionId;
	return sessionIdForContext(ctx);
}

function sessionRuntimeDir(sessionId: string): string {
	return path.join(piUserDir(), "vstack", PACKAGE_ID, "sessions", safeFileName(sessionId));
}

function runtimeDirForContext(ctx: ExtensionContext): string {
	return sessionRuntimeDir(runtimeSessionId(ctx));
}

function projectSettingsPath(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		if (fs.existsSync(path.join(current, ".pi")) || fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, ".vstack-lock.json"))) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return path.join(path.resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function piSettingsPaths(cwd = process.cwd()): string[] {
	return [path.join(piUserDir(), "settings.json"), projectSettingsPath(cwd)];
}

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const settingsPath of piSettingsPaths(cwd)) {
		if (!fs.existsSync(settingsPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
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

function subagentToolAccess(cwd?: string): "frontmatter" | "all" {
	return settingString("subagentToolAccess", "all", cwd) === "frontmatter" ? "frontmatter" : "all";
}

function subagentModelSource(cwd?: string): "frontmatter" | "parent" {
	return settingString("subagentModelSource", "frontmatter", cwd) === "parent" ? "parent" : "frontmatter";
}

function selectedModelForAgent(agent: AgentConfig, parentModel: string | undefined, cwd?: string): string | undefined {
	return subagentModelSource(cwd) === "parent" ? (parentModel ?? agent.model) : (agent.model ?? parentModel);
}

const CHILD_TOOL_DENYLIST = new Set(["subagent", "get_subagent_result", "steer_subagent", "stop_subagent", "question"]);

function normalizedPiToolName(tool: string): string {
	return tool.trim().toLowerCase().replace(/-/g, "_");
}

function selectedToolsForAgent(agent: AgentConfig, cwd: string | undefined, extraTools: string[] = [], activeTools?: string[]): string[] | undefined {
	const baseTools = subagentToolAccess(cwd) === "all" ? (activeTools ?? agent.tools ?? []) : (agent.tools ?? []);
	const denied = new Set([
		...Array.from(CHILD_TOOL_DENYLIST),
		...(agent.denyTools ?? []).map(normalizedPiToolName),
	]);
	const tools = [...baseTools, ...extraTools]
		.map((tool) => tool.trim())
		.filter((tool) => tool && !denied.has(normalizedPiToolName(tool)));
	return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function oneLinePreview(text: string | undefined, maxChars: number): string {
	const compact = (text ?? "").replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

function compactPath(filePath: string | undefined, options?: { baseDir?: string; maxChars?: number }): string {
	const raw = filePath?.trim();
	if (!raw) return "";
	const home = os.homedir();
	let compact = raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
	if (options?.baseDir) {
		const relative = path.relative(options.baseDir, raw);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) compact = relative;
	}
	return oneLinePreview(compact, options?.maxChars ?? 96);
}

function shortTaskId(taskId: string | undefined, maxChars = 36): string {
	return oneLinePreview(taskId, maxChars);
}

function subagentTreeStyle(cwd?: string): "unicode" | "ascii" {
	const value = readVstackConfig(cwd).treeStyle;
	return value === "ascii" || value === "unicode" ? value : "unicode";
}

function subagentBranch(theme: Theme, branch: "├" | "└" | "│", cwd?: string): string {
	if (subagentTreeStyle(cwd) === "ascii") {
		if (branch === "│") return theme.fg("muted", "|  ");
		return theme.fg("muted", branch === "└" ? "`-- " : "|-- ");
	}
	if (branch === "│") return theme.fg("muted", "│  ");
	return theme.fg("muted", `${branch}─ `);
}

function subagentStem(theme: Theme, isLast: boolean, cwd?: string): string {
	return isLast ? theme.fg("muted", subagentTreeStyle(cwd) === "ascii" ? "    " : "   ") : subagentBranch(theme, "│", cwd);
}

function padAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_MAGENTA_FG = "\x1b[35m";
const ANSI_FG_RESET = "\x1b[39m";
function ansiGreen(text: string): string { return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`; }
function ansiYellow(text: string): string { return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`; }
function ansiMagenta(text: string): string { return `${ANSI_MAGENTA_FG}${text}${ANSI_FG_RESET}`; }

function simpleFrame(lines: string[], width: number, theme: Theme, title = ""): string[] {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));
	const border = (text: string) => theme.fg("borderAccent", text);
	const innerWidth = Math.max(1, width - 4);
	const top = () => {
		if (!title) return `${border("┏")}${border("━".repeat(width - 2))}${border("┓")}`;
		const titlePlain = ` ${truncateToWidth(title, Math.max(1, width - 4), "…")} `;
		const fill = Math.max(1, width - 2 - visibleWidth(titlePlain));
		return `${border("┏")}${ansiGreen(titlePlain)}${border("━".repeat(fill))}${border("┓")}`;
	};
	return [
		top(),
		...lines.map((line) => `${border("┃")} ${padAnsi(truncateToWidth(line, innerWidth, ""), innerWidth)} ${border("┃")}`),
		`${border("┗")}${border("━".repeat(width - 2))}${border("┛")}`,
	].map((line) => truncateToWidth(line, width, ""));
}

function activePill(theme: Theme, label: string): string {
	return theme.fg("accent", theme.inverse(theme.bold(label)));
}

function inactivePill(theme: Theme, label: string): string {
	return theme.bg("selectedBg", theme.fg("accent", label));
}

function divider(width: number, theme: Theme): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

function dashboardEnabled(cwd?: string): boolean {
	return settingBoolean("dashboard", true, cwd);
}

function quietInline(cwd?: string): boolean {
	return settingBoolean("quietInlineWhenDashboard", true, cwd);
}

function dashboardMaxItems(cwd?: string): number {
	return Math.max(1, Math.floor(settingNumber("dashboardMaxItems", 6, cwd)));
}

function dashboardDefaultCollapsed(cwd?: string): boolean {
	return settingBoolean("dashboardCollapsed", false, cwd);
}

function dashboardShortcut(cwd?: string): string {
	return settingString("dashboardShortcut", "alt+a", cwd);
}

function popupShortcut(cwd?: string): string {
	return settingString("popupShortcut", "alt+shift+a", cwd);
}

function formatShortcutHint(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
		.join("+");
}

async function parseTranscriptUsage(transcriptPath: string | undefined): Promise<{ usage: UsageStats; model?: string } | undefined> {
	if (!transcriptPath) return undefined;
	let content: string;
	try {
		content = await fs.promises.readFile(transcriptPath, "utf-8");
	} catch {
		return undefined;
	}
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let model: string | undefined;
	let bestPerTurn: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined;
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		// Oneshot transcripts wrap pi events in {ts, stream, raw, event}; pane
		// transcripts write the raw pi event directly. Unwrap one level so the
		// rest of the parser sees the inner shape uniformly.
		const inner = event?.event && typeof event.event === "object" ? event.event : event;
		if (!model && typeof inner?.modelId === "string") model = inner.modelId;
		if (!model && typeof inner?.message?.model === "string") model = inner.message.model;
		const usage = inner?.usage ?? inner?.message?.usage;
		if (!usage || typeof usage !== "object") continue;
		const input = Number((usage as Record<string, unknown>).input ?? (usage as Record<string, unknown>).input_tokens ?? 0) || 0;
		const output = Number((usage as Record<string, unknown>).output ?? (usage as Record<string, unknown>).output_tokens ?? 0) || 0;
		const cacheRead = Number((usage as Record<string, unknown>).cacheRead ?? (usage as Record<string, unknown>).cache_read_input_tokens ?? 0) || 0;
		const cacheWrite = Number((usage as Record<string, unknown>).cacheWrite ?? (usage as Record<string, unknown>).cache_creation_input_tokens ?? 0) || 0;
		const rawCost = (usage as Record<string, unknown>).cost;
		let cost = 0;
		if (typeof rawCost === "number") cost = rawCost;
		else if (rawCost && typeof rawCost === "object") {
			const c = rawCost as Record<string, unknown>;
			cost =
				(Number(c.total) || 0) ||
				((Number(c.input) || 0) +
					(Number(c.output) || 0) +
					(Number(c.cacheRead ?? c.cache_read) || 0) +
					(Number(c.cacheWrite ?? c.cache_write) || 0));
		}
		// Pi emits message_start/message_update/message_end with the same usage
		// progressively; the final value per turn is the one we want, not the sum.
		// Track per-message events grouped by message id when present.
		const type = inner?.type;
		const isFinal = type === "message" || type === "message_end";
		const hasAny = input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || cost > 0;
		if (isFinal && hasAny) {
			total.input += input;
			total.output += output;
			total.cacheRead += cacheRead;
			total.cacheWrite += cacheWrite;
			total.cost += cost;
			total.turns = (total.turns ?? 0) + 1;
		} else if (hasAny) {
			// message_update events carry the running per-turn usage. Track the
			// max (last) seen so we can fall back to it if no final message arrives.
			bestPerTurn = bestPerTurn ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			bestPerTurn.input = Math.max(bestPerTurn.input, input);
			bestPerTurn.output = Math.max(bestPerTurn.output, output);
			bestPerTurn.cacheRead = Math.max(bestPerTurn.cacheRead, cacheRead);
			bestPerTurn.cacheWrite = Math.max(bestPerTurn.cacheWrite, cacheWrite);
			bestPerTurn.cost = Math.max(bestPerTurn.cost, cost);
		}
	}
	if ((total.turns ?? 0) === 0 && bestPerTurn) {
		total.input = bestPerTurn.input;
		total.output = bestPerTurn.output;
		total.cacheRead = bestPerTurn.cacheRead;
		total.cacheWrite = bestPerTurn.cacheWrite;
		total.cost = bestPerTurn.cost;
		total.turns = 1;
	}
	if ((total.turns ?? 0) === 0 && total.input === 0 && total.output === 0) return undefined;
	return { usage: total, model };
}

function formatUsageStatsForDashboard(usage: {
	input: number;
	output: number;
	cost: number;
	turns?: number;
}): string[] {
	// Slim form for the inline dashboard widget: drop cacheRead/cacheWrite
	// (cluttery and most users do not act on them) and replace the 'turn'
	// word with a small refresh glyph so each row stays compact when many
	// agents are listed. Input/output tokens travel together so they share a
	// single bullet group ('↑7 ↓342') rather than getting split by '·'.
	const parts: string[] = [];
	if (usage.turns) parts.push(`${ICONS.refresh} ${usage.turns}`);
	const tokenBits: string[] = [];
	if (usage.input) tokenBits.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) tokenBits.push(`↓${formatTokens(usage.output)}`);
	if (tokenBits.length > 0) parts.push(tokenBits.join(" "));
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

const AGENTS_BROWSER_WIDTH = "92%";
const AGENTS_BROWSER_MAX_HEIGHT = "90%";
const AGENTS_BROWSER_HEIGHT_RATIO = 0.9;
const AGENTS_LEFT_MIN_WIDTH = 34;
const AGENTS_LEFT_MAX_WIDTH = 48;
const AGENTS_POPUP_PADDING_X = 2;
const AGENTS_POPUP_PADDING_Y = 1;
const AGENTS_POPUP_FRAME_ROWS = 2 + AGENTS_POPUP_PADDING_Y * 2;
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
type AgentBrowserTabId = "active" | "history" | AgentScope;
type AgentBrowserTabDef = { id: AgentBrowserTabId; label: string };
const ACTIVE_BROWSER_TAB: AgentBrowserTabDef = { id: "active", label: "Active" };
const HISTORY_BROWSER_TAB: AgentBrowserTabDef = { id: "history", label: "History" };
const AGENT_SCOPE_TABS: Array<{ id: AgentScope; label: string }> = [
	{ id: "project", label: "Project" },
	{ id: "user", label: "User" },
	{ id: "both", label: "Both" },
];
const HISTORY_SUBTAB_LABELS = ["Summary", "Transcript", "Completion", "Task"] as const;

type AgentBrowserAction =
	| { type: "attach"; agentName: string }
	| { type: "close" }
	| { type: "editFrontmatter"; agentName: string }
	| { type: "insert"; agentName: string }
	| { type: "reload" }
	| { type: "start"; agentName: string }
	| { type: "stop"; agentName: string };

type AgentPaneStatus = { entry?: PaneRegistryEntry; live: boolean };

interface AgentBrowserUiState {
	inspectorScroll: number;
	pane: "list" | "inspector";
	tab: AgentBrowserTabId;
	scope: AgentScope;
	search: string;
	selected: number;
	scroll: number;
	activeSelected: number;
	activeScroll: number;
	historySelected: number;
	historyScroll: number;
	historySubtab: number;
}

type HistoryDetailEntry = { items?: TraceViewerItem[]; loading?: boolean; error?: string };

interface AgentBrowserLayout {
	bodyRows: number;
	innerRows: number;
	listRows: number;
}

interface VstackModalLock {
	depth: number;
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

function agentInlineLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\t/g, " ");
}

function agentPad(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(agentInlineLine(text), safeWidth, "");
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)))}`;
}

function isAgentBrowserTextInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function compactAgentPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

interface AgentFrontmatterEdit {
	model: string;
	tools: string[];
	denyTools: string[];
	color: string;
}

function stripYamlQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
	}
	return trimmed;
}

function splitMarkdownFrontmatter(raw: string): { frontmatter: string; body: string; hasFrontmatter: boolean } {
	if (!raw.startsWith("---\n") && raw.trim() !== "---") return { frontmatter: "", body: raw, hasFrontmatter: false };
	const close = raw.indexOf("\n---", 4);
	if (close < 0) return { frontmatter: "", body: raw, hasFrontmatter: false };
	const afterClose = raw.slice(close + 4).replace(/^\r?\n/, "");
	return { frontmatter: raw.slice(4, close), body: afterClose, hasFrontmatter: true };
}

function flatYamlField(frontmatter: string, key: string): string | undefined {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = frontmatter.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, "m"));
	return match?.[1] === undefined ? undefined : stripYamlQuotes(match[1]);
}

function parseToolsList(value: string | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	const listText = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return listText.split(",").map((tool) => stripYamlQuotes(tool).trim()).filter(Boolean);
}

function agentCurrentFrontmatterEdit(agent: AgentConfig): AgentFrontmatterEdit {
	let frontmatter = "";
	try {
		frontmatter = splitMarkdownFrontmatter(fs.readFileSync(agent.filePath, "utf-8")).frontmatter;
	} catch {
		frontmatter = "";
	}
	const current = {
		model: flatYamlField(frontmatter, "model") ?? agent.model ?? "",
		tools: parseToolsList(flatYamlField(frontmatter, "tools") ?? agent.tools?.join(", ")),
		denyTools: parseToolsList(flatYamlField(frontmatter, "deny-tools") ?? agent.denyTools?.join(", ")),
		color: flatYamlField(frontmatter, "color") ?? agent.color ?? "",
	};
	if (!isVstackManagedAgentFile(agent)) return current;
	const tomlPath = vstackTomlPathForAgent(agent, process.cwd());
	if (!tomlPath) return current;
	const tomlCurrent = readAgentFrontmatterToml(tomlPath, agent.name);
	return {
		model: tomlCurrent.model ?? current.model,
		tools: tomlCurrent.tools ?? current.tools,
		denyTools: tomlCurrent.denyTools ?? current.denyTools,
		color: tomlCurrent.color ?? current.color,
	};
}

function editableAgentFrontmatterText(agent: AgentConfig): string {
	const current = agentCurrentFrontmatterEdit(agent);
	return [
		"# Edit Pi agent frontmatter overrides. Blank values remove the override.",
		"# For vstack-managed project agents, this writes [agent-frontmatter.pi] in vstack.toml.",
		`model: ${current.model}`,
		`deny-tools: ${current.denyTools.join(", ")}`,
		`tools: ${current.tools.join(", ")}`,
		`color: ${current.color}`,
		"",
	].join("\n");
}

function parseEditableAgentFrontmatterText(raw: string): AgentFrontmatterEdit {
	const fields = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (!match) throw new Error(`Expected 'key: value' line, got: ${trimmed}`);
		const key = match[1].toLowerCase();
		if (key === "model" || key === "tools" || key === "deny-tools" || key === "color") fields.set(key, match[2] ?? "");
	}
	return {
		model: stripYamlQuotes(fields.get("model") ?? ""),
		tools: parseToolsList(fields.get("tools")),
		denyTools: parseToolsList(fields.get("deny-tools")),
		color: stripYamlQuotes(fields.get("color") ?? ""),
	};
}

function isVstackManagedAgentFile(agent: AgentConfig): boolean {
	try {
		const raw = fs.readFileSync(agent.filePath, "utf-8");
		return raw.includes("Never edit this file directly") && raw.includes("vstack refresh");
	} catch {
		return false;
	}
}

function projectRootForAgentFile(agent: AgentConfig, cwd: string): string {
	const normalized = path.resolve(agent.filePath);
	for (const marker of [`${path.sep}.pi${path.sep}agents${path.sep}`, `${path.sep}.claude${path.sep}agents${path.sep}`]) {
		const idx = normalized.indexOf(marker);
		if (idx >= 0) return normalized.slice(0, idx);
	}
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, "vstack.toml")) || fs.existsSync(path.join(current, ".vstack-lock.json")) || fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

function vstackTomlPathForAgent(agent: AgentConfig, cwd: string): string | undefined {
	let current = projectRootForAgentFile(agent, cwd);
	while (true) {
		const candidate = path.join(current, "vstack.toml");
		if (fs.existsSync(candidate)) return candidate;
		if (fs.existsSync(path.join(current, ".vstack-lock.json")) || fs.existsSync(path.join(current, ".git"))) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function tomlArray(values: string[]): string {
	return `[${values.map(tomlString).join(", ")}]`;
}

function splitTopLevelCommas(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	let bracketDepth = 0;
	let escaped = false;
	for (const char of input) {
		if (escaped) { current += char; escaped = false; continue; }
		if (char === "\\") { current += char; escaped = true; continue; }
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") { quote = char; current += char; continue; }
		if (char === "[") bracketDepth += 1;
		if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		if (char === "," && bracketDepth === 0) { out.push(current.trim()); current = ""; continue; }
		current += char;
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

function parseInlineTomlTable(value: string): Map<string, string> {
	const map = new Map<string, string>();
	const trimmed = value.trim().replace(/^\{/, "").replace(/\}$/, "");
	for (const part of splitTopLevelCommas(trimmed)) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
	}
	return map;
}

function readAgentFrontmatterToml(tomlPath: string, agentName: string): Partial<AgentFrontmatterEdit> {
	let content = "";
	try { content = fs.readFileSync(tomlPath, "utf-8"); } catch { return {}; }
	const lines = content.split(/\r?\n/);
	const sectionStart = lines.findIndex((line) => line.trim() === "[agent-frontmatter.pi]");
	if (sectionStart < 0) return {};
	let sectionEnd = lines.length;
	for (let i = sectionStart + 1; i < lines.length; i += 1) {
		if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
		if (lines[i].trim().startsWith("# ──")) { sectionEnd = i; break; }
	}
	const keyRe = new RegExp(`^\\s*(?:${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${tomlString(agentName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*=`);
	const line = lines.slice(sectionStart + 1, sectionEnd).find((candidate) => keyRe.test(candidate));
	if (!line) return {};
	const existingValue = line.split(/=(.*)/s)[1] ?? "";
	const fields = parseInlineTomlTable(existingValue.trim());
	return {
		model: fields.has("model") ? stripYamlQuotes(fields.get("model") ?? "") : undefined,
		tools: fields.has("tools") ? parseToolsList(fields.get("tools")) : undefined,
		denyTools: fields.has("deny-tools") ? parseToolsList(fields.get("deny-tools")) : undefined,
		color: fields.has("color") ? stripYamlQuotes(fields.get("color") ?? "") : undefined,
	};
}

function tomlAgentKey(agentName: string): string {
	return /^[A-Za-z0-9_-]+$/.test(agentName) ? agentName : tomlString(agentName);
}

function renderTomlInlineTable(fields: Map<string, string>): string {
	const preferred = ["color", "model", "deny-tools", "tools", "pane", "mode", "sandbox-mode", "model-reasoning-effort"];
	const keys = [...preferred.filter((key) => fields.has(key)), ...[...fields.keys()].filter((key) => !preferred.includes(key)).sort()];
	return `{ ${keys.map((key) => `${key} = ${fields.get(key)}`).join(", ")} }`;
}

function upsertAgentFrontmatterToml(content: string, agentName: string, edit: AgentFrontmatterEdit): string {
	const section = "[agent-frontmatter.pi]";
	const lines = content.split(/\r?\n/);
	let sectionStart = lines.findIndex((line) => line.trim() === section);
	if (sectionStart < 0) {
		const insertAt = lines.findIndex((line) => line.trim().startsWith("# ── Installed skills"));
		const block = ["", "# Pi-specific frontmatter overrides. This is where the", "# Pi /agents popup writes model, deny-tools, tools, and color changes for", "# vstack-managed project agents.", section, ""];
		if (insertAt >= 0) lines.splice(insertAt, 0, ...block);
		else lines.push(...block);
		sectionStart = lines.findIndex((line) => line.trim() === section);
	}
	let sectionEnd = lines.length;
	for (let i = sectionStart + 1; i < lines.length; i += 1) {
		if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
		if (lines[i].trim().startsWith("# ──")) { sectionEnd = i; break; }
	}
	while (sectionEnd > sectionStart + 1 && lines[sectionEnd - 1]?.trim() === "") sectionEnd -= 1;
	const key = tomlAgentKey(agentName);
	const keyRe = new RegExp(`^\\s*(?:${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${tomlString(agentName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*=`);
	const existingIndex = lines.slice(sectionStart + 1, sectionEnd).findIndex((line) => keyRe.test(line));
	const absoluteIndex = existingIndex >= 0 ? sectionStart + 1 + existingIndex : -1;
	const existingValue = absoluteIndex >= 0 ? (lines[absoluteIndex].split(/=(.*)/s)[1] ?? "") : "";
	const fields = parseInlineTomlTable(existingValue.trim());
	if (edit.color.trim()) fields.set("color", tomlString(edit.color.trim())); else fields.delete("color");
	if (edit.model.trim()) fields.set("model", tomlString(edit.model.trim())); else fields.delete("model");
	if (edit.tools.length > 0) fields.set("tools", tomlArray(edit.tools)); else fields.delete("tools");
	if (edit.denyTools.length > 0) fields.set("deny-tools", tomlArray(edit.denyTools)); else fields.delete("deny-tools");
	if (fields.size === 0) {
		if (absoluteIndex >= 0) lines.splice(absoluteIndex, 1);
	} else {
		const nextLine = `${key} = ${renderTomlInlineTable(fields)}`;
		if (absoluteIndex >= 0) lines[absoluteIndex] = nextLine;
		else lines.splice(sectionEnd, 0, nextLine, "");
	}
	return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function refreshVstackManagedAgent(agent: AgentConfig, tomlPath: string): { ok: boolean; message?: string } {
	const projectRoot = path.dirname(tomlPath);
	const result = spawnSync("vstack", ["refresh", "--scope", "project"], {
		cwd: projectRoot,
		encoding: "utf-8",
		timeout: 120_000,
	});
	if (result.error) return { ok: false, message: result.error.message };
	if ((result.status ?? 0) !== 0) {
		const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
		return { ok: false, message: detail.split(/\r?\n/).slice(-4).join(" ") };
	}
	if (!fs.existsSync(agent.filePath)) return { ok: false, message: `${compactAgentPath(agent.filePath)} was not regenerated.` };
	return { ok: true };
}

function yamlScalar(value: string): string {
	if (!value) return "";
	return /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function upsertYamlField(frontmatter: string, key: string, value: string | undefined): string {
	const lines = frontmatter.split(/\r?\n/);
	const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
	const idx = lines.findIndex((line) => keyRe.test(line));
	if (!value) {
		if (idx >= 0) lines.splice(idx, 1);
		return lines.join("\n");
	}
	const line = `${key}: ${value}`;
	if (idx >= 0) lines[idx] = line;
	else lines.push(line);
	return lines.join("\n");
}

function updateAgentFileFrontmatter(raw: string, edit: AgentFrontmatterEdit): string {
	const split = splitMarkdownFrontmatter(raw);
	if (!split.hasFrontmatter) throw new Error("Agent file does not have YAML frontmatter.");
	let fm = split.frontmatter;
	fm = upsertYamlField(fm, "model", edit.model.trim() ? yamlScalar(edit.model.trim()) : undefined);
	fm = upsertYamlField(fm, "tools", edit.tools.length > 0 ? edit.tools.join(", ") : undefined);
	fm = upsertYamlField(fm, "deny-tools", edit.denyTools.length > 0 ? edit.denyTools.join(", ") : undefined);
	fm = upsertYamlField(fm, "color", edit.color.trim() ? yamlScalar(edit.color.trim()) : undefined);
	return `---\n${fm.replace(/\n*$/, "")}\n---\n\n${split.body.replace(/^\n+/, "")}`;
}

function agentSearchText(agent: AgentConfig, status?: AgentPaneStatus): string {
	return [
		agent.name,
		agent.description,
		agent.source,
		agent.filePath,
		agent.model ?? "",
		agent.tools?.join(" ") ?? "",
		agent.denyTools?.join(" ") ?? "",
		agent.pane ? "pane persistent tmux" : "bg background one-shot oneshot",
		status?.live ? "live running" : status?.entry ? "dead stopped" : "",
	].join(" ").toLowerCase();
}

function filterAgentsForBrowser(agents: AgentConfig[], query: string, statuses: Map<string, AgentPaneStatus>): AgentConfig[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return agents;
	return agents.filter((agent) => tokens.every((token) => agentSearchText(agent, statuses.get(agent.name)).includes(token)));
}

function scopeNext(scope: AgentScope, delta: number): AgentScope {
	const scopes: AgentScope[] = ["project", "user", "both"];
	const index = Math.max(0, scopes.indexOf(scope));
	return scopes[(index + delta + scopes.length) % scopes.length]!;
}

function tabNext(current: AgentBrowserTabId, hasActive: boolean, delta: number): AgentBrowserTabId {
	const tabs: AgentBrowserTabId[] = hasActive
		? ["active", "project", "user", "both", "history"]
		: ["project", "user", "both", "history"];
	const index = Math.max(0, tabs.indexOf(current));
	return tabs[(index + delta + tabs.length) % tabs.length]!;
}

async function loadAgentPaneStatuses(runtimeRoot: string): Promise<Map<string, AgentPaneStatus>> {
	const registry = await readPaneRegistry(runtimeRoot);
	const entries = await Promise.all(
		Object.entries(registry).map(async ([agentName, entry]) => [agentName, { entry, live: await paneExists(entry.paneId) }] as const),
	);
	return new Map(entries);
}

function agentFrameContentWidth(width: number): number {
	return Math.max(1, width - 2 - AGENTS_POPUP_PADDING_X * 2);
}

function agentBrowserLayout(terminalRows: number): AgentBrowserLayout {
	// Flex with the terminal height up to ~90% of available rows; no fixed
	// cap on inner / list rows so a tall terminal renders a tall popup and
	// the right detail pane can show more transcript without forcing the
	// user to scroll.
	const innerRows = Math.max(1, Math.floor(Math.max(1, terminalRows) * AGENTS_BROWSER_HEIGHT_RATIO) - AGENTS_POPUP_FRAME_ROWS);
	const bodyRows = Math.max(0, innerRows - 9);
	return {
		bodyRows,
		innerRows,
		listRows: Math.max(1, bodyRows - 3),
	};
}

function agentDivider(width: number, theme: Theme): string {
	return theme.fg("dim", "─".repeat(Math.max(1, width)));
}

function agentFrame(lines: string[], width: number, theme: Theme, fixedInnerRows = 30, title = ""): string[] {
	const safeWidth = Math.max(1, width);
	const inner = Math.max(1, safeWidth - 2);
	const contentWidth = agentFrameContentWidth(safeWidth);
	const border = (s: string) => theme.fg("borderAccent", s);
	let body = lines;
	if (body.length > fixedInnerRows) {
		const hidden = body.length - fixedInnerRows + 1;
		body = [...body.slice(0, Math.max(0, fixedInnerRows - 1)), theme.fg("dim", `↓ ${hidden} more line(s)`)].slice(0, fixedInnerRows);
	} else if (body.length < fixedInnerRows) {
		body = [...body, ...Array.from({ length: fixedInnerRows - body.length }, () => "")];
	}
	const blank = `${border("┃")}${" ".repeat(inner)}${border("┃")}`;
	const top = () => {
		if (!title) return `${border("┏")}${border("━".repeat(inner))}${border("┓")}`;
		const titlePlain = ` ${truncateToWidth(title, Math.max(1, inner - 2), "…")} `;
		const fill = Math.max(1, inner - visibleWidth(titlePlain));
		return `${border("┏")}${ansiGreen(titlePlain)}${border("━".repeat(fill))}${border("┓")}`;
	};
	const out = [top()];
	for (let i = 0; i < AGENTS_POPUP_PADDING_Y; i += 1) out.push(blank);
	for (const line of body) out.push(`${border("┃")}${" ".repeat(AGENTS_POPUP_PADDING_X)}${agentPad(line, contentWidth)}${" ".repeat(AGENTS_POPUP_PADDING_X)}${border("┃")}`);
	for (let i = 0; i < AGENTS_POPUP_PADDING_Y; i += 1) out.push(blank);
	out.push(`${border("┗")}${border("━".repeat(inner))}${border("┛")}`);
	return out.map((line) => truncateToWidth(agentInlineLine(line), safeWidth, ""));
}

function agentActivePill(theme: Theme, label: string): string {
	return theme.fg("accent", theme.inverse(theme.bold(label)));
}

function agentInactivePill(theme: Theme, label: string): string {
	return theme.bg("selectedBg", theme.fg("accent", label));
}

function agentPaneTitle(theme: Theme, label: string, active: boolean): string {
	const padded = ` ${label} `;
	return active ? agentActivePill(theme, padded) : agentInactivePill(theme, padded);
}

function agentEntityTitle(theme: Theme, label: string): string {
	return ansiMagenta(theme.bold(label));
}

function renderAgentScopeTabs(active: AgentScope, width: number, theme: Theme): string {
	const partFor = (tab: { id: AgentScope; label: string }): string => {
		const label = ` ${truncateToWidth(tab.label, 18, "…")} `;
		if (tab.id === active) return agentActivePill(theme, label);
		return agentInactivePill(theme, label);
	};
	return truncateToWidth(AGENT_SCOPE_TABS.map(partFor).join(" "), width, "");
}

function renderAgentBrowserTabs(active: AgentBrowserTabId, hasActive: boolean, width: number, theme: Theme): string {
	const tabs: AgentBrowserTabDef[] = hasActive
		? [ACTIVE_BROWSER_TAB, ...AGENT_SCOPE_TABS, HISTORY_BROWSER_TAB]
		: [...AGENT_SCOPE_TABS, HISTORY_BROWSER_TAB];
	const partFor = (tab: AgentBrowserTabDef): string => {
		const label = ` ${truncateToWidth(tab.label, 18, "…")} `;
		if (tab.id === active) return agentActivePill(theme, label);
		return agentInactivePill(theme, label);
	};
	return truncateToWidth(tabs.map(partFor).join(" "), width, "");
}

function agentStatus(agent: AgentConfig, status: AgentPaneStatus | undefined): "live" | "dead" | "pane" | "one-shot" {
	if (!agent.pane) return "one-shot";
	if (status?.live) return "live";
	if (status?.entry) return "dead";
	return "pane";
}

function agentStatusColor(status: ReturnType<typeof agentStatus>): "success" | "warning" | "muted" | "dim" {
	if (status === "live") return "success";
	if (status === "dead") return "warning";
	if (status === "pane") return "muted";
	return "dim";
}

function agentStatusIcon(status: ReturnType<typeof agentStatus>, theme: Theme): string {
	if (status === "live") return theme.fg("success", ICONS.circleFilled);
	if (status === "dead") return theme.fg("warning", ICONS.times);
	if (status === "pane") return theme.fg("warning", ICONS.circleOpen);
	return theme.fg("dim", "·");
}

function agentStatusLabel(agent: AgentConfig, status: AgentPaneStatus | undefined, theme: Theme): string {
	const state = agentStatus(agent, status);
	if (state === "live") return theme.fg("success", "live");
	if (state === "dead") return theme.fg("warning", "dead");
	if (state === "pane") return theme.fg("muted", "pane-ready/startable");
	return theme.fg("dim", "bg");
}

function agentLegend(theme: Theme): string {
	return `${theme.fg("muted", "Legend")}: ${theme.fg("success", ICONS.circleFilled)} live pane · ${theme.fg("warning", ICONS.circleOpen)} pane-ready/startable · ${theme.fg("warning", ICONS.times)} stale pane · ${theme.fg("dim", "·")} bg`;
}

function renderAgentList(agents: AgentConfig[], statuses: Map<string, AgentPaneStatus>, ui: AgentBrowserUiState, width: number, theme: Theme, listRows: number): string[] {
	const lines = [`${agentPaneTitle(theme, "Agents", ui.pane === "list")} ${theme.fg("dim", `(${agents.length})`)}`, ""];
	if (agents.length === 0) {
		lines.push(theme.fg("dim", "No matching agents."));
		return lines;
	}
	if (ui.scroll > 0) lines.push(theme.fg("dim", `↑ ${ui.scroll} earlier`));
	for (const [visibleIndex, agent] of agents.slice(ui.scroll, ui.scroll + listRows).entries()) {
		const index = ui.scroll + visibleIndex;
		const selected = index === ui.selected;
		const status = agentStatus(agent, statuses.get(agent.name));
		const marker = " ";
		const name = ansiMagenta(selected ? theme.bold(agent.name) : agent.name);
		const meta = theme.fg("dim", ` ${status === "one-shot" ? "bg" : "pane"} · ${agent.source}`);
		const model = agent.model ? theme.fg("dim", ` · ${agent.model}`) : "";
		const row = truncateToWidth(`${marker}${agentStatusIcon(status, theme)} ${name}${meta}${model}`, width, "…");
		lines.push(selected ? theme.bg("selectedBg", agentPad(row, width)) : row);
	}
	const hidden = Math.max(0, agents.length - (ui.scroll + listRows));
	if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
	return lines;
}

function renderAgentPromptViewport(agent: AgentConfig, ui: AgentBrowserUiState, width: number, rows: number, theme: Theme): string[] {
	const prompt = agent.systemPrompt.trim() || theme.fg("dim", "(empty prompt)");
	const promptLines = new Markdown(prompt, 0, 0, getMarkdownTheme()).render(width);
	const visibleRows = Math.max(1, rows - 1);
	const maxScroll = Math.max(0, promptLines.length - visibleRows);
	ui.inspectorScroll = Math.max(0, Math.min(ui.inspectorScroll, maxScroll));
	const visible = promptLines.slice(ui.inspectorScroll, ui.inspectorScroll + visibleRows);
	const before = ui.inspectorScroll > 0 ? `↑ ${ui.inspectorScroll}` : "";
	const afterCount = Math.max(0, promptLines.length - ui.inspectorScroll - visibleRows);
	const after = afterCount > 0 ? `↓ ${afterCount}` : "";
	const scroll = [before, after].filter(Boolean).join(" · ");
	return scroll ? [...visible, theme.fg("dim", scroll)] : visible;
}

function renderAgentInspector(agent: AgentConfig | undefined, statuses: Map<string, AgentPaneStatus>, ui: AgentBrowserUiState, width: number, rows: number, theme: Theme): string[] {
	if (!agent) return [`${agentPaneTitle(theme, "Inspector", ui.pane === "inspector")} ${theme.fg("dim", "Select an agent to inspect it.")}`];
	const status = statuses.get(agent.name);
	const safeWidth = Math.max(8, width);
	const pushWrapped = (target: string[], text: string) => {
		const wrapped = wrapTextWithAnsi(text, safeWidth);
		target.push(...(wrapped.length > 0 ? wrapped : [""]));
	};
	const lines: string[] = [];
	pushWrapped(
		lines,
		`${agentPaneTitle(theme, "Inspector", ui.pane === "inspector")} ${agentEntityTitle(theme, agent.name)} ${theme.fg(agentStatusColor(agentStatus(agent, status)), agentStatus(agent, status))}`,
	);
	lines.push("");
	lines.push(...wrapTextWithAnsi(agent.description || "No description.", safeWidth).slice(0, 3));
	lines.push("");
	pushWrapped(
		lines,
		`${theme.fg("muted", "Kind")}: ${agent.pane ? "persistent pane" : "bg"}    ${theme.fg("muted", "Scope")}: ${agent.source}`,
	);
	pushWrapped(lines, `${theme.fg("muted", "Model")}: ${agent.model ?? "default"}`);
	pushWrapped(lines, `${theme.fg("muted", "Tools")}: ${agent.tools?.join(", ") ?? "default"}`);
	if (agent.denyTools && agent.denyTools.length > 0) pushWrapped(lines, `${theme.fg("muted", "Deny tools")}: ${agent.denyTools.join(", ")}`);
	pushWrapped(lines, `${theme.fg("muted", "Path")}: ${compactAgentPath(agent.filePath)}`);
	pushWrapped(lines, `${theme.fg("muted", "State")}: ${agentStatusLabel(agent, status, theme)}`);
	if (status?.entry) {
		pushWrapped(lines, `${theme.fg("muted", "Pane")}: ${status.entry.windowName}`);
		pushWrapped(lines, `${theme.fg("muted", "Last task")}: ${status.entry.lastTaskAt ?? "never"}`);
	}
	lines.push("", theme.fg("muted", theme.bold("System Prompt")));
	const promptRows = Math.max(1, rows - lines.length);
	lines.push(...renderAgentPromptViewport(agent, ui, safeWidth, promptRows, theme));
	return lines.slice(0, rows);
}

function activeDashboardItems(items: SubagentDashboardItem[]): SubagentDashboardItem[] {
	// Keep the popup's Active tab consistent with the mini dashboard. The tab is
	// really a session activity view now: persistent panes stay resident after
	// completion, and recently completed bg agents remain visible until the
	// dashboard retention window drops them.
	return items
		.sort((a, b) => {
			const aKey = a.startedAt ?? a.taskId;
			const bKey = b.startedAt ?? b.taskId;
			if (aKey === bKey) return 0;
			return aKey < bKey ? -1 : 1;
		});
}

function readTranscriptTail(transcriptPath: string | undefined, maxLines: number): string[] {
	if (!transcriptPath) return [];
	try {
		const raw = fs.readFileSync(transcriptPath, "utf-8");
		const lines = raw.split(/\r?\n/);
		// Pi sessions and our wrapped transcripts are JSONL. Try to render
		// each line as a compact "<role>: <text>" preview when it parses,
		// otherwise pass through raw so we never silently drop content.
		const rendered: string[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: any;
			try { event = JSON.parse(line); } catch { rendered.push(line); continue; }
			const inner = event?.event && typeof event.event === "object" ? event.event : event;
			const msg = inner?.message;
			if (msg && typeof msg === "object") {
				const role = msg.role || inner.type || "?";
				const content = Array.isArray(msg.content) ? msg.content : [];
				const textPart = content.find((c: any) => c?.type === "text");
				const tool = content.find((c: any) => c?.type === "toolCall");
				if (tool) rendered.push(`${role}: [tool] ${tool.name ?? "?"} ${JSON.stringify(tool.arguments ?? {}).slice(0, 80)}`);
				else if (textPart?.text) rendered.push(`${role}: ${oneLinePreview(String(textPart.text), 200)}`);
				else if (typeof msg.content === "string") rendered.push(`${role}: ${oneLinePreview(msg.content, 200)}`);
				else rendered.push(`${role}: (${inner.type ?? "message"})`);
				continue;
			}
			if (typeof inner?.type === "string") {
				rendered.push(inner.type);
				continue;
			}
			rendered.push(line);
		}
		return rendered.slice(-maxLines);
	} catch {
		return [];
	}
}

function renderActiveAgentList(items: SubagentDashboardItem[], ui: AgentBrowserUiState, width: number, theme: Theme, listRows: number): string[] {
	// Logical row 0 is always "Chat". Rows 1..N map to dashboard items, so the
	// shared activeSelected index walks Chat -> agent[0] -> agent[1] etc.
	const totalRows = items.length + 1;
	const lines = [`${agentPaneTitle(theme, "Active", ui.pane === "list")} ${theme.fg("dim", `(${items.length})`)}`, ""];
	if (ui.activeScroll > 0) lines.push(theme.fg("dim", `\u2191 ${ui.activeScroll} earlier`));
	const chatVisible = ui.activeScroll === 0 && listRows > 0;
	if (chatVisible) {
		const selected = ui.activeSelected === 0;
		const icon = theme.fg("accent", "\uf075"); // nf-fa-comment
		const label = theme.fg(selected ? "accent" : "text", theme.bold("Chat"));
		const hint = theme.fg("dim", "all agents");
		const row = `${icon} ${label} ${theme.fg("dim", "\u00b7")} ${hint}`;
		const prefix = selected ? theme.fg("accent", "> ") : "  ";
		lines.push(truncateToWidth(`${prefix}${row}`, width, ""));
	}
	const agentsHeader = ui.activeScroll === 0 && items.length > 0 && listRows > 1;
	if (agentsHeader) lines.push(theme.fg("muted", "Agents"));
	const usedRows = (chatVisible ? 1 : 0) + (agentsHeader ? 1 : 0);
	const remainingRows = Math.max(0, listRows - usedRows);
	// Compute which dashboard items to render given activeScroll. activeSelected = 0 is Chat;
	// indices 1..N reference items[index - 1]. activeScroll is in *logical* units across the same space.
	const itemStart = Math.max(0, ui.activeScroll); // logical row offset
	const startItemIndex = Math.max(0, itemStart - 1); // chat row consumes one logical slot when scrolled into view
	const visible = items.slice(startItemIndex, startItemIndex + remainingRows);
	for (const [index, item] of visible.entries()) {
		const absoluteIndex = startItemIndex + index + 1; // +1 because Chat is logical 0
		const selected = absoluteIndex === ui.activeSelected;
		const icon = dashboardStatusIcon(item.status, theme);
		const name = selected ? ansiMagenta(theme.bold(item.agent)) : ansiMagenta(item.agent);
		const kind = theme.fg("dim", dashboardKindLabel(item.kind));
		const row = `${icon} ${name} ${theme.fg("dim", "\u00b7")} ${kind}`;
		const prefix = selected ? theme.fg("accent", "> ") : "  ";
		lines.push(truncateToWidth(`${prefix}${row}`, width, ""));
	}
	const after = items.length - (startItemIndex + visible.length);
	if (after > 0) lines.push(theme.fg("dim", `\u2193 ${after} more`));
	void totalRows;
	return lines;
}

function renderActiveAgentDetail(item: SubagentDashboardItem | undefined, ui: AgentBrowserUiState, width: number, rows: number, theme: Theme): string[] {
	if (!item) return [`${agentPaneTitle(theme, "Detail", ui.pane === "inspector")} ${theme.fg("dim", "Select an agent to inspect.")}`];
	const safeWidth = Math.max(8, width);
	const wrap = (text: string): string[] => {
		const wrapped = wrapTextWithAnsi(text, safeWidth);
		return wrapped.length > 0 ? wrapped : [""];
	};
	// Build the full detail body first, then apply the inspector scroll
	// across the whole list so vertical movement scrolls the entire viewport - not just
	// the tail block at the bottom (which is often empty when there is no
	// transcript or the file is shorter than the viewport).
	const titleLine = `${agentPaneTitle(theme, "Detail", ui.pane === "inspector")} ${ansiMagenta(theme.bold(item.agent))} ${dashboardStatusText(item, theme)} ${theme.fg("dim", dashboardKindLabel(item.kind))}`;
	const body: string[] = [];
	body.push(...wrap(`${theme.fg("muted", "Task ID")}: ${theme.fg("dim", item.taskId)}`));
	if (item.task) body.push(...wrap(`${theme.fg("muted", "Task")}: ${item.task}`));
	if (item.transcriptPath) body.push(...wrap(`${theme.fg("muted", "Transcript")}: ${theme.fg("dim", compactPath(item.transcriptPath, { maxChars: Number.POSITIVE_INFINITY }))}`));
	if (item.usage) {
		const usageLine = formatUsageStatsForDashboard(item.usage).join(" \u00b7 ");
		if (usageLine) body.push(...wrap(`${theme.fg("muted", "Usage")}: ${theme.fg("dim", usageLine)}`));
	}
	if (item.message) {
		body.push("");
		body.push(...wrap(theme.fg("muted", theme.bold("Latest Message"))));
		const wrapped = wrapTextWithAnsi(item.message, safeWidth);
		body.push(...wrapped.slice(0, 8));
	}
	body.push("");
	body.push(...wrap(theme.fg("muted", theme.bold("Transcript Tail"))));
	const tail = readTranscriptTail(item.transcriptPath, 400);
	if (tail.length === 0) {
		body.push(...wrap(theme.fg("dim", "(transcript empty or unavailable)")));
	} else {
		for (const line of tail) body.push(...wrap(theme.fg("toolOutput", line)));
	}
	// Title is sticky on the first row; body scrolls beneath it.
	const allLines: string[] = [titleLine, ""];
	const visibleBodyRows = Math.max(1, rows - 2);
	const maxOffset = Math.max(0, body.length - visibleBodyRows);
	const offset = Math.max(0, Math.min(ui.inspectorScroll, maxOffset));
	// Write the clamped value back so the next key press starts moving
	// immediately instead of having to bleed off a runaway counter.
	ui.inspectorScroll = offset;
	const slice = body.slice(offset, offset + visibleBodyRows);
	allLines.push(...slice);
	if (offset > 0 || maxOffset > 0) {
		const hint = `${offset > 0 ? `\u2191 ${offset} earlier` : ""}${offset > 0 && offset < maxOffset ? "  " : ""}${offset < maxOffset ? `\u2193 ${maxOffset - offset} more` : ""}`.trim();
		if (hint && allLines.length < rows) {
			const lastIndex = allLines.length - 1;
			allLines[lastIndex] = `${allLines[lastIndex]} ${theme.fg("dim", hint)}`;
		}
	}
	return allLines.slice(0, rows);
}

function formatRelativeTime(iso: string | undefined): string {
	if (!iso) return "—";
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return "—";
	const delta = Date.now() - ts;
	if (delta < 0) return "just now";
	const sec = Math.floor(delta / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return new Date(ts).toISOString().slice(0, 10);
}

function historyStatusIcon(status: PaneTaskStatus, theme: Theme): string {
	if (status === "completed") return theme.fg("success", ICONS.check);
	if (status === "failed") return theme.fg("error", ICONS.times);
	if (status === "blocked") return theme.fg("warning", ICONS.times);
	if (status === "running") return theme.fg("warning", ICONS.cog);
	if (status === "queued") return theme.fg("warning", ICONS.clock);
	return theme.fg("muted", "·");
}

function historyStatusText(status: PaneTaskStatus, theme: Theme): string {
	return theme.fg(paneCompletionTone(status), status);
}

function sortedHistoryRecords(registry: PaneTaskRegistry): PaneTaskRecord[] {
	return Object.values(registry)
		.filter((record) => record.taskId && record.agent)
		.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
}

function renderHistoryList(records: PaneTaskRecord[], ui: AgentBrowserUiState, width: number, theme: Theme, listRows: number): string[] {
	const lines = [`${agentPaneTitle(theme, "Tasks", ui.pane === "list")} ${theme.fg("dim", `(${records.length})`)}`, ""];
	if (records.length === 0) {
		lines.push(theme.fg("dim", "No agent task history yet."));
		return lines;
	}
	if (ui.historyScroll > 0) lines.push(theme.fg("dim", `↑ ${ui.historyScroll} earlier`));
	for (const [visibleIndex, record] of records.slice(ui.historyScroll, ui.historyScroll + listRows).entries()) {
		const index = ui.historyScroll + visibleIndex;
		const selected = index === ui.historySelected;
		const icon = historyStatusIcon(record.status, theme);
		const name = ansiMagenta(selected ? theme.bold(record.agent) : record.agent);
		const when = theme.fg("dim", formatRelativeTime(record.completedAt ?? record.createdAt));
		const summary = oneLinePreview(record.summary || record.task || "", 60);
		const detail = summary ? theme.fg("dim", `  ${summary}`) : "";
		const row = truncateToWidth(`${icon} ${name} ${theme.fg("dim", "·")} ${when}${detail}`, width, "…");
		lines.push(selected ? theme.bg("selectedBg", agentPad(row, width)) : row);
	}
	const hidden = Math.max(0, records.length - (ui.historyScroll + listRows));
	if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
	return lines;
}

function renderHistoryDetail(
	record: PaneTaskRecord | undefined,
	cache: Map<string, HistoryDetailEntry>,
	ui: AgentBrowserUiState,
	width: number,
	rows: number,
	theme: Theme,
): string[] {
	if (!record) {
		return [`${agentPaneTitle(theme, "Detail", ui.pane === "inspector")} ${theme.fg("dim", "Select a task to view its trace.")}`];
	}
	const safeWidth = Math.max(8, width);
	const entry = cache.get(record.taskId);
	const items = entry?.items;
	const placeholderText = entry?.error ? `Error: ${entry.error}` : entry?.loading || !items ? "Loading…" : "(empty)";
	const subtabs: TraceViewerItem[] = items ?? HISTORY_SUBTAB_LABELS.map((label) => ({ label, text: placeholderText, type: label.toLowerCase() as TraceViewerItem["type"] }));
	const subtabIndex = Math.max(0, Math.min(ui.historySubtab, subtabs.length - 1));
	ui.historySubtab = subtabIndex;
	const when = formatRelativeTime(record.completedAt ?? record.createdAt);
	const titleLine = `${agentPaneTitle(theme, "Detail", ui.pane === "inspector")} ${ansiMagenta(theme.bold(record.agent))} ${historyStatusText(record.status, theme)} ${theme.fg("dim", `· ${when}`)}`;
	const subtabLine = renderTraceTabBar(subtabs, subtabIndex, safeWidth, theme);
	const item = subtabs[subtabIndex];
	const fileLine = item?.path
		? theme.fg("dim", `file ${compactPath(item.path, { maxChars: Math.max(24, safeWidth - 6) })}`)
		: theme.fg("dim", item?.type === "summary" ? "metadata view" : "");
	const rawLines = (item?.text || "(empty)").split(/\r?\n/);
	const wrapped: string[] = [];
	for (const raw of rawLines) {
		const chunk = wrapTextWithAnsi(raw, safeWidth);
		wrapped.push(...(chunk.length > 0 ? chunk : [""]));
	}
	const headerRows = fileLine ? 4 : 3;
	const footerRows = 1;
	const visibleRows = Math.max(1, rows - headerRows - footerRows);
	const maxScroll = Math.max(0, wrapped.length - visibleRows);
	ui.inspectorScroll = Math.max(0, Math.min(ui.inspectorScroll, maxScroll));
	const slice = wrapped.slice(ui.inspectorScroll, ui.inspectorScroll + visibleRows);
	const before = ui.inspectorScroll > 0 ? `↑ ${ui.inspectorScroll}` : "";
	const afterCount = Math.max(0, wrapped.length - ui.inspectorScroll - visibleRows);
	const after = afterCount > 0 ? `↓ ${afterCount}` : "";
	const scrollHint = [before, after].filter(Boolean).join(" · ");
	const out: string[] = [titleLine, "", subtabLine];
	if (fileLine) out.push(fileLine);
	out.push(...slice);
	if (scrollHint) out.push(theme.fg("dim", scrollHint));
	else out.push("");
	return out.slice(0, rows);
}

interface ChatMessage {
	timestamp: number;
	agent: string;
	taskId?: string;
	kind: "delegation" | "completion" | "steering";
	from: string;
	to: string;
	body: string;
	status?: string;
	filesChanged?: string[];
	notes?: string;
}

function deriveTaskIdFromFile(file: string): string | undefined {
	const base = path.basename(file, path.extname(file));
	const stripped = base.replace(/^\d{10,}-/, "");
	return stripped || base || undefined;
}

function trimChatBody(text: string, max = 4_000): string {
	const compact = text.trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max)}\n\u2026(truncated)`;
}

function extractDelegationBody(raw: string): string {
	// buildDelegation wraps the actual task in Task-for / Task-ID / schema /
	// "Do not complete before..." boilerplate. Strip that so the chat shows
	// just the user-meaningful instructions.
	const lines = raw.split(/\r?\n/);
	const out: string[] = [];
	let started = false;
	for (const line of lines) {
		if (!started) {
			if (/^Task for /.test(line) || /^Task ID:/.test(line)) continue;
			if (line.trim() === "") continue;
			started = true;
		}
		if (/^When done, /.test(line)) break;
		if (/^If complete_subagent is unavailable/.test(line)) break;
		if (/^Do not complete before the work is actually done/.test(line)) break;
		out.push(line);
	}
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	return out.join("\n").trim();
}

function extractSteeringBody(raw: string): string {
	const lines = raw.split(/\r?\n/);
	const out: string[] = [];
	let started = false;
	for (const line of lines) {
		if (!started) {
			if (/^Steering update for /.test(line)) continue;
			if (line.trim() === "") continue;
			started = true;
		}
		out.push(line);
	}
	return out.join("\n").trim();
}

function loadChatMessages(runtimeRoot: string, agentNames: string[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const seen = new Set<string>();
	const pushMd = (filePath: string, agent: string): void => {
		const key = `md:${filePath}`;
		if (seen.has(key)) return;
		seen.add(key);
		let stat: fs.Stats;
		try { stat = fs.statSync(filePath); } catch { return; }
		let raw: string;
		try { raw = fs.readFileSync(filePath, "utf-8"); } catch { return; }
		const isSteer = /^Steering update for /m.test(raw) || /^STEER:/im.test(raw);
		const body = trimChatBody(isSteer ? extractSteeringBody(raw) : extractDelegationBody(raw));
		if (!body) return;
		messages.push({
			timestamp: stat.mtimeMs,
			agent,
			taskId: deriveTaskIdFromFile(filePath),
			kind: isSteer ? "steering" : "delegation",
			from: "@orch",
			to: `@${agent}`,
			body,
		});
	};
	const pushJson = (filePath: string, agent: string): void => {
		const key = `json:${filePath}`;
		if (seen.has(key)) return;
		seen.add(key);
		let stat: fs.Stats;
		try { stat = fs.statSync(filePath); } catch { return; }
		let parsed: Record<string, unknown> | undefined;
		try { parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>; } catch { return; }
		const summary = typeof parsed?.summary === "string" ? parsed.summary : "(no summary)";
		const status = typeof parsed?.status === "string" ? parsed.status : undefined;
		const notes = typeof parsed?.notes === "string" ? parsed.notes : undefined;
		const filesChanged = Array.isArray(parsed?.filesChanged)
			? (parsed.filesChanged as unknown[]).filter((entry): entry is string => typeof entry === "string")
			: undefined;
		messages.push({
			timestamp: stat.mtimeMs,
			agent,
			taskId: deriveTaskIdFromFile(filePath),
			kind: "completion",
			from: `@${agent}`,
			to: "@orch",
			body: summary,
			status,
			filesChanged,
			notes,
		});
	};
	const mdDirs = ["inbox", "processing", "done"];
	const jsonDirs = ["outbox", "processed"];
	for (const agent of agentNames) {
		for (const rel of mdDirs) {
			const dir = path.join(runtimeRoot, rel, safeFileName(agent));
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { continue; }
			for (const name of entries) if (name.endsWith(".md")) pushMd(path.join(dir, name), agent);
		}
		for (const rel of jsonDirs) {
			const dir = path.join(runtimeRoot, rel, safeFileName(agent));
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { continue; }
			for (const name of entries) if (name.endsWith(".json")) pushJson(path.join(dir, name), agent);
		}
	}
	messages.sort((a, b) => a.timestamp - b.timestamp);
	return messages;
}

function chatTimestamp(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function chatRoleColor(name: string, theme: Theme): string {
	// Orchestrator stays on accent (theme primary). Agents render in ANSI 5
	// (magenta) so the chat splits visually into 'you' (accent) vs 'agents'
	// (theme.ansiMagenta -> hypr-generated picks up its accentSecondary).
	if (name === "@orch") return theme.fg("accent", theme.bold(name));
	return ansiMagenta(theme.bold(name));
}

function chatKindBadge(kind: ChatMessage["kind"], theme: Theme): string {
	if (kind === "completion") return theme.fg("success", "completion");
	if (kind === "steering") return theme.fg("warning", "steer");
	return theme.fg("muted", "delegation");
}

function chatStatusIcon(status: string | undefined, theme: Theme): string | undefined {
	if (!status) return undefined;
	if (status === "completed") return theme.fg("success", ICONS.check);
	if (status === "failed") return theme.fg("error", ICONS.times);
	if (status === "blocked") return theme.fg("error", ICONS.times);
	return theme.fg("warning", ICONS.warning);
}

function wrapWithHangingIndent(text: string, indent: string, width: number): string[] {
	const innerWidth = Math.max(1, width - visibleWidth(indent));
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const wrapped = wrapTextWithAnsi(line, innerWidth);
		if (wrapped.length === 0) {
			out.push(indent);
			continue;
		}
		for (const sub of wrapped) out.push(`${indent}${sub}`);
	}
	return out;
}

function renderChatRoomDetail(runtimeRoot: string, agentNames: string[], ui: AgentBrowserUiState, width: number, rows: number, theme: Theme): string[] {
	const safeWidth = Math.max(8, width);
	const titleLine = `${agentPaneTitle(theme, "Chat", ui.pane === "inspector")} ${theme.fg("dim", `(${agentNames.length} agent${agentNames.length === 1 ? "" : "s"})`)}`;
	const messages = loadChatMessages(runtimeRoot, agentNames);
	const body: string[] = [];
	if (messages.length === 0) {
		body.push(...wrapTextWithAnsi(theme.fg("dim", "No messages yet. Delegations and completions will appear here as agents work."), safeWidth));
	} else {
		for (let i = 0; i < messages.length; i += 1) {
			const msg = messages[i];
			const time = theme.fg("dim", chatTimestamp(msg.timestamp));
			const arrow = theme.fg("dim", "\u2192");
			const fromLabel = chatRoleColor(msg.from, theme);
			const toLabel = chatRoleColor(msg.to, theme);
			const sep = theme.fg("dim", "\u00b7");
			const kindBadge = chatKindBadge(msg.kind, theme);
			const statusIcon = chatStatusIcon(msg.status, theme);
			const headerParts = [time, fromLabel, arrow, toLabel, sep, kindBadge];
			if (statusIcon) headerParts.push(sep, statusIcon);
			body.push(...wrapTextWithAnsi(headerParts.join(" "), safeWidth));
			const indent = theme.fg("dim", "\u2502 ");
			const bodyText = msg.body || theme.fg("dim", "(empty)");
			body.push(...wrapWithHangingIndent(theme.fg("toolOutput", bodyText), indent, safeWidth));
			if (msg.filesChanged && msg.filesChanged.length > 0) {
				body.push(...wrapWithHangingIndent(theme.fg("muted", `files: ${msg.filesChanged.join(", ")}`), indent, safeWidth));
			}
			if (msg.notes) {
				body.push(...wrapWithHangingIndent(theme.fg("muted", `notes: ${msg.notes}`), indent, safeWidth));
			}
			// Spacer between messages (skip after last).
			if (i < messages.length - 1) body.push("");
		}
	}
	const allLines: string[] = [titleLine, ""];
	const visibleBodyRows = Math.max(1, rows - 2);
	const maxOffset = Math.max(0, body.length - visibleBodyRows);
	const offset = Math.max(0, Math.min(ui.inspectorScroll, maxOffset));
	ui.inspectorScroll = offset;
	allLines.push(...body.slice(offset, offset + visibleBodyRows));
	if (offset > 0 || maxOffset > 0) {
		const hint = `${offset > 0 ? `\u2191 ${offset} earlier` : ""}${offset > 0 && offset < maxOffset ? "  " : ""}${offset < maxOffset ? `\u2193 ${maxOffset - offset} more` : ""}`.trim();
		if (hint && allLines.length < rows) {
			const lastIndex = allLines.length - 1;
			allLines[lastIndex] = `${allLines[lastIndex]} ${theme.fg("dim", hint)}`;
		}
	}
	return allLines.slice(0, rows);
}

function renderActiveTabBody(items: SubagentDashboardItem[], runtimeRoot: string, ui: AgentBrowserUiState, width: number, theme: Theme, layout: AgentBrowserLayout): string[] {
	const maxLeftWidth = Math.max(10, width - 13);
	const desiredLeftWidth = Math.min(AGENTS_LEFT_MAX_WIDTH, Math.floor(width * 0.32), maxLeftWidth);
	const leftWidth = Math.max(10, Math.min(maxLeftWidth, Math.max(Math.min(AGENTS_LEFT_MIN_WIDTH, maxLeftWidth), desiredLeftWidth)));
	const rightWidth = Math.max(1, width - leftWidth - 3);
	const bodyRows = layout.bodyRows;
	const left = renderActiveAgentList(items, ui, leftWidth, theme, layout.listRows);
	// activeSelected = 0 -> Chat, 1..N -> items[index-1]
	const chatSelected = ui.activeSelected === 0;
	const agentNames = items.map((i) => i.agent);
	const right = chatSelected
		? renderChatRoomDetail(runtimeRoot, agentNames, ui, rightWidth, bodyRows, theme)
		: renderActiveAgentDetail(items[ui.activeSelected - 1], ui, rightWidth, bodyRows, theme);
	const lines: string[] = [];
	const headerLine = `${theme.fg("muted", "View")}: ${theme.fg("text", "active")}  ${theme.fg("muted", "Items")}: ${items.length}`;
	lines.push(...wrapTextWithAnsi(headerLine, width));
	lines.push(agentDivider(width, theme));
	for (let i = 0; i < bodyRows; i += 1) {
		lines.push(`${agentPad(left[i] ?? "", leftWidth)} ${theme.fg("dim", "\u2502")} ${truncateToWidth(right[i] ?? "", rightWidth, "")}`);
	}
	const legend = `${theme.fg("muted", "Active")}: ${theme.fg("warning", "running/waiting")} \u00b7 ${theme.fg("success", "completed")} \u00b7 ${theme.fg("error", "failed")}`;
	lines.push("");
	lines.push(...wrapTextWithAnsi(legend, width));
	return lines;
}

function renderHistoryTabBody(
	records: PaneTaskRecord[],
	cache: Map<string, HistoryDetailEntry>,
	ui: AgentBrowserUiState,
	width: number,
	theme: Theme,
	layout: AgentBrowserLayout,
): string[] {
	const maxLeftWidth = Math.max(10, width - 13);
	const desiredLeftWidth = Math.min(AGENTS_LEFT_MAX_WIDTH, Math.floor(width * 0.36), maxLeftWidth);
	const leftWidth = Math.max(10, Math.min(maxLeftWidth, Math.max(Math.min(AGENTS_LEFT_MIN_WIDTH, maxLeftWidth), desiredLeftWidth)));
	const rightWidth = Math.max(1, width - leftWidth - 3);
	const bodyRows = layout.bodyRows;
	const left = renderHistoryList(records, ui, leftWidth, theme, layout.listRows);
	const record = records[ui.historySelected];
	const right = renderHistoryDetail(record, cache, ui, rightWidth, bodyRows, theme);
	const headerLine = `${theme.fg("muted", "View")}: ${theme.fg("text", "history")}  ${theme.fg("muted", "Tasks")}: ${records.length}`;
	const lines: string[] = [...wrapTextWithAnsi(headerLine, width), agentDivider(width, theme)];
	for (let i = 0; i < bodyRows; i += 1) {
		lines.push(`${agentPad(left[i] ?? "", leftWidth)} ${theme.fg("dim", "│")} ${truncateToWidth(right[i] ?? "", rightWidth, "")}`);
	}
	const legend = `${theme.fg("muted", "Status")}: ${theme.fg("success", "completed")} · ${theme.fg("warning", "running/queued/blocked")} · ${theme.fg("error", "failed")}`;
	lines.push("");
	lines.push(...wrapTextWithAnsi(legend, width));
	return lines;
}

function renderAgentsBody(
	discovery: ReturnType<typeof discoverAgents>,
	agents: AgentConfig[],
	statuses: Map<string, AgentPaneStatus>,
	ui: AgentBrowserUiState,
	width: number,
	theme: Theme,
	layout: AgentBrowserLayout,
): string[] {
	const selected = agents[ui.selected];
	const maxLeftWidth = Math.max(10, width - 13);
	const desiredLeftWidth = Math.min(AGENTS_LEFT_MAX_WIDTH, Math.floor(width * 0.38), maxLeftWidth);
	const leftWidth = Math.max(10, Math.min(maxLeftWidth, Math.max(Math.min(AGENTS_LEFT_MIN_WIDTH, maxLeftWidth), desiredLeftWidth)));
	const rightWidth = Math.max(1, width - leftWidth - 3);
	const bodyRows = layout.bodyRows;
	const liveCount = [...statuses.values()].filter((status) => status.live).length;
	const paneCount = discovery.agents.filter((agent) => agent.pane).length;
	const left = renderAgentList(agents, statuses, ui, leftWidth, theme, layout.listRows);
	const right = renderAgentInspector(selected, statuses, ui, rightWidth, bodyRows, theme);
	const rows = bodyRows;
	const searchLine = theme.bg("toolPendingBg", agentPad(` > ${ui.search}${theme.inverse(" ")}`, width));
	const filterLine = `${theme.fg("muted", "View")}: ${theme.fg("text", "agents")}  ${theme.fg("muted", "Filters")}: scope ${ui.scope} · ${agents.length}/${discovery.agents.length} shown · ${paneCount} pane · ${liveCount} live`;
	const filterLines = wrapTextWithAnsi(filterLine, width);
	const lines = [searchLine, ...filterLines, agentDivider(width, theme)];
	for (let i = 0; i < rows; i += 1) {
		lines.push(`${agentPad(left[i] ?? "", leftWidth)} ${theme.fg("dim", "│")} ${truncateToWidth(right[i] ?? "", rightWidth, "")}`);
	}
	lines.push("");
	lines.push(...wrapTextWithAnsi(agentLegend(theme), width));
	return lines;
}

function createAgentsBrowserComponent(
	discovery: ReturnType<typeof discoverAgents>,
	statuses: Map<string, AgentPaneStatus>,
	taskRegistry: PaneTaskRegistry,
	ui: AgentBrowserUiState,
	theme: Theme,
	requestRender: () => void,
	getLayout: () => AgentBrowserLayout,
	done: (action: AgentBrowserAction) => void,
	getActiveItems: () => SubagentDashboardItem[],
	runtimeRoot: string,
) {
	const filtered = () => filterAgentsForBrowser(discovery.agents, ui.search, statuses);
	const selectedAgent = () => filtered()[ui.selected];
	const clamp = () => {
		const layout = getLayout();
		const list = filtered();
		ui.selected = Math.max(0, Math.min(ui.selected, Math.max(0, list.length - 1)));
		if (ui.selected < ui.scroll) ui.scroll = ui.selected;
		if (ui.selected >= ui.scroll + layout.listRows) ui.scroll = ui.selected - layout.listRows + 1;
		ui.scroll = Math.max(0, Math.min(ui.scroll, Math.max(0, list.length - layout.listRows)));
	};
	const historyRecords = sortedHistoryRecords(taskRegistry);
	const historyCache = new Map<string, HistoryDetailEntry>();
	const loadHistoryRecord = (record: PaneTaskRecord | undefined) => {
		if (!record) return;
		const entry = historyCache.get(record.taskId);
		if (entry?.items || entry?.loading) return;
		historyCache.set(record.taskId, { loading: true });
		void traceViewerItems(record).then((items) => {
			historyCache.set(record.taskId, { items });
			requestRender();
		}).catch((error) => {
			historyCache.set(record.taskId, { error: error instanceof Error ? error.message : String(error) });
			requestRender();
		});
	};
	const clampHistory = () => {
		const layout = getLayout();
		const total = historyRecords.length;
		ui.historySelected = Math.max(0, Math.min(ui.historySelected, Math.max(0, total - 1)));
		if (ui.historySelected < ui.historyScroll) ui.historyScroll = ui.historySelected;
		if (ui.historySelected >= ui.historyScroll + layout.listRows) ui.historyScroll = ui.historySelected - layout.listRows + 1;
		ui.historyScroll = Math.max(0, Math.min(ui.historyScroll, Math.max(0, total - layout.listRows)));
	};

	const hasActiveTab = () => getActiveItems().length > 0;
	const switchTab = (delta: number) => {
		const next = tabNext(ui.tab, hasActiveTab(), delta);
		if (next === "active") {
			ui.tab = "active";
			ui.activeSelected = 0;
			ui.activeScroll = 0;
			ui.inspectorScroll = 0;
			ui.pane = "list";
			requestRender();
			return;
		}
		if (next === "history") {
			ui.tab = "history";
			ui.historySelected = 0;
			ui.historyScroll = 0;
			ui.historySubtab = 0;
			ui.inspectorScroll = 0;
			ui.pane = "list";
			loadHistoryRecord(historyRecords[0]);
			requestRender();
			return;
		}
		ui.tab = next;
		ui.scope = next;
		ui.selected = 0;
		ui.scroll = 0;
		ui.inspectorScroll = 0;
		done({ type: "reload" });
	};
	const insertSelected = () => {
		const agent = selectedAgent();
		if (agent) done({ type: "insert", agentName: agent.name });
	};
	const startSelected = () => {
		const agent = selectedAgent();
		if (agent) done({ type: "start", agentName: agent.name });
	};
	const attachSelected = () => {
		const agent = selectedAgent();
		if (agent) done({ type: "attach", agentName: agent.name });
	};
	const stopSelected = () => {
		const agent = selectedAgent();
		if (agent) done({ type: "stop", agentName: agent.name });
	};
	const editFrontmatterSelected = () => {
		const agent = selectedAgent();
		if (agent) done({ type: "editFrontmatter", agentName: agent.name });
	};
	function handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (ui.tab !== "active" && ui.search) { ui.search = ""; ui.selected = 0; ui.scroll = 0; requestRender(); return; }
			done({ type: "close" });
			return;
		}
		if (matchesKey(data, "tab")) return switchTab(1);
		if (matchesKey(data, "shift+tab")) return switchTab(-1);
		if (matchesKey(data, "left")) {
			if (ui.tab === "history" && ui.pane === "inspector") {
				if (ui.historySubtab === 0) {
					ui.pane = "list";
				} else {
					ui.historySubtab -= 1;
					ui.inspectorScroll = 0;
				}
				requestRender();
				return;
			}
			ui.pane = "list";
			requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			if (ui.tab === "history" && ui.pane === "inspector") {
				const total = HISTORY_SUBTAB_LABELS.length;
				if (ui.historySubtab < total - 1) {
					ui.historySubtab += 1;
					ui.inspectorScroll = 0;
					requestRender();
				}
				return;
			}
			ui.pane = "inspector";
			requestRender();
			return;
		}
		// '-' and '=' are page-step alternates that work in every tab. Put
		// them above the active branch and above the search-input fall-through
		// so the popup search field never captures them.
		if (matchesKey(data, "-") || matchesKey(data, "=")) {
			const layout = getLayout();
			const page = Math.max(1, layout.bodyRows);
			const delta = matchesKey(data, "-") ? -page : page;
			if (ui.tab === "active") {
				const items = getActiveItems();
				const totalRows = items.length + 1;
				if (ui.pane === "inspector") {
					ui.inspectorScroll = Math.max(0, ui.inspectorScroll + delta);
				} else {
					ui.activeSelected = Math.max(0, Math.min(totalRows - 1, ui.activeSelected + delta));
					if (ui.activeSelected < ui.activeScroll) ui.activeScroll = ui.activeSelected;
					if (ui.activeSelected >= ui.activeScroll + layout.listRows) ui.activeScroll = ui.activeSelected - layout.listRows + 1;
					ui.activeScroll = Math.max(0, Math.min(ui.activeScroll, Math.max(0, totalRows - layout.listRows)));
					ui.inspectorScroll = 0;
				}
			} else if (ui.tab === "history") {
				if (ui.pane === "inspector") {
					ui.inspectorScroll = Math.max(0, ui.inspectorScroll + delta);
				} else {
					ui.historySelected = Math.max(0, ui.historySelected + delta);
					ui.historySubtab = 0;
					ui.inspectorScroll = 0;
					clampHistory();
					loadHistoryRecord(historyRecords[ui.historySelected]);
				}
			} else if (ui.pane === "inspector") {
				ui.inspectorScroll = Math.max(0, ui.inspectorScroll + delta);
			} else {
				ui.selected = Math.max(0, ui.selected + delta);
				ui.inspectorScroll = 0;
				clamp();
			}
			requestRender();
			return;
		}
		if (ui.tab === "active") {
			const items = getActiveItems();
			const layout = getLayout();
			const totalRows = items.length + 1; // Chat row + agents
			const clampActive = () => {
				ui.activeSelected = Math.max(0, Math.min(ui.activeSelected, Math.max(0, totalRows - 1)));
				if (ui.activeSelected < ui.activeScroll) ui.activeScroll = ui.activeSelected;
				if (ui.activeSelected >= ui.activeScroll + layout.listRows) ui.activeScroll = ui.activeSelected - layout.listRows + 1;
				ui.activeScroll = Math.max(0, Math.min(ui.activeScroll, Math.max(0, totalRows - layout.listRows)));
			};
			if (matchesKey(data, "up")) {
				if (ui.pane === "inspector") ui.inspectorScroll = Math.max(0, ui.inspectorScroll - 1);
				else { ui.activeSelected -= 1; ui.inspectorScroll = 0; clampActive(); }
				requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				if (ui.pane === "inspector") ui.inspectorScroll += 1;
				else { ui.activeSelected += 1; ui.inspectorScroll = 0; clampActive(); }
				requestRender();
				return;
			}
			if (matchesKey(data, "pageup" as any)) {
				if (ui.pane === "inspector") ui.inspectorScroll = Math.max(0, ui.inspectorScroll - Math.max(1, layout.bodyRows));
				else { ui.activeSelected -= layout.listRows; ui.inspectorScroll = 0; clampActive(); }
				requestRender();
				return;
			}
			if (matchesKey(data, "pagedown" as any)) {
				if (ui.pane === "inspector") ui.inspectorScroll += Math.max(1, layout.bodyRows);
				else { ui.activeSelected += layout.listRows; ui.inspectorScroll = 0; clampActive(); }
				requestRender();
				return;
			}
			if (matchesKey(data, "home")) { if (ui.pane === "inspector") ui.inspectorScroll = 0; else { ui.activeSelected = 0; ui.activeScroll = 0; } requestRender(); return; }
			if (matchesKey(data, "end")) { if (ui.pane === "inspector") ui.inspectorScroll = Number.MAX_SAFE_INTEGER; else { ui.activeSelected = Math.max(0, totalRows - 1); clampActive(); } requestRender(); return; }
			return;
		}
		if (ui.tab === "history") {
			const layout = getLayout();
			if (matchesKey(data, "up")) {
				if (ui.pane === "inspector") ui.inspectorScroll = Math.max(0, ui.inspectorScroll - 1);
				else { ui.historySelected = Math.max(0, ui.historySelected - 1); ui.historySubtab = 0; ui.inspectorScroll = 0; clampHistory(); loadHistoryRecord(historyRecords[ui.historySelected]); }
				requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				if (ui.pane === "inspector") ui.inspectorScroll += 1;
				else { ui.historySelected += 1; ui.historySubtab = 0; ui.inspectorScroll = 0; clampHistory(); loadHistoryRecord(historyRecords[ui.historySelected]); }
				requestRender();
				return;
			}
			if (matchesKey(data, "pageup" as any)) {
				if (ui.pane === "inspector") ui.inspectorScroll = Math.max(0, ui.inspectorScroll - Math.max(1, layout.bodyRows));
				else { ui.historySelected = Math.max(0, ui.historySelected - layout.listRows); ui.historySubtab = 0; ui.inspectorScroll = 0; clampHistory(); loadHistoryRecord(historyRecords[ui.historySelected]); }
				requestRender();
				return;
			}
			if (matchesKey(data, "pagedown" as any)) {
				if (ui.pane === "inspector") ui.inspectorScroll += Math.max(1, layout.bodyRows);
				else { ui.historySelected += layout.listRows; ui.historySubtab = 0; ui.inspectorScroll = 0; clampHistory(); loadHistoryRecord(historyRecords[ui.historySelected]); }
				requestRender();
				return;
			}
			if (matchesKey(data, "home")) { if (ui.pane === "inspector") ui.inspectorScroll = 0; else { ui.historySelected = 0; ui.historyScroll = 0; ui.historySubtab = 0; loadHistoryRecord(historyRecords[0]); } requestRender(); return; }
			if (matchesKey(data, "end")) { if (ui.pane === "inspector") ui.inspectorScroll = Number.MAX_SAFE_INTEGER; else { ui.historySelected = Math.max(0, historyRecords.length - 1); ui.historySubtab = 0; clampHistory(); loadHistoryRecord(historyRecords[ui.historySelected]); } requestRender(); return; }
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				if (ui.pane === "list") { ui.pane = "inspector"; loadHistoryRecord(historyRecords[ui.historySelected]); requestRender(); return; }
				return;
			}
			return;
		}
		if (matchesKey(data, "up")) {
			if (ui.pane === "inspector") ui.inspectorScroll -= 1;
			else { ui.selected -= 1; ui.inspectorScroll = 0; clamp(); }
			requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			if (ui.pane === "inspector") ui.inspectorScroll += 1;
			else { ui.selected += 1; ui.inspectorScroll = 0; clamp(); }
			requestRender();
			return;
		}
		if (matchesKey(data, "pageup" as any)) {
			const layout = getLayout();
			if (ui.pane === "inspector") ui.inspectorScroll -= Math.max(1, layout.bodyRows);
			else { ui.selected -= layout.listRows; ui.inspectorScroll = 0; clamp(); }
			requestRender();
			return;
		}
		if (matchesKey(data, "pagedown" as any)) {
			const layout = getLayout();
			if (ui.pane === "inspector") ui.inspectorScroll += Math.max(1, layout.bodyRows);
			else { ui.selected += layout.listRows; ui.inspectorScroll = 0; clamp(); }
			requestRender();
			return;
		}
		if (matchesKey(data, "home")) { if (ui.pane === "inspector") ui.inspectorScroll = 0; else { ui.selected = 0; ui.scroll = 0; } requestRender(); return; }
		if (matchesKey(data, "end")) { if (ui.pane === "inspector") ui.inspectorScroll = Number.MAX_SAFE_INTEGER; else { ui.selected = Math.max(0, filtered().length - 1); clamp(); } requestRender(); return; }
		if (matchesKey(data, "enter") || matchesKey(data, "return")) return insertSelected();
		if (matchesKey(data, "alt+m") || matchesKey(data, "ctrl+m")) return editFrontmatterSelected();
		if (matchesKey(data, "alt+p") || matchesKey(data, "ctrl+p")) return startSelected();
		if (matchesKey(data, "alt+o") || matchesKey(data, "ctrl+o")) return attachSelected();
		if (matchesKey(data, "alt+x") || matchesKey(data, "ctrl+x")) return stopSelected();
		if (matchesKey(data, "backspace")) { ui.search = ui.search.slice(0, -1); ui.selected = 0; ui.scroll = 0; ui.inspectorScroll = 0; clamp(); requestRender(); return; }
		if (matchesKey(data, "ctrl+u")) { ui.search = ""; ui.selected = 0; ui.scroll = 0; ui.inspectorScroll = 0; requestRender(); return; }
		if (isAgentBrowserTextInput(data)) { ui.search += data; ui.pane = "list"; ui.selected = 0; ui.scroll = 0; ui.inspectorScroll = 0; clamp(); requestRender(); }
	}

	function render(width: number): string[] {
		const layout = getLayout();
		const safeWidth = Math.max(1, width);
		const bodyWidth = agentFrameContentWidth(safeWidth);
		const activeItems = getActiveItems();
		const hasActive = activeItems.length > 0;
		if (ui.tab === "active" && !hasActive) ui.tab = ui.scope;
		const tabLine = renderAgentBrowserTabs(ui.tab, hasActive, bodyWidth, theme);
		if (ui.tab === "active") {
			const footer = `${ansiYellow("tab")} ${theme.fg("dim", "view · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("←/→")} ${theme.fg("dim", "pane")}`;
			const lines = [tabLine, "", ...renderActiveTabBody(activeItems, runtimeRoot, ui, bodyWidth, theme, layout), agentDivider(bodyWidth, theme), ...wrapTextWithAnsi(footer, bodyWidth)];
			return agentFrame(lines, safeWidth, theme, layout.innerRows, "Agents");
		}
		if (ui.tab === "history") {
			clampHistory();
			loadHistoryRecord(historyRecords[ui.historySelected]);
			const arrowsLabel = ui.pane === "inspector" ? "sections · " : "pane · ";
			const footer = `${ansiYellow("tab")} ${theme.fg("dim", "view · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("←/→")} ${theme.fg("dim", arrowsLabel.replace(/ +$/, ""))}`;
			const lines = [tabLine, "", ...renderHistoryTabBody(historyRecords, historyCache, ui, bodyWidth, theme, layout), agentDivider(bodyWidth, theme), ...wrapTextWithAnsi(footer, bodyWidth)];
			return agentFrame(lines, safeWidth, theme, layout.innerRows, "Agents");
		}
		clamp();
		const footer = `${ansiYellow("tab")} ${theme.fg("dim", "view · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("←/→")} ${theme.fg("dim", "pane · ")}${ansiYellow("alt+m")} ${theme.fg("dim", "edit frontmatter · ")}${ansiYellow("alt+p/o/x")} ${theme.fg("dim", "pane ops")}`;
		const lines = [
			tabLine,
			"",
			...renderAgentsBody(discovery, filtered(), statuses, ui, bodyWidth, theme, layout),
			agentDivider(bodyWidth, theme),
			...wrapTextWithAnsi(footer, bodyWidth),
		];
		return agentFrame(lines, safeWidth, theme, layout.innerRows, "Agents");
	}

	return { handleInput, invalidate() {}, render };
}

async function openAgentsBrowser(
	ctx: ExtensionContext,
	initialScope: AgentScope,
	initialAgentName: string | undefined,
	runtimeRoot: string,
	parentSessionId: string,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	activeTools: string[] | undefined,
	getActiveItems: () => SubagentDashboardItem[],
	onAgentStopped?: (agentName: string) => void,
): Promise<void> {
	const releaseModalLock = acquireVstackModalLock();
	try {
	const initialActive = getActiveItems().length > 0 && !initialAgentName;
	const ui: AgentBrowserUiState = {
		inspectorScroll: 0,
		pane: initialAgentName ? "inspector" : "list",
		tab: initialActive ? "active" : initialScope,
		scope: initialScope,
		search: "",
		selected: 0,
		scroll: 0,
		activeSelected: 0,
		activeScroll: 0,
		historySelected: 0,
		historyScroll: 0,
		historySubtab: 0,
	};
	while (true) {
		const discovery = discoverAgents(ctx.cwd, ui.scope);
		if (initialAgentName) {
			const selected = discovery.agents.findIndex((agent) => agent.name === initialAgentName);
			if (selected >= 0) ui.selected = selected;
			else {
				ctx.ui.notify(`Unknown agent "${initialAgentName}" for scope "${ui.scope}"`, "warning");
				ui.pane = "list";
			}
		}
		const statuses = await loadAgentPaneStatuses(runtimeRoot);
		const taskRegistry = await readTaskRegistry(runtimeRoot).catch(() => ({} as PaneTaskRegistry));
		const action = await ctx.ui.custom<AgentBrowserAction>(
			(tui: TUI, theme: Theme, _keybindings, done) => createAgentsBrowserComponent(
				discovery,
				statuses,
				taskRegistry,
				ui,
				theme,
				() => tui.requestRender(),
				() => agentBrowserLayout(tui.terminal.rows),
				done,
				getActiveItems,
				runtimeRoot,
			),
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: AGENTS_BROWSER_MAX_HEIGHT, width: AGENTS_BROWSER_WIDTH } },
		);
		initialAgentName = undefined;
		if (!action || action.type === "close") return;
		if (action.type === "reload") continue;
		const agent = discovery.agents.find((candidate) => candidate.name === action.agentName);
		if (!agent) {
			ctx.ui.notify(`Unknown agent: ${action.agentName}`, "error");
			continue;
		}
		try {
			if (action.type === "editFrontmatter") {
				const message = await editAgentFrontmatterOverrides(ctx, agent);
				if (message) await showAgentEditConfirmation(ctx, message);
				continue;
			}
			if (action.type === "insert") {
				ctx.ui.pasteToEditor(`Use agent ${agent.name} to: `);
				return;
			}
			if (action.type === "start") {
				if (!agent.pane) throw new Error(`${agent.name} is not configured with pane: true.`);
				await ensurePersistentPane(runtimeRoot, parentSessionId, ctx.cwd, agent, parentModel, parentThinkingLevel, activeTools);
				ctx.ui.notify(`Started/reused ${agent.name}`, "info");
				continue;
			}
			if (action.type === "attach") {
				const registry = await readPaneRegistry(runtimeRoot);
				const entry = registry[agent.name];
				if (!entry || !(await paneExists(entry.paneId))) throw new Error(`No live pane for ${agent.name}.`);
				const result = await tmux(["select-pane", "-t", entry.paneId]);
				if (result.code !== 0) throw new Error(result.stderr || result.stdout || "tmux select-pane failed");
				ctx.ui.notify(`Attached to ${agent.name}`, "info");
				return;
			}
			if (action.type === "stop") {
				await stopPersistentPane(runtimeRoot, agent.name);
				onAgentStopped?.(agent.name);
				ctx.ui.notify(`Stopped ${agent.name}`, "info");
				continue;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
	} finally {
		releaseModalLock();
	}
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => compactPath(p, { maxChars: 72 });

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const compactCommand = command.replace(/\s+/g, " ").trim();
			const preview = /pi-(?:sub)?agents-tmux\/sessions\/.*\/outbox\//.test(compactCommand)
				? "complete_subagent (legacy shell completion)"
				: /^sleep\s+\d+\b/.test(compactCommand)
					? compactCommand.replace(/^sleep\s+/, "wait ")
					: oneLinePreview(compactCommand, 60);
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	taskId?: string;
	paneId?: string;
	queuedTaskFile?: string;
	queuedOutboxFile?: string;
	transcriptPath?: string;
	stopReason?: string;
	errorMessage?: string;
	fullOutputError?: string;
	fullOutputPath?: string;
	step?: number;
	truncation?: TruncationResult;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	fullOutputError?: string;
	fullOutputPath?: string;
	truncation?: TruncationResult;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function normalizeEchoText(value: string): string {
	return value
		.toLowerCase()
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/[`*_#>]/g, " ")
		.replace(/^\s*(?:[-*•]|\d+[.)]|→)\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

function addEchoToken(tokens: Set<string>, value: unknown): void {
	if (typeof value !== "string") return;
	const raw = value.trim();
	if (!raw || raw === "." || raw === "*" || raw === "/") return;
	const normalized = normalizeEchoText(raw);
	if (normalized.length >= 3) tokens.add(normalized);
	const home = os.homedir();
	if (raw.startsWith(home)) {
		const shortened = normalizeEchoText(`~${raw.slice(home.length)}`);
		if (shortened.length >= 3) tokens.add(shortened);
	}
	const base = path.basename(raw);
	if (base && base !== raw) {
		const normalizedBase = normalizeEchoText(base);
		if (normalizedBase.length >= 6) tokens.add(normalizedBase);
	}
}

function extractToolEchoTokens(items: DisplayItem[]): Set<string> {
	const tokens = new Set<string>();
	for (const item of items) {
		if (item.type !== "toolCall") continue;
		const args = item.args ?? {};
		switch (item.name) {
			case "read":
			case "write":
			case "edit":
				addEchoToken(tokens, args.file_path ?? args.path);
				break;
			case "ls":
				addEchoToken(tokens, args.path ?? ".");
				break;
			case "grep":
				addEchoToken(tokens, args.pattern);
				addEchoToken(tokens, args.path);
				addEchoToken(tokens, args.glob);
				break;
			case "find":
				addEchoToken(tokens, args.pattern);
				addEchoToken(tokens, args.path);
				break;
			case "bash": {
				const command = typeof args.command === "string" ? args.command.replace(/\s+/g, " ").trim() : "";
				addEchoToken(tokens, command.length > 90 ? command.slice(0, 90) : command);
				break;
			}
		}
	}
	return tokens;
}

function finalOutputLooksLikeToolEcho(finalOutput: string, toolCalls: DisplayItem[]): boolean {
	if (!finalOutput.trim() || toolCalls.length === 0) return false;
	if (/```/.test(finalOutput)) return false;
	const tokens = extractToolEchoTokens(toolCalls);
	if (tokens.size === 0) return false;
	const lines = finalOutput
		.split(/\r?\n/)
		.map((line) => normalizeEchoText(line))
		.filter(Boolean);
	if (lines.length === 0) return false;

	const proseMarkers = /\b(finding|findings|warning|warn|conclusion|recommendation|because|therefore|issue|bug|risk|observed|validated|failed|failure|passed|note|summary)\b/i;
	const proseLines = lines.filter((line) => proseMarkers.test(line)).length;
	if (proseLines >= 2) return false;

	let matchingLines = 0;
	for (const line of lines) {
		for (const token of tokens) {
			if (line.includes(token)) {
				matchingLines++;
				break;
			}
		}
	}
	const ratio = matchingLines / lines.length;
	if (matchingLines >= 5 && ratio >= 0.65) return true;
	return lines.length <= 25 && matchingLines >= 3 && ratio >= 0.8;
}

function finalResponseSuppressedLine(theme: Theme): string {
	return theme.fg("dim", "(final response repeated the tool activity list; hidden)");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

interface PaneRegistryEntry {
	agent: string;
	paneId: string;
	windowName: string;
	cwd: string;
	sessionFile: string;
	promptFile: string;
	launcherFile: string;
	model?: string;
	thinkingLevel?: string;
	startedAt: string;
	lastTaskAt?: string;
	lastTaskId?: string;
	launcherVersion?: number;
	layoutGroup?: number;
	primaryPaneId?: string;
	bridgePid?: string;
	bridgeSocket?: string;
}

type PaneTaskStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "needs_completion" | "unknown";

interface PaneCompletion {
	agent?: string;
	taskId?: string;
	status?: PaneTaskStatus;
	summary?: string;
	filesChanged?: string[];
	validation?: string[];
	notes?: string;
}

interface PaneCompletionDetails {
	agent: string;
	taskId: string;
	status: PaneTaskStatus;
	summary: string;
	filesChanged: string[];
	validation: string[];
	notes?: string;
	sourcePath: string;
	archivePath?: string;
	transcriptPath?: string;
	completedAt: string;
	paneId?: string;
}

interface PaneCompletionMessageDetails {
	completions: PaneCompletionDetails[];
	partial?: boolean;
}

interface AgentsCommandMessageDetails {
	action?: string;
	agent?: string;
	count?: number;
	error?: string;
	inboxFile?: string;
	outboxFile?: string;
	sessionFile?: string;
	status?: string;
	taskId?: string;
	transcriptPath?: string;
	windowName?: string;
}

interface PaneTaskRecord {
	taskId: string;
	agent: string;
	task: string;
	status: PaneTaskStatus;
	paneId?: string;
	inboxFile?: string;
	processingFile?: string;
	doneFile?: string;
	outboxFile?: string;
	completionSourcePath?: string;
	completionArchivePath?: string;
	transcriptPath?: string;
	summary?: string;
	filesChanged?: string[];
	validation?: string[];
	notes?: string;
	diagnostics?: string[];
	createdAt: string;
	updatedAt?: string;
	completedAt?: string;
}

type PaneRegistry = Record<string, PaneRegistryEntry>;
type PaneTaskRegistry = Record<string, PaneTaskRecord>;

type DashboardDisplayMode = "compact" | "normal" | "expanded";
type DashboardKind = "pane" | "oneshot";

type SubagentDashboardStatus = PaneTaskStatus | "running" | "waiting";

interface SubagentDashboardItem {
	agent: string;
	artifacts?: boolean;
	bridge?: boolean;
	completedAt?: string;
	kind: DashboardKind;
	message?: string;
	paneId?: string;
	startedAt?: string;
	status: SubagentDashboardStatus;
	task?: string;
	taskId: string;
	transcriptPath?: string;
	updatedAt: string;
	usage?: UsageStats;
	model?: string;
}

interface SubagentDashboardState {
	collapsed: boolean;
	mode: DashboardDisplayMode;
	visible: boolean;
	items: Record<string, SubagentDashboardItem>;
}

function safeFileName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

type PreparedSingleResult = {
	fullOutputError?: string;
	fullOutputPath?: string;
	result: SingleResult;
	text: string;
	truncation?: TruncationResult;
};

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

type ResultLimits = { maxBytes: number; maxLines: number };

function resultLimits(cwd?: string): ResultLimits {
	return {
		maxBytes: Math.max(1, Math.floor(settingNumber("resultMaxBytes", DEFAULT_RESULT_MAX_BYTES, cwd))),
		maxLines: Math.max(1, Math.floor(settingNumber("resultMaxLines", DEFAULT_RESULT_MAX_LINES, cwd))),
	};
}

function splitResultLimits(total: ResultLimits, parts: number): ResultLimits {
	const count = Math.max(1, parts);
	return {
		maxBytes: Math.max(1024, Math.floor(total.maxBytes / count)),
		maxLines: Math.max(40, Math.floor(total.maxLines / count)),
	};
}

function formatTruncationNotice(
	truncation: TruncationResult,
	fullOutputPath?: string,
	fullOutputError?: string,
	direction: "head" | "tail" = "head",
): string {
	const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
	const omittedBytes = Math.max(0, truncation.totalBytes - truncation.outputBytes);
	const shown = direction === "tail" ? `showing last ${truncation.outputLines}` : `showing ${truncation.outputLines}`;
	const artifact = fullOutputPath
		? ` Full output saved to: ${fullOutputPath}`
		: fullOutputError
			? ` Full output preservation failed: ${fullOutputError}`
			: "";
	return `[Output truncated (${direction}): ${shown} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.${artifact}]`;
}

async function writeFullOutputArtifact(
	runtimeRoot: string,
	agentName: string,
	label: string,
	text: string,
): Promise<{ error?: string; path?: string }> {
	const dir = path.join(runtimeRoot, "outputs", safeFileName(agentName || "subagent"));
	const filePath = path.join(
		dir,
		`${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName(label || "output")}.txt`,
	);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
		});
		return { path: filePath };
	} catch (error) {
		return { error: stringifyError(error) };
	}
}

async function truncateForToolResult(
	text: string,
	runtimeRoot: string,
	cwd: string,
	agentName: string,
	label: string,
	direction: "head" | "tail" = "head",
	limits: ResultLimits = resultLimits(cwd),
): Promise<Omit<PreparedSingleResult, "result">> {
	if (!settingBoolean("truncateResults", true, cwd)) return { text };
	const truncation = (direction === "tail" ? truncateTail : truncateHead)(text, limits);
	if (!truncation.truncated) return { text: truncation.content };

	const artifact = settingBoolean("preserveFullOutput", true, cwd)
		? await writeFullOutputArtifact(runtimeRoot, agentName, label, text)
		: {};
	return {
		fullOutputError: artifact.error,
		fullOutputPath: artifact.path,
		text: `${truncation.content}\n\n${formatTruncationNotice(truncation, artifact.path, artifact.error, direction)}`,
		truncation,
	};
}

function truncateForDetails(text: string, cwd?: string): string {
	if (!settingBoolean("truncateResults", true, cwd)) return text;
	const truncation = truncateHead(text, resultLimits(cwd));
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated in agent details: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}).]`;
}

function sanitizeDetailValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[Max detail depth reached]";
	if (value == null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") {
		return value.length > DETAIL_STRING_MAX_CHARS
			? `${value.slice(0, DETAIL_STRING_MAX_CHARS)}… [detail string truncated]`
			: value;
	}
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeDetailValue(item, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [index, [key, nested]] of Object.entries(value as Record<string, unknown>).entries()) {
			if (index >= 80) {
				out["[truncated]"] = "detail object field cap reached";
				break;
			}
			out[key] = sanitizeDetailValue(nested, depth + 1);
		}
		return out;
	}
	return String(value);
}

function lastAssistantTextPart(messages: Message[]): { messageIndex: number; partIndex: number } | undefined {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = message.content[partIndex] as any;
			if (part?.type === "text" && typeof part.text === "string") return { messageIndex, partIndex };
		}
	}
	return undefined;
}

function cloneMessagesForDetails(messages: Message[], finalOutputText: string | undefined, cwd?: string): Message[] {
	const final = lastAssistantTextPart(messages);
	const cloned: Message[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant") return;
		const content = message.content.map((part, partIndex) => {
			const candidate = part as any;
			if (candidate?.type === "text" && typeof candidate.text === "string") {
				const isFinal = final?.messageIndex === messageIndex && final?.partIndex === partIndex;
				return { ...candidate, text: isFinal && finalOutputText !== undefined ? finalOutputText : truncateForDetails(candidate.text, cwd) };
			}
			if (candidate?.type === "toolCall") {
				const next = { ...candidate };
				if ("arguments" in next) next.arguments = sanitizeDetailValue(next.arguments);
				if ("args" in next) next.args = sanitizeDetailValue(next.args);
				return next;
			}
			return candidate;
		});
		cloned.push({ ...message, content } as Message);
	});
	return cloned;
}

async function prepareSingleResultForReturn(
	result: SingleResult,
	runtimeRoot: string,
	cwd: string,
	label: string,
	textOverride?: string,
	limits?: ResultLimits,
): Promise<PreparedSingleResult> {
	const finalOutput = getFinalOutput(result.messages);
	const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	const rawText = textOverride ?? (finalOutput || (isError ? result.errorMessage || result.stderr : finalOutput));
	const direction = isError && !finalOutput ? "tail" : "head";
	const output = rawText
		? await truncateForToolResult(rawText, runtimeRoot, cwd, result.agent, label, direction, limits)
		: { text: rawText };
	const prepared: SingleResult = {
		...result,
		messages: cloneMessagesForDetails(result.messages, output.text || undefined, cwd),
	};
	if (isError && output.text && !prepared.errorMessage) prepared.errorMessage = output.text;
	if (output.truncation) {
		prepared.fullOutputError = output.fullOutputError;
		prepared.fullOutputPath = output.fullOutputPath;
		prepared.truncation = output.truncation;
	}
	return { ...output, result: prepared };
}

function detailsWithTruncation(details: SubagentDetails, prepared: PreparedSingleResult): SubagentDetails {
	if (!prepared.truncation) return details;
	return {
		...details,
		fullOutputError: prepared.fullOutputError,
		fullOutputPath: prepared.fullOutputPath,
		truncation: prepared.truncation,
	};
}

function setCurrentTmuxPaneTitle(title: string): void {
	const paneId = process.env.TMUX_PANE;
	if (!paneId) return;
	const proc = spawn("tmux", ["select-pane", "-t", paneId, "-T", title], { stdio: "ignore" });
	proc.on("error", () => undefined);
	proc.unref?.();
}

function registryPath(runtimeRoot: string): string {
	return path.join(runtimeRoot, "panes.json");
}

function taskRegistryPath(runtimeRoot: string): string {
	return path.join(runtimeRoot, "tasks.json");
}

function transcriptDir(runtimeRoot: string): string {
	return path.join(runtimeRoot, "transcripts");
}

function oneShotTranscriptPath(runtimeRoot: string, agentName: string, label: string): string {
	return path.join(transcriptDir(runtimeRoot), safeFileName(agentName || "subagent"), `${Date.now()}-${safeFileName(label || "oneshot")}.jsonl`);
}

function outboxRoot(runtimeRoot: string): string {
	return path.join(runtimeRoot, "outbox");
}

function completionPath(runtimeRoot: string, agentName: string, taskId: string): string {
	return path.join(outboxRoot(runtimeRoot), safeFileName(agentName), `${safeFileName(taskId)}.json`);
}

function inboxDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "inbox", safeFileName(agentName));
}

function processingDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "processing", safeFileName(agentName));
}

function doneDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "done", safeFileName(agentName));
}

function taskMarkdownPath(runtimeRoot: string, dirName: "inbox" | "processing" | "done", agentName: string, taskId: string): string {
	return path.join(runtimeRoot, dirName, safeFileName(agentName), `${safeFileName(taskId)}.md`);
}

function completionArchiveDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "processed", safeFileName(agentName));
}

interface TaskArtifactPaths {
	inboxFile: string;
	processingFile: string;
	doneFile: string;
	outboxFile: string;
	completionArchivePath?: string;
	transcriptPath?: string;
}

function taskArtifactPaths(runtimeRoot: string, record: Pick<PaneTaskRecord, "agent" | "taskId" | "inboxFile" | "processingFile" | "doneFile" | "outboxFile" | "completionArchivePath" | "transcriptPath">): TaskArtifactPaths {
	return {
		inboxFile: record.inboxFile ?? taskMarkdownPath(runtimeRoot, "inbox", record.agent, record.taskId),
		processingFile: record.processingFile ?? taskMarkdownPath(runtimeRoot, "processing", record.agent, record.taskId),
		doneFile: record.doneFile ?? taskMarkdownPath(runtimeRoot, "done", record.agent, record.taskId),
		outboxFile: record.outboxFile ?? completionPath(runtimeRoot, record.agent, record.taskId),
		completionArchivePath: record.completionArchivePath,
		transcriptPath: record.transcriptPath,
	};
}

function legacyProjectRuntimeDirs(cwd: string): string[] {
	const candidates = [path.join(cwd, ".pi", "subagent-runtime")];
	try {
		candidates.push(path.join(path.dirname(projectSettingsPath(cwd)), "subagent-runtime"));
	} catch {
		// Ignore project-root probing failures; the direct cwd candidate is enough.
	}
	return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function stopLegacyPanes(legacyRoot: string): Promise<void> {
	try {
		const content = await fs.promises.readFile(path.join(legacyRoot, "panes.json"), "utf-8");
		const registry = JSON.parse(content) as PaneRegistry;
		for (const entry of Object.values(registry)) {
			if (entry.paneId) await tmux(["kill-pane", "-t", entry.paneId]);
		}
	} catch {
		// Best-effort only. The migration still moves files out of the project.
	}
}

async function migrateLegacyProjectRuntime(cwd: string, runtimeRoot: string): Promise<void> {
	for (const legacyRoot of legacyProjectRuntimeDirs(cwd)) {
		if (legacyRoot === path.resolve(runtimeRoot) || !fs.existsSync(legacyRoot)) continue;
		await stopLegacyPanes(legacyRoot);
		await fs.promises.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
		const target = path.join(runtimeRoot, `legacy-project-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		try {
			await fs.promises.rename(legacyRoot, target);
		} catch {
			try {
				await fs.promises.cp(legacyRoot, target, { recursive: true, force: false });
				await fs.promises.rm(legacyRoot, { recursive: true, force: true });
			} catch {
				// If the filesystem refuses migration, leave the legacy tree in place
				// rather than breaking startup. New runtime state still uses runtimeRoot.
			}
		}
	}
}

function createTaskId(agentName: string): string {
	return `${safeFileName(agentName)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildDelegation(agent: AgentConfig, task: string, outboxFile: string, taskId: string): string {
	const compactTask = task.replace(/\s+/g, " ").trim();
	const schema = JSON.stringify({
		agent: agent.name,
		taskId,
		status: "completed|blocked|failed",
		summary: "1-3 sentence result",
		filesChanged: ["path/or empty"],
		validation: ["command/result or empty"],
		notes: "optional",
	});
	return [
		`Task for ${agent.name}`,
		`Task ID: ${taskId}`,
		"",
		compactTask,
		"",
		"When done, first print one brief final message describing what you produced. Then call complete_subagent with status, summary, filesChanged, validation, and optional notes, and go idle.",
		`If complete_subagent is unavailable, write exactly one JSON object to ${outboxFile} using this schema: ${schema}`,
		"Do not complete before the work is actually done.",
	].join("\n");
}

async function execCapture(command: string, args: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options?.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => (stdout += data.toString()));
		proc.stderr.on("data", (data) => (stderr += data.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
	});
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return execCapture("tmux", args);
}

async function ensureTmux(): Promise<void> {
	if (!process.env.TMUX) throw new Error("Persistent pane agents require tmux ($TMUX is unset).");
	const result = await tmux(["display-message", "-p", "#S"]);
	if (result.code !== 0) throw new Error(`tmux is unavailable: ${result.stderr || result.stdout}`.trim());
}

async function paneExists(paneId: string): Promise<boolean> {
	const result = await tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
	return result.code === 0 && result.stdout.trim() === paneId;
}

async function parentPid(pid: number): Promise<number | undefined> {
	const result = await execCapture("ps", ["-o", "ppid=", "-p", String(pid)]);
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	return result.code === 0 && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function processHasAncestor(pid: number, ancestorPid: number): Promise<boolean> {
	let current: number | undefined = pid;
	const seen = new Set<number>();
	for (let depth = 0; current && depth < 64 && !seen.has(current); depth += 1) {
		if (current === ancestorPid) return true;
		seen.add(current);
		current = await parentPid(current);
	}
	return false;
}

async function paneContainingProcess(pid: number): Promise<string | undefined> {
	const result = await tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
	if (result.code !== 0) return undefined;
	for (const line of result.stdout.split(/\r?\n/)) {
		const [paneId, panePidText] = line.split("\t");
		const panePid = Number.parseInt(panePidText ?? "", 10);
		if (!paneId || !Number.isInteger(panePid) || panePid <= 0) continue;
		if (await processHasAncestor(pid, panePid)) return paneId;
	}
	return undefined;
}

async function getPrimaryPaneId(): Promise<string> {
	// Prefer the pane that actually contains this Pi process. TMUX_PANE can be
	// stale after session/tab reuse and can point at another tmux tab, which would
	// make agent panes split into and steer from the wrong place.
	const currentPane = await paneContainingProcess(process.pid);
	if (currentPane && (await paneExists(currentPane))) return currentPane;
	if (process.env.TMUX_PANE && (await paneExists(process.env.TMUX_PANE))) return process.env.TMUX_PANE;
	const result = await tmux(["display-message", "-p", "#{pane_id}"]);
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	throw new Error(`Unable to determine primary tmux pane: ${result.stderr || result.stdout}`.trim());
}

function columnCapacity(group: number): number {
	return group <= 1 ? FIRST_AGENT_COLUMN_ROWS : NEXT_AGENT_COLUMN_ROWS;
}

function sortPaneEntries(entries: PaneRegistryEntry[]): PaneRegistryEntry[] {
	return [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.agent.localeCompare(b.agent));
}

function groupedPaneEntries(registry: PaneRegistry): Map<number, PaneRegistryEntry[]> {
	const groups = new Map<number, PaneRegistryEntry[]>();
	for (const entry of sortPaneEntries(Object.values(registry))) {
		if (!entry.layoutGroup) continue;
		const group = groups.get(entry.layoutGroup) ?? [];
		group.push(entry);
		groups.set(entry.layoutGroup, group);
	}
	return groups;
}

function nextLayoutGroup(registry: PaneRegistry): number {
	const groups = groupedPaneEntries(registry);
	for (let group = 1; group <= 16; group += 1) {
		if ((groups.get(group)?.length ?? 0) < columnCapacity(group)) return group;
	}
	return Math.max(1, groups.size + 1);
}

async function cleanupPaneRegistry(registry: PaneRegistry): Promise<boolean> {
	let changed = false;
	for (const [agentName, entry] of Object.entries(registry)) {
		if (!(await paneExists(entry.paneId))) {
			delete registry[agentName];
			changed = true;
			continue;
		}
		if (entry.launcherVersion !== PANE_LAUNCHER_VERSION) {
			await tmux(["kill-pane", "-t", entry.paneId]);
			delete registry[agentName];
			changed = true;
		}
	}
	return changed;
}

async function rebalanceColumn(entries: PaneRegistryEntry[]): Promise<void> {
	if (entries.length <= 1) return;
	const sorted = sortPaneEntries(entries);
	const heightResult = await tmux(["display-message", "-p", "-t", sorted[0].paneId, "#{window_height}"]);
	const windowHeight = Number.parseInt(heightResult.stdout.trim(), 10);
	if (heightResult.code !== 0 || !Number.isFinite(windowHeight) || windowHeight <= 0) return;

	const availablePaneRows = Math.max(sorted.length, windowHeight - (sorted.length - 1));
	const targetHeight = Math.max(3, Math.floor(availablePaneRows / sorted.length));
	for (const entry of sorted.slice(0, -1)) {
		await tmux(["resize-pane", "-t", entry.paneId, "-y", String(targetHeight)]);
	}
}

async function rebalanceColumns(registry: PaneRegistry, primaryPaneId: string): Promise<void> {
	const groups = groupedPaneEntries(registry);
	const columns = [{ paneId: primaryPaneId, group: 0 }];
	for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => a - b)) {
		const representative = sortPaneEntries(entries)[0];
		if (representative) columns.push({ paneId: representative.paneId, group });
	}
	if (columns.length <= 1) return;

	const measured: Array<{ paneId: string; left: number; windowWidth: number }> = [];
	for (const column of columns) {
		if (!(await paneExists(column.paneId))) continue;
		const result = await tmux(["display-message", "-p", "-t", column.paneId, "#{pane_left}\t#{window_width}"]);
		const [leftText, windowWidthText] = result.stdout.trim().split("\t");
		const left = Number.parseInt(leftText ?? "", 10);
		const windowWidth = Number.parseInt(windowWidthText ?? "", 10);
		if (result.code === 0 && Number.isFinite(left) && Number.isFinite(windowWidth)) measured.push({ paneId: column.paneId, left, windowWidth });
	}
	if (measured.length <= 1) return;

	measured.sort((a, b) => a.left - b.left);
	const windowWidth = measured[0].windowWidth;
	const availablePaneColumns = Math.max(measured.length, windowWidth - (measured.length - 1));
	const baseWidth = Math.max(10, Math.floor(availablePaneColumns / measured.length));
	const remainder = Math.max(0, availablePaneColumns - baseWidth * measured.length);
	for (const [index, column] of measured.entries()) {
		const targetWidth = baseWidth + (index >= measured.length - remainder ? 1 : 0);
		await tmux(["resize-pane", "-t", column.paneId, "-x", String(targetWidth)]);
	}
}

async function readPaneRegistry(runtimeRoot: string): Promise<PaneRegistry> {
	try {
		const content = await fs.promises.readFile(registryPath(runtimeRoot), "utf-8");
		return JSON.parse(content) as PaneRegistry;
	} catch {
		return {};
	}
}

async function writePaneRegistry(runtimeRoot: string, registry: PaneRegistry): Promise<void> {
	const filePath = registryPath(runtimeRoot);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}

async function updatePaneRegistry(
	runtimeRoot: string,
	mutator: (registry: PaneRegistry) => Promise<void> | void,
): Promise<PaneRegistry> {
	const filePath = registryPath(runtimeRoot);
	let registry: PaneRegistry = {};
	await withFileMutationQueue(filePath, async () => {
		try {
			const content = await fs.promises.readFile(filePath, "utf-8");
			const parsed = JSON.parse(content);
			registry = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PaneRegistry) : {};
		} catch {
			registry = {};
		}
		await mutator(registry);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	});
	return registry;
}

async function readTaskRegistry(runtimeRoot: string): Promise<PaneTaskRegistry> {
	try {
		const content = await fs.promises.readFile(taskRegistryPath(runtimeRoot), "utf-8");
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) {
			return Object.fromEntries(parsed.filter((record) => record?.taskId).map((record) => [record.taskId, record])) as PaneTaskRegistry;
		}
		return parsed && typeof parsed === "object" ? (parsed as PaneTaskRegistry) : {};
	} catch {
		return {};
	}
}

async function writeTaskRegistry(runtimeRoot: string, records: PaneTaskRegistry): Promise<void> {
	const filePath = taskRegistryPath(runtimeRoot);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(records, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}

async function updateTaskRegistry(runtimeRoot: string, mutator: (records: PaneTaskRegistry) => void): Promise<PaneTaskRegistry> {
	const filePath = taskRegistryPath(runtimeRoot);
	let records: PaneTaskRegistry = {};
	await withFileMutationQueue(filePath, async () => {
		try {
			const content = await fs.promises.readFile(filePath, "utf-8");
			const parsed = JSON.parse(content);
			records = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PaneTaskRegistry) : {};
		} catch {
			records = {};
		}
		mutator(records);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(records, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	});
	return records;
}

async function upsertTaskRecord(runtimeRoot: string, record: PaneTaskRecord): Promise<void> {
	await updateTaskRegistry(runtimeRoot, (records) => {
		records[record.taskId] = { ...records[record.taskId], ...record };
	});
}

function normalizePaneTaskStatus(status: unknown): PaneTaskStatus {
	return status === "queued" || status === "running" || status === "completed" || status === "blocked" || status === "failed" || status === "needs_completion"
		? status
		: "unknown";
}

function isTerminalTaskStatus(status: PaneTaskStatus | undefined): boolean {
	return status === "completed" || status === "blocked" || status === "failed";
}

function appendUniqueDiagnostic(existing: string[] | undefined, diagnostic: string): string[] {
	const compact = diagnostic.replace(/\s+/g, " ").trim();
	if (!compact) return existing ?? [];
	const diagnostics = [...(existing ?? [])];
	if (!diagnostics.includes(compact)) diagnostics.push(compact);
	return diagnostics.slice(-8);
}

function completionParseErrorMessage(filePath: string, error: unknown): string {
	return `Malformed completion JSON at ${filePath}: ${stringifyError(error)}. Replace it with one valid completion object or call complete_subagent again.`;
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
	if (!filePath) return false;
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readPaneCompletionFile(filePath: string): Promise<{ completion?: PaneCompletion; error?: unknown; exists: boolean }> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return { exists: false };
		return { error, exists: true };
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("completion must be a JSON object");
		return { completion: parsed as PaneCompletion, exists: true };
	} catch (error) {
		return { error, exists: true };
	}
}

async function markTaskNeedsCompletion(
	runtimeRoot: string,
	agentName: string,
	taskId: string,
	options: {
		diagnostic: string;
		doneFile?: string;
		outboxFile?: string;
		processingFile?: string;
		transcriptPath?: string;
	},
): Promise<PaneTaskRecord | undefined> {
	let updated: PaneTaskRecord | undefined;
	const now = new Date().toISOString();
	await updateTaskRegistry(runtimeRoot, (records) => {
		const existing = records[taskId];
		if (isTerminalTaskStatus(existing?.status)) {
			updated = existing;
			return;
		}
		const outboxFile = options.outboxFile ?? existing?.outboxFile ?? completionPath(runtimeRoot, agentName, taskId);
		updated = {
			...existing,
			taskId,
			agent: existing?.agent ?? agentName,
			task: existing?.task ?? "",
			status: "needs_completion",
			inboxFile: existing?.inboxFile,
			processingFile: options.processingFile ?? existing?.processingFile,
			doneFile: options.doneFile ?? existing?.doneFile,
			outboxFile,
			transcriptPath: options.transcriptPath ?? existing?.transcriptPath,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			diagnostics: appendUniqueDiagnostic(existing?.diagnostics, options.diagnostic),
		};
		records[taskId] = updated;
	});
	return updated;
}

async function refreshTaskDiagnostics(runtimeRoot: string, record: PaneTaskRecord): Promise<{ record: PaneTaskRecord; diagnostics: string[] }> {
	const paths = taskArtifactPaths(runtimeRoot, record);
	const [inboxExists, processingExists, doneExists, outboxExists, archiveExists, transcriptExists] = await Promise.all([
		fileExists(paths.inboxFile),
		fileExists(paths.processingFile),
		fileExists(paths.doneFile),
		fileExists(paths.outboxFile),
		fileExists(paths.completionArchivePath),
		fileExists(paths.transcriptPath),
	]);

	let nextStatus = record.status;
	let diagnostics = [...(record.diagnostics ?? [])];
	const add = (message: string) => {
		diagnostics = appendUniqueDiagnostic(diagnostics, message);
	};

	if (!isTerminalTaskStatus(record.status)) {
		if (processingExists && record.status === "queued") {
			nextStatus = "running";
			add(`Task file was claimed by the child pane: ${paths.processingFile}`);
		}
		if (doneExists && !outboxExists && !archiveExists) {
			nextStatus = "needs_completion";
			add(`Task turn ended but no completion record was found. Expected outbox: ${paths.outboxFile}`);
		}
		if (outboxExists) {
			const parsed = await readPaneCompletionFile(paths.outboxFile);
			if (parsed.error) {
				nextStatus = "needs_completion";
				add(completionParseErrorMessage(paths.outboxFile, parsed.error));
			}
		}
		if (!inboxExists && !processingExists && !doneExists && !outboxExists && !archiveExists) {
			if (record.status === "queued" || record.status === "running") nextStatus = "unknown";
			add(`No task handoff or completion artifacts are present for ${record.taskId}; the pane may have been reset or the runtime was cleaned.`);
		}
	}

	const artifactDiagnostics = [
		`Expected outbox: ${paths.outboxFile} (${outboxExists ? "present" : "missing"})`,
		`Inbox file: ${paths.inboxFile} (${inboxExists ? "present" : "missing"})`,
		`Processing file: ${paths.processingFile} (${processingExists ? "present" : "missing"})`,
		`Done file: ${paths.doneFile} (${doneExists ? "present" : "missing"})`,
		paths.completionArchivePath ? `Archived completion: ${paths.completionArchivePath} (${archiveExists ? "present" : "missing"})` : "Archived completion: (none recorded)",
		paths.transcriptPath ? `Transcript: ${paths.transcriptPath} (${transcriptExists ? "present" : "missing"})` : "Transcript: (none recorded)",
	];

	const pathPatch = {
		inboxFile: record.inboxFile ?? paths.inboxFile,
		processingFile: record.processingFile ?? (processingExists ? paths.processingFile : undefined),
		doneFile: record.doneFile ?? (doneExists ? paths.doneFile : undefined),
		outboxFile: record.outboxFile ?? paths.outboxFile,
	};
	const changed =
		nextStatus !== record.status ||
		diagnostics.join("\n") !== (record.diagnostics ?? []).join("\n") ||
		pathPatch.inboxFile !== record.inboxFile ||
		pathPatch.processingFile !== record.processingFile ||
		pathPatch.doneFile !== record.doneFile ||
		pathPatch.outboxFile !== record.outboxFile;

	if (!changed) return { record, diagnostics: [...diagnostics, ...artifactDiagnostics] };

	let updated = record;
	await updateTaskRegistry(runtimeRoot, (records) => {
		const existing = records[record.taskId] ?? record;
		updated = {
			...existing,
			...pathPatch,
			status: nextStatus,
			diagnostics,
			updatedAt: new Date().toISOString(),
		};
		records[record.taskId] = updated;
	});
	return { record: updated, diagnostics: [...diagnostics, ...artifactDiagnostics] };
}

function latestTaskRecord(records: PaneTaskRegistry, agent?: string): PaneTaskRecord | undefined {
	return Object.values(records)
		.filter((record) => !agent || record.agent === agent)
		.sort((a, b) => (b.updatedAt ?? b.completedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.completedAt ?? a.createdAt))[0];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitSubagentEvent(pi: ExtensionAPI, event: string, payload: Record<string, unknown>): void {
	try {
		const bus = (pi as unknown as { events?: { emit?: (name: string, payload: unknown) => void } }).events;
		bus?.emit?.(event, {
			package: PACKAGE_ID,
			...payload,
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Lifecycle events are best-effort extension integration signals.
	}
}

function dashboardKindLabel(kind: DashboardKind): string {
	return kind === "oneshot" ? "bg" : kind;
}

function dashboardStatusFor(rawStatus: PaneTaskStatus | "running" | "waiting", kind: DashboardKind): SubagentDashboardStatus {
	// Persistent panes return to idle after each task; surface 'completed' as
	// 'waiting' so the dashboard reads the pane state correctly. Oneshots keep
	// 'completed' since their pane exits with the task.
	if (rawStatus === "completed" && kind === "pane") return "waiting";
	return rawStatus;
}

function dashboardStatusIcon(status: SubagentDashboardItem["status"], theme: Theme): string {
	if (status === "completed") return theme.fg("success", ICONS.check);
	if (status === "failed") return theme.fg("error", ICONS.times);
	if (status === "blocked") return theme.fg("error", ICONS.times);
	if (status === "needs_completion") return theme.fg("warning", ICONS.warning);
	if (status === "running") return theme.fg("warning", ICONS.cog);
	if (status === "waiting") return theme.fg("warning", ICONS.clock);
	if (status === "queued") return theme.fg("warning", ICONS.clock);
	return theme.fg("accent", ICONS.circleFilled);
}

function dashboardStatusText(item: SubagentDashboardItem, theme: Theme): string {
	if (item.status === "completed") return theme.fg("success", "done");
	if (item.status === "failed") return theme.fg("error", "failed");
	if (item.status === "blocked") return theme.fg("warning", "blocked");
	if (item.status === "needs_completion") return theme.fg("warning", "needs completion");
	if (item.status === "running") return theme.fg("warning", "working");
	if (item.status === "waiting") return theme.fg("warning", "waiting");
	if (item.status === "queued") return theme.fg("warning", "queued");
	return theme.fg("accent", item.status);
}

function dashboardFrame(lines: string[], width: number, theme: Theme): string[] {
	return simpleFrame(lines, width, theme);
}

function toolChromeRule(theme: Theme, width: number): string {
	const rule = "─".repeat(Math.max(1, width));
	for (const token of ["borderMuted", "muted", "dim"] as const) {
		try {
			const styled = theme.fg(token, rule);
			const textStyled = theme.fg("text", rule);
			if (styled !== rule && styled !== textStyled) return styled;
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

function wrappedText(text: string): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			return wrapAnsiLines(text, width);
		},
	};
}

function framedComponent(inner: Component, theme: Theme): Component {
	return {
		invalidate() {
			inner.invalidate?.();
		},
		render(width: number): string[] {
			const rule = toolChromeRule(theme, width);
			return [rule, ...inner.render(width), rule];
		},
	};
}

function framedMessage(content: string, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const rule = toolChromeRule(theme, width);
			return [rule, ...wrapAnsiLines(content, width), rule];
		},
	};
}

function agentsCommandBullet(theme: Theme): string {
	return theme.fg("accent", "● ");
}

function agentWord(theme: Theme): string {
	return theme.fg("accent", theme.bold("Agent"));
}

function agentStatusBadge(theme: Theme, label: string, tone: "success" | "warning" | "error" | "muted" = "muted"): string {
	return theme.fg(tone, label);
}

function agentStatusLine(theme: Theme, agent: string, label: string, tone: "success" | "warning" | "error" | "muted", suffix = ""): string {
	return `${agentsCommandBullet(theme)}${agentWord(theme)} ${ansiMagenta(theme.bold(agent))} ${agentStatusBadge(theme, label, tone)}${suffix}`;
}

function agentsCommandArtifactLine(theme: Theme, branch: "├" | "└", label: string, filePath: string | undefined, width: number): string {
	const prefix = `${subagentBranch(theme, branch)}${theme.fg("muted", `${label} `)}`;
	const maxChars = Math.max(24, width - visibleWidth(prefix) - 1);
	return `${prefix}${theme.fg("toolOutput", compactPath(filePath, { maxChars }))}`;
}

function renderAgentsCommandMessage(message: { content: string; details?: unknown }, _options: unknown, theme: Theme): Component {
	const details = message.details && typeof message.details === "object" ? (message.details as AgentsCommandMessageDetails) : undefined;
	const action = details?.action;
	const error = details?.error ?? (/^Error:\s*/.test(message.content) ? message.content.replace(/^Error:\s*/, "") : undefined);

	if (error) {
		return framedMessage(
			[
				`${theme.fg("error", ICONS.times)} ${theme.fg("toolTitle", theme.bold("/agents error"))}`,
				`${subagentBranch(theme, "└")}${theme.fg("error", error)}`,
			].join("\n"),
			theme,
		);
	}

	if (action === "send" && details?.agent) {
		return {
			invalidate() {},
			render(width: number): string[] {
				const rule = toolChromeRule(theme, width);
				const taskSuffix = details.taskId ? `${theme.fg("dim", " · ")}${theme.fg("muted", shortTaskId(details.taskId))}` : "";
				const lines = [
					agentStatusLine(theme, details.agent!, "Queued task", "warning", taskSuffix),
					agentsCommandArtifactLine(theme, "├", "inbox", details.inboxFile, width),
					agentsCommandArtifactLine(theme, "├", "completion", details.outboxFile, width),
					agentsCommandArtifactLine(theme, "└", "transcript", details.transcriptPath, width),
				];
				return [rule, ...lines.flatMap((line) => wrapAnsiLines(line, width)), rule];
			},
		};
	}

	if (action === "start" && details?.agent) {
		return framedMessage(
			[
				agentStatusLine(theme, details.agent, "started", "success", theme.fg("dim", ` · ${details.windowName ?? "pane"}`)),
				`${subagentBranch(theme, "└")}${theme.fg("muted", "session ")}${theme.fg("toolOutput", compactPath(details.sessionFile))}`,
			].join("\n"),
			theme,
		);
	}

	if (action === "attach" && details?.agent) {
		return framedMessage(agentStatusLine(theme, details.agent, "attached", "success"), theme);
	}

	if (action === "stop" && details?.agent) {
		return framedMessage(agentStatusLine(theme, details.agent, "stopped", "success"), theme);
	}

	if (action === "collect") {
		const count = Number.isFinite(Number(details?.count)) ? Number(details?.count) : undefined;
		return framedMessage(`${agentsCommandBullet(theme)}${theme.fg("toolTitle", theme.bold("/agents collect "))}${theme.fg("success", `${count ?? 0} completion${count === 1 ? "" : "s"}`)}`, theme);
	}

	if (action === "toggle") {
		return framedMessage(`${agentsCommandBullet(theme)}${theme.fg("toolTitle", theme.bold("/agents toggle "))}${theme.fg("success", details?.status ?? oneLinePreview(message.content, 80))}`, theme);
	}

	if (message.content.trim().startsWith("#") || message.content.includes("\n| ---")) {
		return framedComponent(new Markdown(message.content, 0, 0, getMarkdownTheme()), theme);
	}

	return framedMessage(`${agentsCommandBullet(theme)}${theme.fg("toolTitle", theme.bold("/agents "))}${theme.fg("toolOutput", message.content)}`, theme);
}

function dashboardTranscriptLabel(items: SubagentDashboardItem[], cwd: string): string {
	const refs = [...new Set(items.map((item) => dashboardTraceRef(item)).filter(Boolean))];
	if (refs.length === 0) return "transcripts available";
	if (refs.length === 1) return `transcript ${refs[0]}`;
	const sessionRefs = [...new Set(refs.map((ref) => ref.split("/")[0]).filter(Boolean))];
	if (sessionRefs.length === 1) return `${refs.length} transcripts · session ${sessionRefs[0]}`;
	return `${refs.length} transcripts · ${refs[0]} +${refs.length - 1}`;
}

function shortRuntimeSessionIdFromPath(filePath: string | undefined): string {
	if (!filePath) return "session";
	const parts = path.normalize(filePath).split(path.sep).filter(Boolean);
	const rootIndex = parts.lastIndexOf(PACKAGE_ID);
	const sessionsIndex = rootIndex >= 0 ? parts.indexOf("sessions", rootIndex + 1) : parts.lastIndexOf("sessions");
	const parentSession = sessionsIndex >= 0 ? parts[sessionsIndex + 1] : undefined;
	return parentSession ? oneLinePreview(parentSession, 8) : "session";
}

function shortTaskRef(taskId: string | undefined): string {
	if (!taskId) return "task";
	const hash = taskId.match(/-([a-f0-9]{8,})$/)?.[1]?.slice(0, 8);
	const timestamp = taskId.match(/-(\d{10,})-/)?.[1];
	return hash ? `${timestamp ? `${timestamp.slice(-6)}-` : ""}${hash}` : oneLinePreview(taskId, 16);
}

function dashboardTraceRef(item: Pick<SubagentDashboardItem, "agent" | "taskId" | "transcriptPath" | "kind">): string {
	const session = shortRuntimeSessionIdFromPath(item.transcriptPath);
	if (item.kind === "pane") return `${session}/${item.agent}/${shortTaskRef(item.taskId)}`;
	return dashboardTranscriptRef(item.transcriptPath) || `${session}/${item.agent}/${shortTaskRef(item.taskId)}`;
}

function dashboardTranscriptRef(filePath: string | undefined): string {
	if (!filePath) return "";
	const parts = path.normalize(filePath).split(path.sep).filter(Boolean);
	const rootIndex = parts.lastIndexOf(PACKAGE_ID);
	const sessionsIndex = rootIndex >= 0 ? parts.indexOf("sessions", rootIndex + 1) : parts.lastIndexOf("sessions");
	const parentSession = sessionsIndex >= 0 ? parts[sessionsIndex + 1] : undefined;
	const shortSession = parentSession ? oneLinePreview(parentSession, 8) : "session";
	const runtimeRelative = sessionsIndex >= 0 && parentSession ? parts.slice(sessionsIndex + 2) : [];
	const file = path.basename(filePath, path.extname(filePath));
	if (runtimeRelative[0] === "sessions") return `${shortSession}/${file}`;
	if (runtimeRelative[0] === "transcripts" && runtimeRelative[1]) {
		const hash = file.match(/-([a-f0-9]{8,})$/)?.[1]?.slice(0, 8);
		const timestamp = file.match(/-(\d{10,})-/)?.[1];
		const suffix = hash ? `${timestamp ? `${timestamp.slice(-6)}-` : ""}${hash}` : "";
		return `${shortSession}/${runtimeRelative[1]}${suffix ? `/${suffix}` : ""}`;
	}
	return `${shortSession}/${file}`;
}

function renderDashboardWidgetLines(state: SubagentDashboardState, theme: Theme, cwd: string, width: number): string[] {
	// Sort by start time first so the row order is stable - using updatedAt
	// here would shuffle rows on every transcript-usage poll. Fall back to
	// taskId for tie-breaks.
	const items = Object.values(state.items).sort((a, b) => {
		const aKey = a.startedAt ?? a.taskId;
		const bKey = b.startedAt ?? b.taskId;
		if (aKey === bKey) return 0;
		return aKey < bKey ? -1 : 1;
	});
	if (!dashboardEnabled(cwd) || !state.visible || items.length === 0) return [];
	const running = items.filter((item) => item.status === "running" || item.status === "queued").length;
	const waiting = items.filter((item) => item.status === "waiting").length;
	const done = items.filter((item) => item.status === "completed").length;
	const failed = items.filter((item) => item.status === "failed" || item.status === "blocked").length;
	const shortcut = dashboardShortcut(cwd);
	const popup = popupShortcut(cwd);
	const toggleHint = shortcut === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(shortcut)} toggle`);
	const popupHint = popup === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(popup)} popup`);
	const hint = `${toggleHint}${popupHint}`;
	const headerParts = [
		done ? `${done} done` : "",
		running ? theme.fg("warning", `${running} working`) : "",
		waiting ? theme.fg("warning", `${waiting} waiting`) : "",
		failed ? theme.fg("error", `${failed} attention`) : "",
	].filter(Boolean);
	if (headerParts.length === 0) headerParts.push(`${items.length} ready`);
	const title = `${theme.fg("customMessageLabel", theme.bold("Agents"))} ${theme.fg("muted", headerParts.join(" · "))}${hint}`;
	const lines = [title];
	const aggregateDashboardUsage = (entries: SubagentDashboardItem[]): UsageStats | undefined => {
		const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		let any = false;
		for (const entry of entries) {
			if (!entry.usage) continue;
			any = true;
			total.input += entry.usage.input || 0;
			total.output += entry.usage.output || 0;
			total.cacheRead += entry.usage.cacheRead || 0;
			total.cacheWrite += entry.usage.cacheWrite || 0;
			total.cost += entry.usage.cost || 0;
			total.contextTokens = Math.max(total.contextTokens, entry.usage.contextTokens || 0);
			total.turns = (total.turns ?? 0) + (entry.usage.turns ?? 0);
		}
		return any ? total : undefined;
	};
	const dotSep = theme.fg("dim", " · ");
	if (running === 0 && state.mode === "compact") {
		const aggregated = aggregateDashboardUsage(items);
		const usageParts = aggregated ? formatUsageStatsForDashboard(aggregated) : [];
		const body = usageParts.length > 0
			? usageParts.map((part) => theme.fg("dim", part)).join(dotSep)
			: theme.fg("dim", `${items.length} transcript${items.length === 1 ? "" : "s"}`);
		lines.push(`${subagentBranch(theme, "└", cwd)}${body}`);
		return dashboardFrame(lines.map((line) => truncateToWidth(line, Math.max(1, width - 4), "")), Math.max(1, width), theme);
	}
	const maxItems = state.mode === "compact" || state.collapsed ? 1 : state.mode === "normal" ? Math.min(3, dashboardMaxItems(cwd)) : dashboardMaxItems(cwd);
	const shown = items.slice(0, maxItems);
	const nameWidth = Math.min(24, Math.max(0, ...shown.map((item) => visibleWidth(item.agent))));
	for (const [index, item] of shown.entries()) {
		const branch = subagentBranch(theme, index === shown.length - 1 && items.length <= shown.length ? "└" : "├", cwd);
		const name = padAnsi(ansiMagenta(theme.bold(item.agent)), nameWidth);
		const rowParts: string[] = [
			dashboardStatusText(item, theme),
			theme.fg("dim", dashboardKindLabel(item.kind)),
		];
		if (item.bridge) rowParts.push(theme.fg("success", "bridge"));
		if (item.usage) {
			for (const part of formatUsageStatsForDashboard(item.usage)) {
				rowParts.push(theme.fg("dim", part));
			}
		}
		lines.push(`${branch}${dashboardStatusIcon(item.status, theme)} ${name}${dotSep}${rowParts.join(dotSep)}`);
		if (state.mode === "expanded" && !state.collapsed && item.message) {
			lines.push(`${subagentStem(theme, index === shown.length - 1 && items.length <= shown.length, cwd)}${theme.fg("toolOutput", oneLinePreview(item.message, Math.max(48, width - 16)))}`);
		}
	}
	const hidden = items.length - shown.length;
	if (hidden > 0) lines.push(`${subagentBranch(theme, "└", cwd)}${theme.fg("muted", `… ${hidden} more · /agents toggle`)}`);
	if (state.mode === "expanded" && !state.collapsed) {
		const aggregated = aggregateDashboardUsage(items);
		if (aggregated) {
			const totalParts = formatUsageStatsForDashboard(aggregated).map((part) => theme.fg("dim", part)).join(dotSep);
			if (totalParts.length > 0) {
				lines.push(`${subagentBranch(theme, "└", cwd)}${theme.fg("dim", "Total")}${dotSep}${totalParts}`);
			}
		}
	}
	return dashboardFrame(lines.map((line) => truncateToWidth(line, Math.max(1, width - 4), "")), Math.max(1, width), theme);
}

function resolveSessionBridgeExtension(cwd?: string): string | undefined {
	const projectPackagesDir = path.join(path.dirname(projectSettingsPath(cwd ?? process.cwd())), "packages");
	const candidates = [
		process.env.PI_SESSION_BRIDGE_EXTENSION,
		path.join(piUserDir(), "packages", SESSION_BRIDGE_PACKAGE_ID, "extensions", "session-bridge.ts"),
		path.join(projectPackagesDir, SESSION_BRIDGE_PACKAGE_ID, "extensions", "session-bridge.ts"),
		path.resolve(cwd ?? process.cwd(), "pi-extensions", "session-bridge", "extensions", "session-bridge.ts"),
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => fs.existsSync(candidate));
}

async function resolvePiBridgeBin(): Promise<string | undefined> {
	const projectBinDir = path.join(path.dirname(projectSettingsPath(process.cwd())), "bin");
	const projectPackagesDir = path.join(path.dirname(projectSettingsPath(process.cwd())), "packages");
	const candidates = [
		process.env.PI_BRIDGE_BIN,
		path.join(piUserDir(), "bin", "pi-bridge"),
		path.join(piUserDir(), "packages", SESSION_BRIDGE_PACKAGE_ID, "bin", "pi-bridge.js"),
		path.join(projectBinDir, "pi-bridge"),
		path.join(projectPackagesDir, SESSION_BRIDGE_PACKAGE_ID, "bin", "pi-bridge.js"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	const result = await execCapture("bash", ["-lc", "command -v pi-bridge || true"]);
	const found = result.stdout.trim().split(/\r?\n/)[0];
	return found || undefined;
}

interface BridgeMetadata {
	pid?: string;
	sessionFile?: string;
	socket?: string;
}

function normalizedPath(value: string): string {
	return path.normalize(path.resolve(value));
}

function samePath(left: string | undefined, right: string | undefined): boolean {
	return Boolean(left && right && normalizedPath(left) === normalizedPath(right));
}

function pathWithin(parentDir: string, childPath: string): boolean {
	const parent = normalizedPath(parentDir);
	const child = normalizedPath(childPath);
	const relative = path.relative(parent, child);
	return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function paneSessionBelongsToRuntime(runtimeRoot: string, entry: PaneRegistryEntry): boolean {
	return pathWithin(path.join(runtimeRoot, "sessions"), entry.sessionFile);
}

async function discoverBridgeMetadataForPane(entry: PaneRegistryEntry, timeoutMs = 0): Promise<BridgeMetadata | undefined> {
	const bin = await resolvePiBridgeBin();
	if (!bin) return undefined;
	const deadline = Date.now() + Math.max(0, timeoutMs);
	do {
		const result = await execCapture(bin, ["list", "--json"]);
		if (result.code === 0 && result.stdout.trim()) {
			try {
				const instances = (JSON.parse(result.stdout) as Array<Record<string, unknown>>)
					.filter((info) => info && info.stale !== true)
					.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
				const match = instances.filter((info) => {
					const sessionFile = typeof info.sessionFile === "string" ? info.sessionFile : "";
					return samePath(sessionFile, entry.sessionFile);
				}).at(-1);
				if (match) {
					const pid = match.pid == null ? undefined : String(match.pid);
					const socket = typeof match.socketPath === "string" ? match.socketPath : undefined;
					const sessionFile = typeof match.sessionFile === "string" ? match.sessionFile : undefined;
					if (pid || socket) return { pid, sessionFile, socket };
				}
			} catch {
				// Keep polling until timeout; bridge list output may be transiently incomplete.
			}
		}
		if (Date.now() >= deadline) break;
		await delay(500);
	} while (true);
	return undefined;
}

async function ensurePaneBridgeMetadata(runtimeRoot: string, entry: PaneRegistryEntry): Promise<BridgeMetadata | undefined> {
	if (!paneSessionBelongsToRuntime(runtimeRoot, entry)) return undefined;
	// Always re-discover by exact child session file. Do not trust stored pid/socket
	// and never fall back to cwd: multiple Pi sessions commonly share the same cwd.
	const metadata = await discoverBridgeMetadataForPane(entry, 2000);
	if ((!metadata?.pid && !metadata?.socket) || !samePath(metadata.sessionFile, entry.sessionFile)) return undefined;
	await updatePaneRegistry(runtimeRoot, (registry) => {
		const current = registry[entry.agent];
		if (current && samePath(current.sessionFile, entry.sessionFile)) {
			current.bridgePid = metadata.pid;
			current.bridgeSocket = metadata.socket;
		}
	});
	entry.bridgePid = metadata.pid;
	entry.bridgeSocket = metadata.socket;
	return metadata;
}

async function writeLauncher(
	runtimeRoot: string,
	parentSessionId: string,
	cwd: string,
	agent: AgentConfig,
	model: string | undefined,
	thinkingLevel: string | undefined,
	activeTools?: string[],
): Promise<{ sessionFile: string; promptFile: string; launcherFile: string }> {
	const dir = runtimeRoot;
	const safeName = safeFileName(agent.name);
	const sessionsDir = path.join(dir, "sessions");
	const promptsDir = path.join(dir, "prompts");
	const launchersDir = path.join(dir, "launchers");
	await fs.promises.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
	await fs.promises.mkdir(promptsDir, { recursive: true, mode: 0o700 });
	await fs.promises.mkdir(launchersDir, { recursive: true, mode: 0o700 });

	const sessionFile = path.join(sessionsDir, `${safeName}.jsonl`);
	const promptFile = path.join(promptsDir, `${safeName}.md`);
	const launcherFile = path.join(launchersDir, `${safeName}.sh`);

	await withFileMutationQueue(promptFile, async () => {
		await fs.promises.writeFile(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = ["--session", sessionFile, "--append-system-prompt", promptFile];
	const bridgeExtension = settingBoolean("forceSessionBridgeForPanes", true, cwd) ? resolveSessionBridgeExtension(cwd) : undefined;
	if (bridgeExtension) args.push("-e", bridgeExtension);
	if (model) args.push("--model", model);
	if (thinkingLevel && thinkingLevel !== "off") args.push("--thinking", thinkingLevel);
	const selectedTools = selectedToolsForAgent(agent, cwd, ["complete_subagent"], activeTools);
	if (selectedTools && selectedTools.length > 0) args.push("--tools", selectedTools.join(","));

	const invocation = getPiInvocation(args);
	const command = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
	const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(cwd)}
export PI_SUBAGENT_CHILD_AGENT=${shellQuote(agent.name)}
${agent.color ? `export PI_SUBAGENT_CHILD_COLOR=${shellQuote(agent.color)}` : "unset PI_SUBAGENT_CHILD_COLOR"}
export PI_SUBAGENT_PARENT_SESSION_ID=${shellQuote(parentSessionId)}
# Inherit cached 1Password service-account token if available so the child
# pi can read op:// refs without triggering the desktop CLI integration
# prompt. No-op for users who don't use 1Password (file won't exist).
if [ -z "\${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -r "/run/user/\$(id -u)/op-service-account-token" ]; then
    __op_tok=\$(cat "/run/user/\$(id -u)/op-service-account-token" 2>/dev/null || true)
    [ -n "\$__op_tok" ] && export OP_SERVICE_ACCOUNT_TOKEN="\$__op_tok"
    unset __op_tok
fi
exec ${command}
`;
	await withFileMutationQueue(launcherFile, async () => {
		await fs.promises.writeFile(launcherFile, script, { encoding: "utf-8", mode: 0o700 });
	});

	return { sessionFile, promptFile, launcherFile };
}

async function ensurePersistentPane(
	runtimeRoot: string,
	parentSessionId: string,
	cwd: string,
	agent: AgentConfig,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	activeTools?: string[],
): Promise<PaneRegistryEntry> {
	await ensureTmux();

	let entry: PaneRegistryEntry | undefined;
	let reusedExisting = false;
	let layoutGroup: number | undefined;
	let primaryPaneId: string | undefined;

	await updatePaneRegistry(runtimeRoot, async (registry) => {
		await cleanupPaneRegistry(registry);

		const existing = registry[agent.name];
		if (existing && (await paneExists(existing.paneId))) {
			entry = existing;
			reusedExisting = true;
			return;
		}

		const selectedModel = selectedModelForAgent(agent, parentModel, cwd);
		const paths = await writeLauncher(runtimeRoot, parentSessionId, cwd, agent, selectedModel, parentThinkingLevel, activeTools);
		const windowName = `agent:${agent.name}`;
		primaryPaneId = await getPrimaryPaneId();
		layoutGroup = nextLayoutGroup(registry);
		const groupEntries = groupedPaneEntries(registry).get(layoutGroup) ?? [];
		const splitHorizontally = groupEntries.length === 0;
		const splitTarget = splitHorizontally ? primaryPaneId : groupEntries[0].paneId;
		const splitPercent = splitHorizontally ? "50" : String(Math.max(10, Math.floor(100 / (groupEntries.length + 1))));
		const result = await tmux([
			"split-window",
			splitHorizontally ? "-h" : "-v",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-p",
			splitPercent,
			"-t",
			splitTarget,
			"-c",
			cwd,
			"bash",
			paths.launcherFile,
		]);
		if (result.code !== 0) throw new Error(`Failed to launch tmux pane for ${agent.name}: ${result.stderr || result.stdout}`.trim());
		const paneId = result.stdout.trim();
		await tmux(["select-pane", "-t", paneId, "-T", windowName]);
		await tmux(["set-window-option", "-t", paneId, "pane-border-status", "top"]);
		await tmux([
			"set-window-option",
			"-t",
			paneId,
			"pane-border-format",
			"#{?pane_active,#[bold],} #T #[default]",
		]);

		const created: PaneRegistryEntry = {
			agent: agent.name,
			paneId,
			windowName,
			cwd,
			sessionFile: paths.sessionFile,
			promptFile: paths.promptFile,
			launcherFile: paths.launcherFile,
			model: selectedModel,
			thinkingLevel: parentThinkingLevel,
			startedAt: new Date().toISOString(),
			launcherVersion: PANE_LAUNCHER_VERSION,
			layoutGroup,
			primaryPaneId,
		};
		registry[agent.name] = created;
		entry = created;
	});

	if (!entry) throw new Error(`ensurePersistentPane failed for ${agent.name}`);
	if (reusedExisting) return entry;

	const bridge = await discoverBridgeMetadataForPane(entry, 5000);
	if (bridge?.pid || bridge?.socket) {
		await updatePaneRegistry(runtimeRoot, (registry) => {
			const current = registry[agent.name];
			if (current && current.paneId === entry!.paneId) {
				if (bridge.pid) current.bridgePid = bridge.pid;
				if (bridge.socket) current.bridgeSocket = bridge.socket;
				entry = current;
			}
		});
	}

	if (layoutGroup !== undefined && primaryPaneId) {
		const snapshot = await readPaneRegistry(runtimeRoot);
		await rebalanceColumn([...(groupedPaneEntries(snapshot).get(layoutGroup) ?? [])]);
		await rebalanceColumns(snapshot, primaryPaneId);
	}
	return entry;
}

async function archiveCompletion(runtimeRoot: string, agentName: string, filePath: string): Promise<string> {
	const archiveDir = completionArchiveDir(runtimeRoot, agentName);
	await fs.promises.mkdir(archiveDir, { recursive: true, mode: 0o700 });
	const archivedPath = path.join(archiveDir, `${Date.now()}-${path.basename(filePath)}`);
	await fs.promises.rename(filePath, archivedPath);
	return archivedPath;
}

function paneCompletionDetailsFromCompletion(
	completion: PaneCompletion,
	agentDirName: string,
	filePath: string,
	archivePath: string | undefined,
	registry: PaneRegistry,
	tasks: PaneTaskRegistry,
): PaneCompletionDetails {
	const agent = completion.agent || agentDirName;
	const taskId = completion.taskId || path.basename(filePath, path.extname(filePath));
	const record = tasks[taskId];
	return {
		agent,
		taskId,
		status: normalizePaneTaskStatus(completion.status),
		summary: completion.summary || "No summary provided.",
		filesChanged: Array.isArray(completion.filesChanged) ? completion.filesChanged : [],
		validation: Array.isArray(completion.validation) ? completion.validation : [],
		notes: completion.notes,
		sourcePath: filePath,
		archivePath,
		transcriptPath: record?.transcriptPath ?? registry[agent]?.sessionFile,
		completedAt: new Date().toISOString(),
		paneId: record?.paneId ?? registry[agent]?.paneId,
	};
}

function formatCompletionDetails(detail: PaneCompletionDetails): string {
	const files = detail.filesChanged.length ? detail.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported";
	const validation = detail.validation.length ? detail.validation.map((item) => `- ${item}`).join("\n") : "None reported";
	return [
		`# Agent completion: ${detail.agent}`,
		`Task ID: ${detail.taskId}`,
		`Status: ${detail.status}`,
		`Source: ${detail.sourcePath}`,
		detail.archivePath ? `Archive: ${detail.archivePath}` : "",
		detail.transcriptPath ? `Transcript: ${detail.transcriptPath}` : "",
		"",
		"## Summary",
		detail.summary,
		"",
		"## Files Changed",
		files,
		"",
		"## Validation",
		validation,
		detail.notes ? `\n## Notes\n${detail.notes}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatCompletionGroup(completions: PaneCompletionDetails[]): string {
	if (completions.length === 1) return formatCompletionDetails(completions[0]);
	return [`# Agent completions (${completions.length})`, "", ...completions.map(formatCompletionDetails)].join("\n\n---\n\n");
}

async function pollPaneCompletions(runtimeRoot: string, pi: ExtensionAPI, triggerTurn = true): Promise<number> {
	const root = outboxRoot(runtimeRoot);
	let agentDirs: fs.Dirent[];
	try {
		agentDirs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}

	const registry = await readPaneRegistry(runtimeRoot);
	let tasks = await readTaskRegistry(runtimeRoot);
	const completions: PaneCompletionDetails[] = [];

	for (const agentDir of agentDirs) {
		if (!agentDir.isDirectory()) continue;
		const dir = path.join(root, agentDir.name);
		let files: string[];
		try {
			files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
		} catch {
			continue;
		}

		for (const file of files) {
			const filePath = path.join(dir, file);
			let parseFailure = false;
			try {
				const parsed = await readPaneCompletionFile(filePath);
				if (parsed.error) {
					parseFailure = true;
					throw parsed.error;
				}
				if (!parsed.completion) continue;
				const completion = parsed.completion;
				const agentName = completion.agent || agentDir.name;
				const archivePath = await archiveCompletion(runtimeRoot, agentName, filePath);
				const detail = paneCompletionDetailsFromCompletion(completion, agentDir.name, filePath, archivePath, registry, tasks);
				completions.push(detail);
				tasks = await updateTaskRegistry(runtimeRoot, (records) => {
					const existing = records[detail.taskId];
					records[detail.taskId] = {
						...existing,
						taskId: detail.taskId,
						agent: detail.agent,
						task: existing?.task ?? "",
						createdAt: existing?.createdAt ?? detail.completedAt,
						status: detail.status,
						paneId: detail.paneId,
						completionSourcePath: detail.sourcePath,
						completionArchivePath: detail.archivePath,
						transcriptPath: detail.transcriptPath,
						summary: detail.summary,
						filesChanged: detail.filesChanged,
						validation: detail.validation,
						notes: detail.notes,
						updatedAt: detail.completedAt,
						completedAt: detail.completedAt,
					};
				});
				emitSubagentEvent(pi, detail.status === "completed" ? "subagents:completed" : "subagents:failed", {
					mode: "pane",
					agent: detail.agent,
					paneId: detail.paneId,
					taskId: detail.taskId,
					status: detail.status,
					summary: detail.summary,
					runtimeRoot,
					transcriptPath: detail.transcriptPath,
					completionPath: detail.archivePath ?? detail.sourcePath,
				});
			} catch (error) {
				// Leave malformed or concurrently-written files in place for the agent/user to fix,
				// but surface stable parse failures in the task registry and dashboard.
				let oldEnough = true;
				try {
					const stat = await fs.promises.stat(filePath);
					oldEnough = Date.now() - stat.mtimeMs >= MALFORMED_COMPLETION_GRACE_MS;
				} catch {
					oldEnough = true;
				}
				if (!oldEnough) continue;
				const taskId = path.basename(filePath, path.extname(filePath));
				const diagnostic = parseFailure
					? completionParseErrorMessage(filePath, error)
					: `Unable to collect completion JSON at ${filePath}: ${stringifyError(error)}. The file was left in place for retry.`;
				const updated = await markTaskNeedsCompletion(runtimeRoot, agentDir.name, taskId, {
					diagnostic,
					outboxFile: filePath,
					transcriptPath: registry[agentDir.name]?.sessionFile,
				});
				if (updated) {
					tasks = { ...tasks, [taskId]: updated };
					emitSubagentEvent(pi, "subagents:needs_completion", {
						mode: "pane",
						agent: updated.agent,
						paneId: updated.paneId ?? registry[updated.agent]?.paneId,
						taskId,
						status: "needs_completion",
						summary: diagnostic,
						runtimeRoot,
						transcriptPath: updated.transcriptPath,
						completionPath: filePath,
					});
				}
			}
		}
	}

	if (completions.length > 0) {
		const content = formatCompletionGroup(completions);
		pi.sendMessage(
			{ customType: "subagent-completion", content, details: { completions } as PaneCompletionMessageDetails, display: true },
			triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
		);
	}
	return completions.length;
}

interface QueuedPaneTask {
	pane: PaneRegistryEntry;
	taskId: string;
	outboxFile: string;
	taskFile: string;
}

async function queuePersistentPaneTask(
	runtimeRoot: string,
	parentSessionId: string,
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	pi: ExtensionAPI,
	activeTools?: string[],
): Promise<QueuedPaneTask> {
	const effectiveCwd = cwd ?? defaultCwd;
	const existingRegistry = await readPaneRegistry(runtimeRoot);
	const existing = existingRegistry[agent.name];
	const hadLivePane = Boolean(existing && (await paneExists(existing.paneId)));
	const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, effectiveCwd, agent, parentModel, parentThinkingLevel, activeTools);
	if (!hadLivePane) {
		emitSubagentEvent(pi, "subagents:created", {
			mode: "pane",
			agent: agent.name,
			paneId: pane.paneId,
			runtimeRoot,
			transcriptPath: pane.sessionFile,
		});
	}

	const taskId = createTaskId(agent.name);
	const outboxFile = completionPath(runtimeRoot, agent.name, taskId);
	await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
	const delegation = buildDelegation(agent, task, outboxFile, taskId);
	const taskFile = path.join(inboxDir(runtimeRoot, agent.name), `${safeFileName(taskId)}.md`);
	await fs.promises.mkdir(path.dirname(taskFile), { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(taskFile, delegation, { encoding: "utf-8", mode: 0o600 });
	const now = new Date().toISOString();
	await updatePaneRegistry(runtimeRoot, (registry) => {
		if (registry[agent.name]) {
			registry[agent.name].lastTaskAt = now;
			registry[agent.name].lastTaskId = taskId;
		}
	});
	await upsertTaskRecord(runtimeRoot, {
		taskId,
		agent: agent.name,
		task,
		status: "queued",
		paneId: pane.paneId,
		inboxFile: taskFile,
		outboxFile,
		transcriptPath: pane.sessionFile,
		createdAt: now,
		updatedAt: now,
	});
	emitSubagentEvent(pi, "subagents:queued", {
		mode: "pane",
		agent: agent.name,
		taskId,
		task,
		status: "queued",
		paneId: pane.paneId,
		runtimeRoot,
		transcriptPath: pane.sessionFile,
		completionPath: outboxFile,
	});
	return { pane, taskId, outboxFile, taskFile };
}

async function stopPersistentPane(runtimeRoot: string, agentName: string): Promise<PaneRegistryEntry> {
	let stopped: PaneRegistryEntry | undefined;
	await updatePaneRegistry(runtimeRoot, async (registry) => {
		const entry = registry[agentName];
		if (!entry) throw new Error(`No pane registry entry for agent: ${agentName || "(missing)"}`);
		if (await paneExists(entry.paneId)) await tmux(["kill-pane", "-t", entry.paneId]);
		stopped = entry;
		delete registry[entry.agent];
	});
	if (!stopped) throw new Error(`No pane registry entry for agent: ${agentName || "(missing)"}`);
	const now = new Date().toISOString();
	await updateTaskRegistry(runtimeRoot, (records) => {
		for (const record of Object.values(records)) {
			if (record.agent !== stopped!.agent || isTerminalTaskStatus(record.status)) continue;
			record.status = "blocked";
			record.completedAt = record.completedAt ?? now;
			record.updatedAt = now;
			record.summary = record.summary ?? `Pane for ${stopped!.agent} was stopped before the task completed.`;
			record.diagnostics = appendUniqueDiagnostic(record.diagnostics, `Pane stopped at ${now}.`);
		}
	});
	return stopped;
}

async function resetPersistentPaneSession(runtimeRoot: string, agentName: string): Promise<string | undefined> {
	const sessionFile = path.join(runtimeRoot, "sessions", `${safeFileName(agentName)}.jsonl`);
	try {
		await fs.promises.access(sessionFile);
	} catch {
		return undefined;
	}
	const archiveDir = path.join(runtimeRoot, "sessions", "archived");
	await fs.promises.mkdir(archiveDir, { recursive: true, mode: 0o700 });
	const archived = path.join(archiveDir, `${safeFileName(agentName)}-${Date.now()}.jsonl`);
	await fs.promises.rename(sessionFile, archived);
	return archived;
}

async function runPersistentPaneAgent(
	defaultCwd: string,
	runtimeRoot: string,
	parentSessionId: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
	pi: ExtensionAPI,
	forceSpawn = false,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	if (forceSpawn) {
		const registry = await readPaneRegistry(runtimeRoot);
		const existing = registry[agent.name];
		if (existing && (await paneExists(existing.paneId))) {
			const stderr = [
				`Cannot forceSpawn ${agent.name}: a live pane already exists for this agent.`,
				"vstack does not support multiple live panes for the same agent. Either:",
				`  - Drop forceSpawn and the call will reuse the existing pane (queue this task into ${existing.windowName}), or`,
				`  - Use stop_subagent or /agents stop ${agent.name} first, then retry with forceSpawn for a fresh session.`,
			].join("\n");
			return {
				agent: agent.name,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr,
				stopReason: "error",
				errorMessage: stderr,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
		}
		await resetPersistentPaneSession(runtimeRoot, agent.name);
	}

	const queued = await queuePersistentPaneTask(runtimeRoot, parentSessionId, defaultCwd, agent, task, cwd, parentModel, parentThinkingLevel, pi, pi.getActiveTools());
	const text = `Queued task for ${agent.name}.`;
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as Message],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: queued.pane.model,
		taskId: queued.taskId,
		paneId: queued.pane.paneId,
		queuedTaskFile: queued.taskFile,
		queuedOutboxFile: queued.outboxFile,
		transcriptPath: queued.pane.sessionFile,
		step,
	};
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	runtimeRoot: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionKey?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Bg agents are resumable by default. A caller-provided sessionKey selects a
	// named lane; otherwise each agent uses its default lane. Route pi to a stable
	// session file under our runtime so the same key + agent across calls resumes
	// prior conversation context. Pi's SessionManager.open() handles 'create if
	// missing, continue if existing'.
	const args: string[] = ["--mode", "json", "-p"];
	const effectiveSessionKey = sessionKey?.trim() || "default";
	const sessionsDir = path.join(runtimeRoot, "sessions");
	await fs.promises.mkdir(sessionsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
	const resumedSessionPath = path.join(sessionsDir, `bg-${safeFileName(agent.name)}-${safeFileName(effectiveSessionKey)}.jsonl`);
	args.push("--session", resumedSessionPath);
	const selectedModel = selectedModelForAgent(agent, parentModel, defaultCwd);
	if (selectedModel) args.push("--model", selectedModel);
	if (parentThinkingLevel && parentThinkingLevel !== "off") args.push("--thinking", parentThinkingLevel);
	const selectedTools = selectedToolsForAgent(agent, defaultCwd, [], pi.getActiveTools());
	if (selectedTools && selectedTools.length > 0) args.push("--tools", selectedTools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const oneShotTaskId = createTaskId(agent.name);
	const transcriptPath = oneShotTranscriptPath(runtimeRoot, agent.name, oneShotTaskId);
	const transcriptWrites: Promise<unknown>[] = [];

	const appendTranscript = (record: Record<string, unknown>) => {
		transcriptWrites.push(
			fs.promises
				.appendFile(transcriptPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { encoding: "utf-8" })
				.catch(() => undefined),
		);
	};

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: selectedModel,
		taskId: oneShotTaskId,
		transcriptPath,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			const rawOutput = getFinalOutput(currentResult.messages);
			const displayText = rawOutput ? truncateForDetails(rawOutput, cwd ?? defaultCwd) : "(running...)";
			const partialResult: SingleResult = {
				...currentResult,
				messages: cloneMessagesForDetails(currentResult.messages, rawOutput ? displayText : undefined, cwd ?? defaultCwd),
			};
			onUpdate({
				content: [{ type: "text", text: displayText }],
				details: makeDetails([partialResult]),
			});
		}
	};

	try {
		await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(transcriptPath, "", { encoding: "utf-8", mode: 0o600 });
		emitSubagentEvent(pi, "subagents:started", {
			mode: "oneshot",
			agent: agent.name,
			taskId: oneShotTaskId,
			task,
			runtimeRoot,
			transcriptPath,
		});
		appendTranscript({ type: "start", agent: agent.name, taskId: oneShotTaskId, task, cwd: cwd ?? defaultCwd });

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
					appendTranscript({ stream: "stdout", raw: line, event });
				} catch {
					appendTranscript({ stream: "stdout", raw: line, parseError: true });
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end") {
					// Tool-result messages can contain large read/bash payloads. The parent result
					// only needs assistant text/tool-call summaries, so avoid retaining nested output.
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				const text = data.toString();
				currentResult.stderr += text;
				appendTranscript({ stream: "stderr", text });
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				appendTranscript({ type: "exit", code: code ?? 0 });
				Promise.allSettled(transcriptWrites).finally(() => resolve(code ?? 0));
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = stringifyError(error);
				appendTranscript({ type: "process_error", error: stringifyError(error) });
				Promise.allSettled(transcriptWrites).finally(() => resolve(1));
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Agent was aborted";
			emitSubagentEvent(pi, "subagents:failed", {
				mode: "oneshot",
				agent: agent.name,
				taskId: oneShotTaskId,
				task,
				status: "aborted",
				runtimeRoot,
				transcriptPath,
			});
			throw new Error("Agent was aborted");
		}
		const failed = exitCode !== 0 || currentResult.stopReason === "error" || currentResult.stopReason === "aborted";
		emitSubagentEvent(pi, failed ? "subagents:failed" : "subagents:completed", {
			mode: "oneshot",
			agent: agent.name,
			taskId: oneShotTaskId,
			task,
			status: failed ? "failed" : "completed",
			runtimeRoot,
			transcriptPath,
			usage: currentResult.usage,
			error: failed ? currentResult.errorMessage || currentResult.stderr || undefined : undefined,
		});
		return currentResult;
	} finally {
		await Promise.allSettled(transcriptWrites);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: "Optional lane id for resuming a bg (non-pane) agent across calls. Omit to use that agent's default resumable lane; same key + agent => same persisted pi session. Ignored for pane agents." })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: "Optional lane id for resuming a bg (non-pane) agent across calls. Omit to use that agent's default resumable lane; same key + agent => same persisted pi session. Ignored for pane agents." })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project" (.pi/agents plus .claude/agents compatibility). Use "both" to include user-level agents too.',
	default: "project",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	sessionKey: Type.Optional(
		Type.String({
			description:
				"For bg (non-pane) agents only, single mode. Optional lane id used as the resumed pi session file name; omit to use that agent's default resumable lane. Use a stable workflow-scoped id like 'review-issue-123' when you want separate memories. Ignored for pane agents (panes already persist via their own session file).",
		}),
	),
	forceSpawn: Type.Optional(
		Type.Boolean({
			description:
				"For pane-mode agents only. When true and a live pane exists, the call errors instead of reusing it. When no live pane exists, the previous session file is archived before launch so the next pane starts fresh. Omit/false resumes or reuses the existing pane session.",
			default: false,
		}),
	),
});

const GetSubagentResultParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "Persistent pane task ID to retrieve" })),
	agent: Type.Optional(Type.String({ description: "Persistent pane agent name; selects that agent's latest task when taskId is omitted" })),
	wait: Type.Optional(Type.Boolean({ description: "Poll for completion until timeout before returning", default: false })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time when wait=true", default: 30000 })),
	verbose: Type.Optional(Type.Boolean({ description: "Include registry and artifact paths", default: false })),
});

const SteerSubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Persistent pane agent name" })),
	taskId: Type.Optional(Type.String({ description: "Task ID whose agent should be steered" })),
	message: Type.String({ description: "Steering message to send" }),
	deliverAs: Type.Optional(StringEnum(["steer", "send", "follow-up"] as const, { description: "Bridge delivery mode", default: "steer" })),
});

const StopSubagentParams = Type.Object({
	agent: Type.String({ description: "Persistent pane agent name to stop" }),
});

const CompleteSubagentParams = Type.Object({
	status: StringEnum(["completed", "blocked", "failed"] as const, { description: "Final task status" }),
	summary: Type.String({ description: "1-3 sentence result summary" }),
	filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Changed files, or empty if none" })),
	validation: Type.Optional(Type.Array(Type.String(), { description: "Validation performed, or empty if none" })),
	notes: Type.Optional(Type.String({ description: "Optional concise notes" })),
});

function paneCompletionIcon(status: PaneTaskStatus, theme: Theme): string {
	if (status === "completed") return theme.fg("success", ICONS.check);
	if (status === "blocked") return theme.fg("error", ICONS.times);
	if (status === "failed") return theme.fg("error", ICONS.times);
	if (status === "needs_completion") return theme.fg("warning", ICONS.warning);
	if (status === "queued") return theme.fg("warning", ICONS.clock);
	return theme.fg("muted", ICONS.dotSmall);
}

function paneCompletionStatus(status: PaneTaskStatus, theme: Theme): string {
	if (status === "completed") return theme.fg("success", status);
	if (status === "needs_completion") return theme.fg("warning", "needs completion");
	if (status === "blocked") return theme.fg("warning", status);
	if (status === "failed") return theme.fg("error", status);
	return theme.fg("muted", status);
}

function paneCompletionTone(status: PaneTaskStatus): "success" | "warning" | "error" | "muted" {
	if (status === "completed") return "success";
	if (status === "blocked" || status === "queued" || status === "needs_completion") return "warning";
	if (status === "failed") return "error";
	return "muted";
}

function renderPaneCompletionMessage(message: { content: string; details?: unknown }, options: { expanded?: boolean } | undefined, theme: Theme) {
	const details = message.details as PaneCompletionMessageDetails | undefined;
	const completions = details?.completions ?? [];
	if (completions.length === 0) return wrappedText(message.content);
	const expanded = Boolean(options?.expanded);
	if (!expanded) {
		const lines: string[] = [];
		for (const detail of completions) {
			lines.push(agentStatusLine(theme, detail.agent, detail.status, paneCompletionTone(detail.status), theme.fg("dim", ` · ${shortTaskId(detail.taskId)} · ctrl+o`)));
			lines.push(`${subagentBranch(theme, "└")}${theme.fg("toolOutput", oneLinePreview(detail.summary, 120) || "No summary provided.")}`);
		}
		return framedMessage(lines.join("\n"), theme);
	}

	const container = new Container();
	container.addChild(wrappedText(theme.fg("toolTitle", theme.bold(`Agent completion${completions.length === 1 ? "" : "s"} (${completions.length})`))));
	for (const [index, detail] of completions.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		container.addChild(wrappedText(agentStatusLine(theme, detail.agent, detail.status, paneCompletionTone(detail.status), theme.fg("dim", ` · ${detail.taskId}`))));
		container.addChild(wrappedText(theme.fg("muted", "─── Summary ───")));
		container.addChild(wrappedText(detail.summary || "No summary provided."));
		container.addChild(wrappedText(theme.fg("muted", "─── Files Changed ───")));
		container.addChild(wrappedText(detail.filesChanged.length ? detail.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported"));
		container.addChild(wrappedText(theme.fg("muted", "─── Validation ───")));
		container.addChild(wrappedText(detail.validation.length ? detail.validation.map((item) => `- ${item}`).join("\n") : "None reported"));
		if (detail.notes) {
			container.addChild(wrappedText(theme.fg("muted", "─── Notes ───")));
			container.addChild(wrappedText(detail.notes));
		}
		container.addChild(wrappedText(theme.fg("muted", "─── Artifacts ───")));
		container.addChild(
			wrappedText(
				[
					`Source: ${compactPath(detail.sourcePath)}`,
					detail.archivePath ? `Archive: ${compactPath(detail.archivePath)}` : "",
					detail.transcriptPath ? `Transcript: ${compactPath(detail.transcriptPath)}` : "",
				]
					.filter(Boolean)
					.map((line) => theme.fg("dim", line))
					.join("\n"),
			),
		);
	}
	return framedComponent(container, theme);
}

function formatTaskRecordResult(record: PaneTaskRecord, verbose = false): string {
	const files = record.filesChanged?.length ? record.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported";
	const validation = record.validation?.length ? record.validation.map((item) => `- ${item}`).join("\n") : "None reported";
	const diagnostics = record.diagnostics?.length ? record.diagnostics.map((item) => `- ${item}`).join("\n") : "";
	const metaParts = [
		`Status: **${record.status}**`,
		record.completedAt ? `Completed: ${record.completedAt}` : record.updatedAt ? `Updated: ${record.updatedAt}` : `Created: ${record.createdAt}`,
	];
	const lines = [
		`## ${record.agent} · ${record.taskId}`,
		metaParts.join(" · "),
		"",
		"### Summary",
		record.summary || (record.status === "needs_completion" ? "Task turn ended without a valid completion record; see diagnostics." : "No summary yet."),
		"",
		"### Files Changed",
		files,
		"",
		"### Validation",
		validation,
		record.notes ? `\n### Notes\n${record.notes}` : "",
		diagnostics ? `\n### Diagnostics\n${diagnostics}` : "",
	];
	if (verbose) {
		lines.push("", "### Task", record.task || "(task text unavailable)");
		const artifactLines = [
			record.inboxFile ? `Inbox: ${record.inboxFile}` : "",
			record.processingFile ? `Processing: ${record.processingFile}` : "",
			record.doneFile ? `Done: ${record.doneFile}` : "",
			record.outboxFile ? `Expected outbox: ${record.outboxFile}` : "",
			record.completionArchivePath ? `Archive: ${record.completionArchivePath}` : record.completionSourcePath ? `Source: ${record.completionSourcePath}` : "",
			record.transcriptPath ? `Transcript: ${record.transcriptPath}` : "",
		].filter(Boolean);
		if (artifactLines.length > 0) lines.push("", "### Artifacts", ...artifactLines);
	} else {
		const artifactLines = [
			record.completionArchivePath ? `Archive: ${compactPath(record.completionArchivePath)}` : "",
			record.transcriptPath ? `Transcript: ${compactPath(record.transcriptPath)}` : "",
		].filter(Boolean);
		if (artifactLines.length > 0) lines.push("", ...artifactLines);
	}
	return lines.filter(Boolean).join("\n");
}

function recordTraceRef(record: PaneTaskRecord): string {
	return dashboardTraceRef({ agent: record.agent, kind: record.paneId ? "pane" : "oneshot", taskId: record.taskId, transcriptPath: record.transcriptPath });
}

function recordTimestamp(record: PaneTaskRecord): number {
	const value = Date.parse(record.completedAt ?? record.createdAt ?? "");
	return Number.isFinite(value) ? value : 0;
}

function resolveTraceRecord(records: PaneTaskRegistry, query: string): PaneTaskRecord | undefined {
	const needle = query.trim();
	if (!needle) return undefined;
	if (records[needle]) return records[needle];
	const normalized = needle.toLowerCase();
	const candidates = Object.values(records).filter((record) => {
		const ref = recordTraceRef(record).toLowerCase();
		return ref === normalized || ref.includes(normalized) || record.taskId.toLowerCase().includes(normalized) || record.agent.toLowerCase() === normalized;
	});
	return candidates.sort((a, b) => recordTimestamp(b) - recordTimestamp(a))[0];
}

async function readTextFileIfExists(filePath: string | undefined, maxBytes = 24_000): Promise<string> {
	if (!filePath) return "";
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		return content.length > maxBytes ? `${content.slice(Math.max(0, content.length - maxBytes))}\n\n[truncated: showing last ${formatSize(maxBytes)}]` : content;
	} catch {
		return "";
	}
}

async function formatTraceView(record: PaneTaskRecord, verbose = false): Promise<string> {
	const base = formatTaskRecordResult(record, true);
	const transcript = await readTextFileIfExists(record.transcriptPath, verbose ? 80_000 : 24_000);
	const completion = await readTextFileIfExists(record.completionArchivePath ?? record.completionSourcePath, 12_000);
	return [
		`# Trace ${recordTraceRef(record)}`,
		"",
		base,
		completion ? `\n## Completion JSON\n\`\`\`json\n${completion}\n\`\`\`` : "",
		transcript ? `\n## Transcript tail\n\`\`\`jsonl\n${transcript}\n\`\`\`` : "",
	].filter(Boolean).join("\n");
}

interface TraceViewerItem {
	agent?: string;
	createdAt?: string;
	summary?: string;
	label: string;
	path?: string;
	ref?: string;
	status?: string;
	text: string;
	type?: "index" | "summary" | "transcript" | "completion" | "task";
}

interface TraceViewerState {
	items: TraceViewerItem[];
	selected: number;
	scroll: number;
	title: string;
}

function traceViewerLines(state: TraceViewerState, width: number, rows: number, theme: Theme): string[] {
	const innerWidth = Math.max(1, width - 4);
	const frameRows = Math.max(8, rows);
	const item = state.items[state.selected] ?? state.items[0];
	const help = `${ansiYellow("tab/←→")} ${theme.fg("dim", "sections · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page")}`;
	const tabs = renderTraceTabBar(state.items, state.selected, innerWidth, theme);
	const meta = [
		item?.ref ? theme.fg("accent", item.ref) : "",
		item?.agent ? theme.fg("muted", item.agent) : "",
		item?.status ? theme.fg(item.status === "completed" ? "success" : item.status === "failed" ? "error" : "warning", item.status) : "",
		item?.createdAt ? theme.fg("dim", item.createdAt) : "",
	].filter(Boolean).join(theme.fg("dim", " · "));
	const file = item?.path ? theme.fg("dim", `file ${compactPath(item.path, { maxChars: Math.max(24, innerWidth - 8) })}`) : theme.fg("dim", "metadata view");
	const rawContent = (item?.text || "(empty)").split(/\r?\n/);
	const content = rawContent.map((line) => truncateToWidth(line, innerWidth, ""));
	const fixedRowsInsideFrame = 8;
	const bodyRows = Math.max(1, frameRows - 2 - fixedRowsInsideFrame);
	const maxScroll = Math.max(0, content.length - bodyRows);
	state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
	const visible = content.slice(state.scroll, state.scroll + bodyRows);
	const footer = item?.path
		? theme.fg("dim", `${state.scroll + 1}-${Math.min(content.length, state.scroll + bodyRows)}/${content.length} · file`)
		: theme.fg("dim", `${state.scroll + 1}-${Math.min(content.length, state.scroll + bodyRows)}/${content.length} · metadata`);
	const innerLines = [
		tabs,
		"",
		meta || file,
		meta ? file : "",
		divider(innerWidth, theme),
		...visible,
		divider(innerWidth, theme),
		footer,
		help,
	];
	while (innerLines.length < frameRows - 2) innerLines.splice(Math.max(0, innerLines.length - 2), 0, "");
	return simpleFrame(innerLines.slice(0, frameRows - 2), width, theme, state.title);
}

function renderTraceTabBar(items: TraceViewerItem[], selected: number, width: number, theme: Theme): string {
	const partFor = (item: TraceViewerItem, index: number): string => {
		const label = ` ${truncateToWidth(item.label, 18, "…")} `;
		return index === selected ? activePill(theme, label) : inactivePill(theme, label);
	};
	const renderWindow = (start: number, end: number): string => {
		const parts = items.slice(start, end).map((item, offset) => partFor(item, start + offset));
		if (start > 0) parts.unshift(theme.fg("dim", "‹"));
		if (end < items.length) parts.push(theme.fg("dim", "›"));
		return parts.join(" ");
	};
	let start = Math.max(0, selected);
	let end = Math.min(items.length, selected + 1);
	let current = renderWindow(start, end);
	let preferRight = true;
	while (start > 0 || end < items.length) {
		const addRight = end < items.length && (preferRight || start === 0);
		const addLeft = !addRight && start > 0;
		const nextStart = addLeft ? start - 1 : start;
		const nextEnd = addRight ? end + 1 : end;
		const candidate = renderWindow(nextStart, nextEnd);
		if (visibleWidth(candidate) > width) {
			if (addRight && start > 0) {
				preferRight = false;
				continue;
			}
			break;
		}
		start = nextStart;
		end = nextEnd;
		current = candidate;
		preferRight = !preferRight;
	}
	return truncateToWidth(current, width, "");
}

async function editAgentFrontmatterOverrides(ctx: ExtensionContext, agent: AgentConfig): Promise<string | undefined> {
	const edited = await ctx.ui.editor(`Edit ${agent.name} frontmatter — model/deny-tools/tools/color`, editableAgentFrontmatterText(agent));
	if (edited === undefined) return undefined;
	const parsed = parseEditableAgentFrontmatterText(edited);
	if (isVstackManagedAgentFile(agent)) {
		const tomlPath = vstackTomlPathForAgent(agent, ctx.cwd);
		if (!tomlPath) throw new Error(`Could not locate vstack.toml for vstack-managed agent ${agent.name}.`);
		await withFileMutationQueue(tomlPath, async () => {
			let current = "";
			try { current = await fs.promises.readFile(tomlPath, "utf-8"); } catch {}
			const next = upsertAgentFrontmatterToml(current, agent.name, parsed);
			await fs.promises.mkdir(path.dirname(tomlPath), { recursive: true });
			await fs.promises.writeFile(tomlPath, next, "utf-8");
		});
		const refresh = refreshVstackManagedAgent(agent, tomlPath);
		if (!refresh.ok) return `Updated ${agent.name} overrides in ${compactAgentPath(tomlPath)}. Refresh failed: ${refresh.message || "unknown error"}. Run vstack refresh --scope project to regenerate ${compactAgentPath(agent.filePath)}.`;
		return `Updated ${compactAgentPath(tomlPath)} and regenerated ${compactAgentPath(agent.filePath)}. Run /reload if Pi does not pick up the changed agent immediately.`;
	}
	await withFileMutationQueue(agent.filePath, async () => {
		const current = await fs.promises.readFile(agent.filePath, "utf-8");
		await fs.promises.writeFile(agent.filePath, updateAgentFileFrontmatter(current, parsed), "utf-8");
	});
	return `Updated ${agent.name} frontmatter in ${compactAgentPath(agent.filePath)}.`;
}

async function openTraceViewer(ctx: ExtensionContext, title: string, items: TraceViewerItem[]): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(title, "info");
		return;
	}
	const state: TraceViewerState = { items: items.length ? items : [{ label: "Empty", text: "No traces found." }], selected: 0, scroll: 0, title };
	await ctx.ui.custom<void>((tui, theme, _kb, done) => ({
		invalidate() {},
		handleInput(data: string) {
			const tracePageRows = Math.max(1, Math.min(30, Math.max(12, Math.floor(tui.terminal.rows * 0.72))) - 10);
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done();
			if (matchesKey(data, "up")) { state.scroll = Math.max(0, state.scroll - 1); tui.requestRender(); return; }
			if (matchesKey(data, "down")) { state.scroll += 1; tui.requestRender(); return; }
			if (matchesKey(data, "-") || matchesKey(data, "pageup" as any) || matchesKey(data, "page_up" as any)) { state.scroll = Math.max(0, state.scroll - tracePageRows); tui.requestRender(); return; }
			if (matchesKey(data, "=") || matchesKey(data, "pagedown" as any) || matchesKey(data, "page_down" as any)) { state.scroll += tracePageRows; tui.requestRender(); return; }
			if (matchesKey(data, "left")) { state.selected = (state.selected + state.items.length - 1) % state.items.length; state.scroll = 0; tui.requestRender(); return; }
			if (matchesKey(data, "right") || matchesKey(data, "tab")) { state.selected = (state.selected + 1) % state.items.length; state.scroll = 0; tui.requestRender(); return; }
		},
		render(width: number): string[] {
			const rows = Math.min(30, Math.max(12, Math.floor(tui.terminal.rows * 0.72)));
			const lines = traceViewerLines(state, width, rows, theme);
			return lines.slice(0, rows);
		},
	}), { overlay: true, overlayOptions: { anchor: "center", width: TRACE_VIEWER_WIDTH, maxHeight: TRACE_VIEWER_MAX_HEIGHT } });
}

function highlightAgentEditConfirmationPaths(message: string): string {
	return message.replace(/(~\/[^\s,]+|\/[^\s,]*\/[^\s,]+)/g, (match) => {
		const trailing = match.match(/[.;:!?]+$/)?.[0] ?? "";
		const filePath = trailing ? match.slice(0, -trailing.length) : match;
		return `${ansiGreen(filePath)}${trailing}`;
	});
}

async function showAgentEditConfirmation(ctx: ExtensionContext, message: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(message, "info");
		return;
	}
	const styledMessage = highlightAgentEditConfirmationPaths(message);
	await ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb, done) => ({
		invalidate() {},
		handleInput(data: string) {
			if (matchesKey(data, "return") || matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "backspace") || matchesKey(data, "ctrl+c")) done();
		},
		render(width: number): string[] {
			const frameWidth = Math.max(8, Math.min(width, AGENT_EDIT_CONFIRM_WIDTH));
			const innerWidth = Math.max(1, frameWidth - 4);
			const lines = [
				theme.fg("success", "Agent metadata updated"),
				"",
				...wrapTextWithAnsi(styledMessage, innerWidth),
				"",
				`${ansiYellow("enter")} ${theme.fg("dim", "return to agents")}`,
			];
			return simpleFrame(lines, frameWidth, theme, "Agents").slice(0, Math.max(8, Math.floor(tui.terminal.rows * 0.45)));
		},
	}), { overlay: true, overlayOptions: { anchor: "center", width: AGENT_EDIT_CONFIRM_WIDTH, maxHeight: "40%" } });
}

async function traceViewerItems(record: PaneTaskRecord): Promise<TraceViewerItem[]> {
	const ref = recordTraceRef(record);
	const metadata = [
		"Overview",
		"",
		`Ref      ${ref}`,
		`Agent    ${record.agent}`,
		`Status   ${record.status}`,
		`Task ID  ${record.taskId}`,
		`Created  ${record.createdAt}`,
		record.completedAt ? `Done     ${record.completedAt}` : "",
		"",
		"Summary",
		"-------",
		record.summary || "No summary yet.",
		"",
		"Files changed",
		"-------------",
		record.filesChanged?.length ? record.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported",
		"",
		"Validation",
		"----------",
		record.validation?.length ? record.validation.map((item) => `- ${item}`).join("\n") : "None reported",
		record.notes ? `\nNotes\n-----\n${record.notes}` : "",
	].filter(Boolean).join("\n");
	const transcript = await readTextFileIfExists(record.transcriptPath, 80_000);
	const completion = await readTextFileIfExists(record.completionArchivePath ?? record.completionSourcePath, 24_000);
	const common = { agent: record.agent, createdAt: record.completedAt ?? record.createdAt, ref, status: record.status, summary: record.summary || record.task };
	return [
		{ ...common, label: "Summary", text: metadata, type: "summary" },
		{ ...common, label: "Transcript", path: record.transcriptPath, text: transcript || "Transcript unavailable.", type: "transcript" },
		{ ...common, label: "Completion", path: record.completionArchivePath ?? record.completionSourcePath, text: completion || "Completion JSON unavailable.", type: "completion" },
		{ ...common, label: "Task", path: record.inboxFile, text: record.task || "Task unavailable.", type: "task" },
	];
}

interface GetSubagentResultDetails {
	agent?: string;
	paneId?: string;
	summary?: string;
	status?: PaneTaskStatus;
	taskId?: string;
	notes?: string;
	diagnostics?: string[];
}

interface SteerSubagentDetails {
	agent: string;
	bridge: boolean;
	bridgePid?: string;
	bridgeSocket?: string;
	deliverAs: string;
	fallbackFile?: string;
	paneId: string;
	runtimeRoot: string;
	sessionFile: string;
	taskId?: string;
}

function bridgeTargetArgs(metadata: BridgeMetadata): string[] {
	if (metadata.socket) return ["--socket", metadata.socket];
	if (metadata.pid) return ["--pid", metadata.pid];
	return [];
}

function renderToolTarget(value: string | undefined, theme: Theme, fallback = "target"): string {
	return theme.fg("accent", value && value.trim() ? value : fallback);
}

function getSubagentTargetLabel(args: { agent?: string; taskId?: string }): string {
	if (args.agent) return `${args.agent} result`;
	if (args.taskId) return `task ${oneLinePreview(args.taskId, 28)} result`;
	return "agent result";
}

function steerDiagnostics(details: SteerSubagentDetails): string[] {
	return [
		`Target agent: ${details.agent}`,
		details.taskId ? `Task ID: ${details.taskId}` : "Task ID: (not specified)",
		`Delivery: ${details.deliverAs}`,
		`Bridge: ${details.bridge ? "active" : "not used"}`,
		details.bridgePid ? `Bridge PID: ${details.bridgePid}` : "Bridge PID: (none)",
		details.bridgeSocket ? `Bridge socket: ${details.bridgeSocket}` : "Bridge socket: (none)",
		`Child session file: ${details.sessionFile}`,
		`Runtime root: ${details.runtimeRoot}`,
		details.fallbackFile ? `Inbox fallback: ${details.fallbackFile}` : "",
	].filter(Boolean);
}

async function queueSteeringFallback(runtimeRoot: string, agentName: string, message: string): Promise<string> {
	const steeringId = createTaskId(`${agentName}-steer`);
	const filePath = path.join(inboxDir(runtimeRoot, agentName), `${safeFileName(steeringId)}.md`);
	const content = formatSteeringForChild(agentName, message, false);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

function formatSteeringForChild(agentName: string, message: string, liveBridge: boolean): string {
	return [`Steering update for ${agentName}${liveBridge ? " (live bridge)" : " (queued fallback)"}:`, "", message.trim()].join("\n");
}

export default function (pi: ExtensionAPI) {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const childAgentName = process.env.PI_SUBAGENT_CHILD_AGENT;
	const statuslineBridge: SubagentStatuslineBridge = {
		getCurrentSubagent(cwd?: string) {
			return resolveSubagentStatuslineInfo(childAgentName, cwd);
		},
	};
	(globalThis as unknown as Record<PropertyKey, unknown>)[STATUSLINE_SYMBOL] = statuslineBridge;
	let pendingChildCompletion: { agent: string; taskId: string; status: string; outboxFile: string } | undefined;
	let completionPoller: ReturnType<typeof setInterval> | undefined;
	let completionPollInFlight = false;
	let childInboxPoller: ReturnType<typeof setInterval> | undefined;
	let childTitlePoller: ReturnType<typeof setInterval> | undefined;
	let childPollInFlight = false;
	let childCurrentTaskFile: string | undefined;
	let agentCommandCompletions: Array<{ value: string; label: string; description: string; pane: boolean }> = [];
	let dashboardState: SubagentDashboardState = { collapsed: false, mode: "normal", visible: true, items: {} };
	let dashboardCtx: ExtensionContext | undefined;

	const syncDashboard = (ctx = dashboardCtx) => {
		if (!ctx?.hasUI || childAgentName || !dashboardEnabled(ctx.cwd) || !dashboardState.visible) {
			ctx?.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			return;
		}
		dashboardCtx = ctx;
		const hasItems = Object.keys(dashboardState.items).length > 0;
		if (!hasItems) {
			ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return renderDashboardWidgetLines(dashboardState, theme, ctx.cwd, width);
			},
		}), { placement: "aboveEditor" });
	};

	// Caller is responsible for forcing dashboardState.visible = true when the
	// update represents a new lifecycle event the user should see (queued /
	// started / completed). Patches from the live transcript poller go through
	// the same helper and must NOT resurrect the widget the user just hid.
	const dashboardItemKey = (item: Pick<SubagentDashboardItem, "agent" | "kind" | "taskId">) => (item.kind === "pane" ? `pane:${item.agent}` : item.taskId);
	const dashboardKeyForTask = (taskId: string | undefined): string | undefined => {
		if (!taskId) return undefined;
		if (dashboardState.items[taskId]) return taskId;
		return Object.entries(dashboardState.items).find(([, item]) => item.taskId === taskId)?.[0];
	};

	const updateDashboard = (item: SubagentDashboardItem) => {
		const key = dashboardItemKey(item);
		if (item.kind === "pane") {
			for (const [existingKey, existing] of Object.entries(dashboardState.items)) {
				if (existingKey !== key && existing.kind === "pane" && existing.agent === item.agent) delete dashboardState.items[existingKey];
			}
		}
		dashboardState.items[key] = item;
		const maxKeep = Math.max(10, dashboardMaxItems(dashboardCtx?.cwd) * 3);
		const sorted = Object.values(dashboardState.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		dashboardState.items = Object.fromEntries(sorted.slice(0, maxKeep).map((entry) => [dashboardItemKey(entry), entry]));
		syncDashboard();
	};

	const patchDashboard = (taskId: string | undefined, patch: Partial<SubagentDashboardItem>) => {
		const key = dashboardKeyForTask(taskId);
		if (!key) return;
		const existing = dashboardState.items[key];
		if (!existing) return;
		updateDashboard({ ...existing, ...patch, updatedAt: new Date().toISOString() });
	};

	const removeDashboardAgent = (agentName: string | undefined) => {
		if (!agentName) return;
		for (const [key, item] of Object.entries(dashboardState.items)) {
			if (item.agent === agentName) delete dashboardState.items[key];
		}
		syncDashboard();
	};

	const updateDashboardFromTaskRecord = (record: PaneTaskRecord) => {
		const kind: DashboardKind = record.paneId ? "pane" : "oneshot";
		const existingKey = dashboardKeyForTask(record.taskId) ?? (kind === "pane" ? `pane:${record.agent}` : undefined);
		const existing = existingKey ? dashboardState.items[existingKey] : undefined;
		updateDashboard({
			agent: record.agent,
			artifacts: Boolean(record.completionArchivePath || record.outboxFile || record.transcriptPath || record.processingFile || record.doneFile),
			bridge: existing?.bridge,
			completedAt: record.completedAt,
			kind,
			message: record.summary || record.diagnostics?.at(-1) || record.task,
			model: existing?.model,
			paneId: record.paneId,
			startedAt: record.createdAt,
			status: dashboardStatusFor(record.status, kind),
			task: record.task,
			taskId: record.taskId,
			transcriptPath: record.transcriptPath ?? existing?.transcriptPath,
			updatedAt: record.updatedAt ?? record.completedAt ?? record.createdAt,
			usage: existing?.usage,
		});
	};

	const syncDashboardFromTaskRegistry = async (runtimeRoot: string) => {
		const records = await readTaskRegistry(runtimeRoot);
		const registry = await readPaneRegistry(runtimeRoot);
		const sorted = Object.values(records).sort((a, b) => (a.updatedAt ?? a.completedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.completedAt ?? b.createdAt));
		for (const record of sorted) {
			if (!record.taskId || !record.agent) continue;
			if (record.paneId && isTerminalTaskStatus(record.status) && !registry[record.agent]) continue;
			const refreshed = await refreshTaskDiagnostics(runtimeRoot, record);
			if (refreshed.record.status === "needs_completion") dashboardState.visible = true;
			updateDashboardFromTaskRecord(refreshed.record);
		}
	};

	const refreshAgentCommandCompletions = (ctx: ExtensionContext) => {
		try {
			agentCommandCompletions = discoverAgents(ctx.cwd, "both").agents.map((agent) => ({
				value: agent.name,
				label: agent.name,
				description: `${agent.source}${agent.pane ? " · pane" : ""}${agent.description ? ` · ${agent.description}` : ""}`,
				pane: agent.pane === true,
			}));
		} catch {
			agentCommandCompletions = [];
		}
	};

	const agentsArgumentCompletions = (prefix: string) => {
		const raw = prefix.trimStart();
		const parts = raw.split(/\s+/).filter(Boolean);
		const first = parts[0]?.toLowerCase() ?? "";
		if (parts.length === 0 || (parts.length <= 1 && !raw.endsWith(" "))) {
			const topLevel = [
				{ value: "show ", label: "show <name>", description: "Inspect an agent" },
				{ value: "start ", label: "start <name>", description: "Start or reuse a persistent pane" },
				{ value: "new ", label: "new <name>", description: "Start a persistent pane with a fresh session" },
				{ value: "send ", label: "send <name> <task>", description: "Queue a task for a persistent pane" },
				{ value: "attach ", label: "attach <name>", description: "Focus an existing agent pane" },
				{ value: "stop ", label: "stop <name>", description: "Stop an agent pane" },
				{ value: "status", label: "status", description: "Show persistent pane status" },
				{ value: "trace ", label: "trace <task-id>", description: "Open a past task in the trace viewer" },
				{ value: "toggle", label: "toggle", description: "Toggle the agent dashboard" },
			];
			const filtered = topLevel.filter((item) => item.value.trim().startsWith(first) || item.label.startsWith(first));
			return filtered.length > 0 ? filtered : null;
		}
		if (first === "trace") {
			const rest = parts[1]?.toLowerCase() ?? "";
			const records = Object.values(dashboardState.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			const completions = records
				.filter((item) => !rest || item.taskId.toLowerCase().includes(rest) || item.agent.toLowerCase().includes(rest))
				.slice(0, 20)
				.map((item) => {
					const when = formatRelativeTime(item.completedAt ?? item.startedAt ?? item.updatedAt);
					const summary = oneLinePreview(item.message, 60);
					return {
						value: `trace ${item.taskId}`,
						label: `${item.agent} · ${when}`,
						description: summary ? `${item.status} · ${summary}` : item.status,
					};
				});
			return completions.length > 0 ? completions : null;
		}
		if (["show", "start", "new", "send", "attach", "stop"].includes(first)) {
			if (first === "show" && parts.length === 1 && raw.endsWith(" ")) return null;
			if (parts.length > 2 || (parts.length === 2 && raw.endsWith(" "))) return null;
			const rest = parts[1]?.toLowerCase() ?? "";
			const needsPane = first !== "show";
			const suffix = first === "send" ? " " : "";
			const filtered = agentCommandCompletions
				.filter((agent) => (!needsPane || agent.pane) && (!rest || agent.value.toLowerCase().startsWith(rest)))
				.slice(0, 20)
				.map((agent) => ({ value: `${first} ${agent.value}${suffix}`, label: agent.label, description: agent.description }));
			return filtered.length > 0 ? filtered : null;
		}
		return null;
	};

	pi.registerMessageRenderer("subagent-agents", (message, options, theme) => {
		return renderAgentsCommandMessage(message as { content: string; details?: unknown }, options, theme);
	});

	pi.registerMessageRenderer("subagent-trace", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return framedComponent(new Markdown(content, 0, 0, getMarkdownTheme()), theme);
	});

	pi.registerMessageRenderer("subagent-completion", (message, options, theme) => {
		const quiet = quietInline(dashboardCtx?.cwd) && dashboardEnabled(dashboardCtx?.cwd);
		if (quiet && !options?.expanded) {
			const details = message.details as PaneCompletionMessageDetails | undefined;
			const completions = details?.completions ?? [];
			if (completions.length === 1) {
				const detail = completions[0]!;
				return framedMessage(agentStatusLine(theme, detail.agent, detail.status, paneCompletionTone(detail.status)), theme);
			}
			if (completions.length > 1) return framedMessage(`${theme.fg("success", ICONS.check)} ${theme.fg("toolTitle", theme.bold(`${completions.length} agents completed`))}`, theme);
		}
		return renderPaneCompletionMessage(message as { content: string; details?: unknown }, options as { expanded?: boolean } | undefined, theme);
	});

	pi.events.on("subagents:queued", (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as Record<string, unknown>;
		const taskId = typeof event.taskId === "string" ? event.taskId : undefined;
		const agent = typeof event.agent === "string" ? event.agent : undefined;
		if (!taskId || !agent) return;
		dashboardState.visible = true;
		updateDashboard({
			agent,
			artifacts: true,
			kind: event.mode === "oneshot" ? "oneshot" : "pane",
			message: typeof event.task === "string" ? event.task : undefined,
			paneId: typeof event.paneId === "string" ? event.paneId : undefined,
			status: "queued",
			startedAt: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
			task: typeof event.task === "string" ? event.task : undefined,
			taskId,
			transcriptPath: typeof event.transcriptPath === "string" ? event.transcriptPath : undefined,
			updatedAt: new Date().toISOString(),
		});
	});

	pi.events.on("subagents:started", (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as Record<string, unknown>;
		const taskId = typeof event.taskId === "string" ? event.taskId : undefined;
		const agent = typeof event.agent === "string" ? event.agent : undefined;
		if (!taskId || !agent) return;
		dashboardState.visible = true;
		updateDashboard({
			agent,
			kind: event.mode === "pane" ? "pane" : "oneshot",
			message: typeof event.task === "string" ? event.task : undefined,
			paneId: typeof event.paneId === "string" ? event.paneId : undefined,
			status: "running",
			startedAt: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
			task: typeof event.task === "string" ? event.task : undefined,
			taskId,
			transcriptPath: typeof event.transcriptPath === "string" ? event.transcriptPath : undefined,
			updatedAt: new Date().toISOString(),
		});
	});

	const completeDashboardFromEvent = (payload: unknown, status: PaneTaskStatus) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as Record<string, unknown>;
		const taskId = typeof event.taskId === "string" ? event.taskId : undefined;
		const agent = typeof event.agent === "string" ? event.agent : undefined;
		if (!taskId || !agent) return;
		dashboardState.visible = true;
		const existingKey = dashboardKeyForTask(taskId);
		const paneKey = `pane:${agent}`;
		const currentPane = dashboardState.items[paneKey];
		// Pane rows are keyed by agent so they don't duplicate for each task. If a
		// completion arrives for an older task after a newer task has already been
		// queued, do not resurrect the stale task into the dashboard.
		if (!existingKey && currentPane?.kind === "pane" && currentPane.taskId !== taskId) return;
		const existing = existingKey ? dashboardState.items[existingKey] : currentPane?.taskId === taskId ? currentPane : undefined;
		const transcriptPath = typeof event.transcriptPath === "string" ? event.transcriptPath : existing?.transcriptPath;
		const eventUsage = (event.usage as UsageStats | undefined) ?? undefined;
		const eventModel = typeof event.model === "string" ? event.model : undefined;
		const kind = existing?.kind ?? (event.mode === "oneshot" ? "oneshot" : "pane");
		const payloadStatus = normalizePaneTaskStatus(event.status);
		const eventStatus = payloadStatus === "unknown" ? status : payloadStatus;
		const effectiveStatus = dashboardStatusFor(eventStatus, kind);
		updateDashboard({
			agent,
			artifacts: true,
			bridge: existing?.bridge,
			completedAt: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
			kind,
			message: typeof event.summary === "string" ? event.summary : existing?.message,
			paneId: existing?.paneId ?? (typeof event.paneId === "string" ? event.paneId : undefined),
			startedAt: existing?.startedAt,
			status: effectiveStatus,
			task: existing?.task ?? (typeof event.task === "string" ? event.task : undefined),
			taskId,
			transcriptPath,
			updatedAt: new Date().toISOString(),
			usage: eventUsage ?? existing?.usage,
			model: eventModel ?? existing?.model,
		});
		// Always parse the transcript when one exists. The event payload usage
		// can be all zeros for models that don't report token counts on the
		// stream, and pane events never carry usage at all. The transcript jsonl
		// is authoritative either way - patch the dashboard once it resolves.
		if (transcriptPath) {
			parseTranscriptUsage(transcriptPath)
				.then((parsed) => {
					if (!parsed) return;
					patchDashboard(taskId, { usage: parsed.usage, model: parsed.model });
				})
				.catch(() => undefined);
		}
	};

	pi.events.on("subagents:completed", (payload: unknown) => completeDashboardFromEvent(payload, "completed"));
	pi.events.on("subagents:failed", (payload: unknown) => completeDashboardFromEvent(payload, "failed"));
	pi.events.on("subagents:needs_completion", (payload: unknown) => completeDashboardFromEvent(payload, "needs_completion"));

	pi.events.on("subagents:steered", (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as Record<string, unknown>;
		patchDashboard(typeof event.taskId === "string" ? event.taskId : undefined, {
			bridge: Boolean(event.bridge),
			paneId: typeof event.paneId === "string" ? event.paneId : undefined,
		});
	});

	pi.registerTool({
		renderShell: "self",
		name: "complete_subagent",
		label: "Complete Agent Task",
		description: "Child-pane-only helper that writes the persistent agent completion record without exposing outbox JSON mechanics in the visible pane.",
		parameters: CompleteSubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!childAgentName) return { content: [{ type: "text", text: "complete_subagent is only available inside a persistent agent pane." }], details: {}, isError: true };
			if (!childCurrentTaskFile) return { content: [{ type: "text", text: "No active agent task file is being processed." }], details: {}, isError: true };
			const taskId = path.basename(childCurrentTaskFile, path.extname(childCurrentTaskFile));
			const runtimeRoot = runtimeDirForContext(ctx);
			const outboxFile = completionPath(runtimeRoot, childAgentName, taskId);
			const completion = {
				agent: childAgentName,
				taskId,
				status: params.status,
				summary: params.summary,
				filesChanged: params.filesChanged ?? [],
				validation: params.validation ?? [],
				...(params.notes ? { notes: params.notes } : {}),
			};
			await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
			await fs.promises.writeFile(outboxFile, JSON.stringify(completion, null, 2), { encoding: "utf-8", mode: 0o600 });
			pendingChildCompletion = { agent: childAgentName, taskId, status: params.status, outboxFile };
			return {
				content: [{ type: "text", text: `Completed ${childAgentName} task ${taskId} (${params.status}).` }],
				details: { agent: childAgentName, taskId, status: params.status, outboxFile },
			};
		},
		renderCall(_args, _theme, _context) {
			return new Container();
		},
		renderResult(_result, _options, _theme, _context) {
			// Silent: completion line is emitted post-turn from the agent_end hook so
			// it appears after the agent's final message instead of mid-stream.
			return new Container();
		},
	});

	pi.registerMessageRenderer("subagent-self-completion", (message, options, theme) => {
		const details = message.details as { agent?: string; status?: string; outboxFile?: string } | undefined;
		const agent = details?.agent ?? "unknown";
		const statusWord = details?.status === "failed" ? "failed" : details?.status === "blocked" ? "blocked" : "completed";
		const tone = details?.status === "failed" || details?.status === "blocked" ? "error" : "success";
		const tail = statusWord === "completed" ? theme.fg("muted", " · now waiting") : "";
		const headline = agentStatusLine(theme, agent, statusWord, tone, tail);
		if (options?.expanded && details?.outboxFile) {
			return framedMessage(`${headline}\n${theme.fg("dim", `Outbox: ${compactPath(details.outboxFile)}`)}`, theme);
		}
		return framedMessage(headline, theme);
	});

	pi.registerMessageRenderer("subagent-missing-completion", (message, options, theme) => {
		const details = message.details as { agent?: string; taskId?: string; outboxFile?: string; processingFile?: string } | undefined;
		const agent = details?.agent ?? "unknown";
		const task = details?.taskId ? ` · ${shortTaskId(details.taskId)}` : "";
		const headline = agentStatusLine(theme, agent, "needs completion", "warning", theme.fg("dim", task));
		if (options?.expanded) {
			const content = typeof message.content === "string" ? message.content : "Call complete_subagent to finish this task.";
			const artifacts = [
				details?.outboxFile ? `Expected outbox: ${compactPath(details.outboxFile)}` : "",
				details?.processingFile ? `Processing task: ${compactPath(details.processingFile)}` : "",
			]
				.filter(Boolean)
				.map((line) => theme.fg("dim", line))
				.join("\n");
			return framedMessage(`${headline}\n${theme.fg("toolOutput", content)}${artifacts ? `\n${artifacts}` : ""}`, theme);
		}
		return framedMessage(`${headline}\n${subagentBranch(theme, "└")}${theme.fg("toolOutput", "Call complete_subagent; task kept active.")}`, theme);
	});

	pi.on("session_start", async (_event, ctx) => {
		dashboardCtx = ctx;
		dashboardState = { collapsed: dashboardDefaultCollapsed(ctx.cwd), mode: dashboardDefaultCollapsed(ctx.cwd) ? "compact" : "normal", visible: true, items: {} };
		refreshAgentCommandCompletions(ctx);
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		if (childTitlePoller) clearInterval(childTitlePoller);

		const runtimeRoot = runtimeDirForContext(ctx);

		if (childAgentName) {
			ctx.ui.setTitle(`pi agent - ${childAgentName}`);
			setCurrentTmuxPaneTitle(`agent:${childAgentName}`);
			childTitlePoller = setInterval(() => setCurrentTmuxPaneTitle(`agent:${childAgentName}`), 1000);
			childTitlePoller.unref?.();
			ctx.ui.setStatus("agent", `${childAgentName} idle`);
			if (ctx.hasUI) ctx.ui.setWidget("subagent-marker", undefined);
			const pollInbox = () => {
				if (childPollInFlight || childCurrentTaskFile || !ctx.isIdle()) return;
				childPollInFlight = true;
				(async () => {
					const inbox = inboxDir(runtimeRoot, childAgentName);
					let files: string[];
					try {
						files = (await fs.promises.readdir(inbox)).filter((file) => file.endsWith(".md")).sort();
					} catch {
						return;
					}
					const file = files[0];
					if (!file) return;

					const source = path.join(inbox, file);
					const processing = path.join(processingDir(runtimeRoot, childAgentName), file);
					await fs.promises.mkdir(path.dirname(processing), { recursive: true, mode: 0o700 });
					try {
						await fs.promises.rename(source, processing);
					} catch {
						return;
					}

					const prompt = await fs.promises.readFile(processing, "utf-8");
					childCurrentTaskFile = processing;
					const taskId = path.basename(processing, path.extname(processing));
					const now = new Date().toISOString();
					await updateTaskRegistry(runtimeRoot, (records) => {
						const existing = records[taskId];
						records[taskId] = {
							...existing,
							taskId,
							agent: existing?.agent ?? childAgentName,
							task: existing?.task ?? "",
							status: "running",
							inboxFile: existing?.inboxFile ?? source,
							processingFile: processing,
							outboxFile: existing?.outboxFile ?? completionPath(runtimeRoot, childAgentName, taskId),
							transcriptPath: existing?.transcriptPath ?? ctx.sessionManager.getSessionFile() ?? undefined,
							createdAt: existing?.createdAt ?? now,
							updatedAt: now,
						};
					});
					emitSubagentEvent(pi, "subagents:started", {
						mode: "pane",
						agent: childAgentName,
						taskId,
						status: "running",
						runtimeRoot,
						transcriptPath: ctx.sessionManager.getSessionFile() ?? undefined,
						completionPath: completionPath(runtimeRoot, childAgentName, taskId),
					});
					ctx.ui.setStatus("agent", `${childAgentName} running ${file}`);
					pi.sendUserMessage(prompt);
				})().finally(() => {
					childPollInFlight = false;
				});
			};
			pollInbox();
			childInboxPoller = setInterval(pollInbox, Math.max(500, Math.floor(settingNumber("childInboxPollMs", 1000, ctx.cwd))));
			return;
		}

		ctx.ui.setStatus("agent", undefined);
		await migrateLegacyProjectRuntime(ctx.cwd, runtimeRoot);
		try {
			const records = await readTaskRegistry(runtimeRoot);
			const sortedRecords = Object.values(records).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
			for (const record of sortedRecords) {
				if (!record.taskId || !record.agent) continue;
				const refreshed = await refreshTaskDiagnostics(runtimeRoot, record);
				updateDashboardFromTaskRecord(refreshed.record);
				if (refreshed.record.transcriptPath && (refreshed.record.status === "completed" || refreshed.record.status === "failed" || refreshed.record.status === "blocked")) {
					const capturedTaskId = refreshed.record.taskId;
					parseTranscriptUsage(refreshed.record.transcriptPath)
						.then((parsed) => {
							if (parsed) patchDashboard(capturedTaskId, { usage: parsed.usage, model: parsed.model });
						})
						.catch(() => undefined);
				}
			}
		} catch {
			// Dashboard is best-effort; registry lookup may fail before first pane task.
		}
		syncDashboard(ctx);
		if (!ctx.hasUI) return;
		const refreshLiveUsage = async () => {
			// Re-parse transcripts for any pane subagent that is still alive (waiting
			// or actively working / queued). Token + cost counts grow as the agent
			// streams, so the dashboard needs a periodic refresh, not just one-shot
			// parse on completion.
			const snapshot = Object.values(dashboardState.items).filter((item) => {
				if (item.kind !== "pane") return false;
				if (item.status === "failed" || item.status === "blocked") return false;
				if (!item.transcriptPath) return false;
				return true;
			});
			for (const item of snapshot) {
				const parsed = await parseTranscriptUsage(item.transcriptPath).catch(() => undefined);
				if (!parsed) continue;
				patchDashboard(item.taskId, { usage: parsed.usage, model: parsed.model });
			}
		};
		const poll = () => {
			if (completionPollInFlight) return;
			completionPollInFlight = true;
			pollPaneCompletions(runtimeRoot, pi)
				.then(async () => {
					await syncDashboardFromTaskRegistry(runtimeRoot);
					await refreshLiveUsage();
				})
				.finally(() => {
					completionPollInFlight = false;
				});
		};
		poll();
		completionPoller = setInterval(poll, Math.max(500, Math.floor(settingNumber("completionPollMs", 2000, ctx.cwd))));
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!childAgentName) return;
		if (childCurrentTaskFile) {
			const runtimeRoot = runtimeDirForContext(ctx);
			const activeTaskFile = childCurrentTaskFile;
			const taskId = path.basename(activeTaskFile, path.extname(activeTaskFile));
			const outboxFile = completionPath(runtimeRoot, childAgentName, taskId);
			const pendingMatches = pendingChildCompletion?.taskId === taskId;
			let manualCompletionOk = false;
			let missingDiagnostic = `Task turn ended but ${childAgentName} did not call complete_subagent. Expected completion outbox: ${outboxFile}`;
			if (!pendingMatches) {
				const parsed = await readPaneCompletionFile(outboxFile);
				if (parsed.completion) manualCompletionOk = true;
				else if (parsed.exists && parsed.error) missingDiagnostic = completionParseErrorMessage(outboxFile, parsed.error);
			}

			if (!pendingMatches && !manualCompletionOk) {
				await markTaskNeedsCompletion(runtimeRoot, childAgentName, taskId, {
					diagnostic: missingDiagnostic,
					outboxFile,
					processingFile: activeTaskFile,
					transcriptPath: ctx.sessionManager.getSessionFile() ?? undefined,
				});
				ctx.ui.setStatus("agent", `${childAgentName} needs completion ${shortTaskId(taskId, 18)}`);
				pi.sendMessage({
					customType: "subagent-missing-completion",
					content: missingDiagnostic,
					details: { agent: childAgentName, taskId, outboxFile, processingFile: activeTaskFile },
					display: true,
				});
				return;
			}

			const doneFile = path.join(doneDir(runtimeRoot, childAgentName), path.basename(activeTaskFile));
			try {
				await fs.promises.mkdir(path.dirname(doneFile), { recursive: true, mode: 0o700 });
				await fs.promises.rename(activeTaskFile, doneFile);
				await updateTaskRegistry(runtimeRoot, (records) => {
					const existing = records[taskId];
					if (!existing) return;
					records[taskId] = {
						...existing,
						doneFile,
						processingFile: existing.processingFile ?? activeTaskFile,
						outboxFile: existing.outboxFile ?? outboxFile,
						updatedAt: new Date().toISOString(),
					};
				});
			} catch (error) {
				// Keep the processing file as evidence if archival fails.
				await updateTaskRegistry(runtimeRoot, (records) => {
					const existing = records[taskId];
					if (!existing) return;
					records[taskId] = {
						...existing,
						processingFile: existing.processingFile ?? activeTaskFile,
						outboxFile: existing.outboxFile ?? outboxFile,
						transcriptPath: existing.transcriptPath ?? ctx.sessionManager.getSessionFile() ?? undefined,
						updatedAt: new Date().toISOString(),
						diagnostics: appendUniqueDiagnostic(existing.diagnostics, `Task completion was recorded, but processing-file archival failed for ${activeTaskFile}: ${stringifyError(error)}`),
					};
				});
			}
			childCurrentTaskFile = undefined;
		}
		ctx.ui.setStatus("agent", `${childAgentName} idle`);
		if (pendingChildCompletion) {
			const details = pendingChildCompletion;
			pendingChildCompletion = undefined;
			pi.sendMessage({ customType: "subagent-self-completion", content: "", details, display: true });
		}
	});

	pi.on("session_shutdown", () => {
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		dashboardCtx?.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
		completionPoller = undefined;
		childInboxPoller = undefined;
		dashboardCtx = undefined;
	});

	const agentsHandler = async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const scopes = new Set<AgentScope>(["user", "project", "both"]);
			const command = parts[0];
			let scope: AgentScope = "project";
			let content = "";
			let messageDetails: AgentsCommandMessageDetails | undefined;

			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();
			const parentSessionId = runtimeSessionId(ctx);
			const runtimeRoot = sessionRuntimeDir(parentSessionId);
			const discovery = discoverAgents(ctx.cwd, scopes.has(parts.at(-1) as AgentScope) ? (parts.at(-1) as AgentScope) : scope);
			const findAgent = (name: string | undefined) => discovery.agents.find((candidate) => candidate.name === name);
			const sendMarkdown = (markdown: string) => {
				pi.sendMessage({ customType: "subagent-trace", content: markdown, display: true });
			};

			try {
				if (command === "start" || command === "new") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const beforeRegistry = await readPaneRegistry(runtimeRoot);
					const before = beforeRegistry[agent.name];
					const hadLivePane = Boolean(before && (await paneExists(before.paneId)));
					if (command === "new") {
						if (hadLivePane) await stopPersistentPane(runtimeRoot, agent.name);
						removeDashboardAgent(agent.name);
						await resetPersistentPaneSession(runtimeRoot, agent.name);
					}
					const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, ctx.cwd, agent, parentModel, parentThinkingLevel, pi.getActiveTools());
					if (!hadLivePane || command === "new") {
						emitSubagentEvent(pi, "subagents:created", {
							mode: "pane",
							agent: agent.name,
							paneId: pane.paneId,
							runtimeRoot,
							transcriptPath: pane.sessionFile,
						});
					}
					content = `${command === "new" ? "Started new" : "Started/reused"} ${agent.name} (${pane.windowName}).\nSession: ${pane.sessionFile}`;
					messageDetails = { action: "start", agent: agent.name, sessionFile: pane.sessionFile, windowName: pane.windowName };
				} else if (command === "send") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const task = parts.slice(2).join(" ").trim();
					if (!task) throw new Error("Usage: /agents:send <name> <task>");
					const queued = await queuePersistentPaneTask(runtimeRoot, parentSessionId, ctx.cwd, agent, task, undefined, parentModel, parentThinkingLevel, pi, pi.getActiveTools());
					content = `Queued task for ${agent.name}.\nArtifacts: inbox=${compactPath(queued.taskFile)} completion=${compactPath(queued.outboxFile)} transcript=${compactPath(queued.pane.sessionFile)}`;
					messageDetails = { action: "send", agent: agent.name, inboxFile: queued.taskFile, outboxFile: queued.outboxFile, taskId: queued.taskId, transcriptPath: queued.pane.sessionFile };
				} else if (command === "attach") {
					const registry = await readPaneRegistry(runtimeRoot);
					const entry = registry[parts[1] ?? ""];
					if (!entry || !(await paneExists(entry.paneId))) throw new Error(`No live pane for agent: ${parts[1] ?? "(missing)"}`);
					const result = await tmux(["select-pane", "-t", entry.paneId]);
					if (result.code !== 0) throw new Error(result.stderr || result.stdout || "tmux select-pane failed");
					content = `Attached to ${entry.agent}.`;
					messageDetails = { action: "attach", agent: entry.agent };
				} else if (command === "stop") {
					const stopped = await stopPersistentPane(runtimeRoot, parts[1] ?? "");
					const stoppedAgent = stopped.agent;
					removeDashboardAgent(stoppedAgent);
					content = `Stopped ${stoppedAgent}.`;
					messageDetails = { action: "stop", agent: stoppedAgent };
				} else if (command === "collect") {
					const collected = await pollPaneCompletions(runtimeRoot, pi, false);
					content = `Collected ${collected} agent completion file${collected === 1 ? "" : "s"}.`;
					messageDetails = { action: "collect", count: collected };
				} else if (command === "status") {
					const registry = await readPaneRegistry(runtimeRoot);
					const lines = await Promise.all(
						Object.values(registry).map(async (entry) => {
							const live = await paneExists(entry.paneId);
							return `- ${entry.agent}: ${live ? "live" : "dead"} ${entry.windowName} model=${entry.model ?? "default"} lastTask=${entry.lastTaskAt ?? "never"}`;
						}),
					);
					content = [`# Persistent agent panes`, "", lines.join("\n") || "No persistent panes registered."].join("\n");
					messageDetails = { action: "status", count: lines.length };
				} else if (command === "trace") {
					const ref = parts.slice(1).join(" ").trim();
					if (!ref) throw new Error("Usage: /agents:trace <ref>");
					const records = await readTaskRegistry(runtimeRoot);
					const record = resolveTraceRecord(records, ref);
					if (!record) throw new Error(`No agent trace matched: ${ref}`);
					if (ctx.hasUI) {
						await openTraceViewer(ctx as ExtensionContext, `Trace ${recordTraceRef(record)}`, await traceViewerItems(record));
						return;
					}
					sendMarkdown(await formatTraceView(record, parts.includes("--verbose")));
					return;
				} else if (command === "toggle") {
					dashboardState.visible = !dashboardState.visible;
					syncDashboard(ctx as ExtensionContext);
					content = `Agent dashboard ${dashboardState.visible ? `shown (${dashboardState.mode})` : "hidden"}.`;
					messageDetails = { action: "toggle", status: dashboardState.visible ? `shown (${dashboardState.mode})` : "hidden" };
				} else {
					let showName: string | undefined;
					if (command === "show") {
						showName = parts[1];
						if (scopes.has(parts[2] as AgentScope)) scope = parts[2] as AgentScope;
					} else if (scopes.has(command as AgentScope)) {
						scope = command as AgentScope;
					} else if (command) {
						throw new Error(`Unknown /agents action: ${command}`);
					}

					if (ctx.hasUI) {
						await openAgentsBrowser(ctx, scope, showName, runtimeRoot, parentSessionId, parentModel, parentThinkingLevel, pi.getActiveTools(), () => activeDashboardItems(Object.values(dashboardState.items)), removeDashboardAgent);
						return;
					}

					const scopedDiscovery = discoverAgents(ctx.cwd, scope);
					if (showName) {
						const agent = scopedDiscovery.agents.find((candidate) => candidate.name === showName);
						content = agent
							? [
									`# Agent: ${agent.name}`,
									`Source: ${agent.source}`,
									`Path: ${agent.filePath}`,
									`Model: ${agent.model ?? "default"}`,
									`Tools: ${agent.tools?.join(", ") ?? "default"}`,
									...(agent.denyTools && agent.denyTools.length > 0 ? [`Deny tools: ${agent.denyTools.join(", ")}`] : []),
									`Persistent pane: ${agent.pane ? "yes" : "no"}`,
									"",
									agent.description,
									"",
									"---",
									"",
									agent.systemPrompt.trim(),
								]
								.join("\n")
							: `Unknown agent "${showName}" for scope "${scope}". Available: ${scopedDiscovery.agents
									.map((agent) => agent.name)
									.join(", ") || "none"}.`;
						messageDetails = { action: "show", agent: showName };
					} else {
						const formatted = formatAgentList(scopedDiscovery.agents);
						content = [
							`# Available agents (${scope})`,
							`Project agent dirs: ${scopedDiscovery.projectAgentsDir ?? "none"}`,
							"",
							formatted.text
								.split("; ")
								.map((line) => {
									const name = line.match(/^-?\s*([^ ]+)/)?.[1];
									const agent = scopedDiscovery.agents.find((candidate) => candidate.name === name);
									return `- ${line}${agent?.pane ? " [pane]" : ""}`;
								})
								.join("\n"),
							"",
							"Commands: `/agents show <name>`, `/agents:start <name>` (resume/reuse), `/agents:new <name>` (fresh session), `/agents:send <name> <task>`, `/agents:attach <name>`, `/agents:stop <name>`, `/agents status`, `/agents:trace <ref>`, `/agents:toggle`. The popup's History tab browses past tasks visually.",
						].join("\n");
						messageDetails = { action: "list", count: scopedDiscovery.agents.length };
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				content = `Error: ${message}`;
				messageDetails = { action: "error", error: message };
			}

			pi.sendMessage({ customType: "subagent-agents", content, details: messageDetails, display: true });
	};

	pi.registerCommand("agents", {
		description: "Agent browser and persistent pane manager.",
		getArgumentCompletions: agentsArgumentCompletions,
		handler: agentsHandler,
	});

	const paneAgentNameCompletions = (subcommand: string) => (prefix: string) => {
		const query = prefix.trimStart().toLowerCase();
		const needsPane = subcommand !== "show";
		const items = agentCommandCompletions
			.filter((agent) => (!needsPane || agent.pane) && (!query || agent.value.toLowerCase().startsWith(query)))
			.slice(0, 20)
			.map((agent) => ({ value: agent.value, label: agent.label, description: agent.description }));
		return items.length > 0 ? items : null;
	};

	const traceRefCompletions = (prefix: string) => {
		const query = prefix.trimStart().toLowerCase();
		const records = Object.values(dashboardState.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const completions = records
			.filter((item) => !query || item.taskId.toLowerCase().includes(query) || item.agent.toLowerCase().includes(query))
			.slice(0, 20)
			.map((item) => {
				const when = formatRelativeTime(item.completedAt ?? item.startedAt ?? item.updatedAt);
				const summary = oneLinePreview(item.message, 60);
				return {
					value: item.taskId,
					label: `${item.agent} · ${when}`,
					description: summary ? `${item.status} · ${summary}` : item.status,
				};
			});
		return completions.length > 0 ? completions : null;
	};

	pi.registerCommand("agents:toggle", {
		description: "Toggle the agent dashboard",
		handler: async (_args, ctx) => agentsHandler("toggle", ctx),
	});

	for (const sub of ["start", "new", "send", "attach", "stop"] as const) {
		const description =
			sub === "start" ? "Start or reuse a persistent pane: /agents:start <name>" :
			sub === "new" ? "Start a persistent pane with a fresh session: /agents:new <name>" :
			sub === "send" ? "Queue a task for a persistent pane: /agents:send <name> <task>" :
			sub === "attach" ? "Focus an existing agent pane: /agents:attach <name>" :
			"Stop an agent pane: /agents:stop <name>";
		pi.registerCommand(`agents:${sub}`, {
			description,
			getArgumentCompletions: paneAgentNameCompletions(sub),
			handler: async (args, ctx) => agentsHandler(`${sub} ${args}`.trim(), ctx),
		});
	}

	pi.registerCommand("agents:trace", {
		description: "View an agent trace by ref/task id: /agents:trace <ref>",
		getArgumentCompletions: traceRefCompletions,
		handler: async (args, ctx) => agentsHandler(`trace ${args}`.trim(), ctx),
	});

	const toggleDashboardMode = async (ctx: ExtensionContext) => {
		dashboardCtx = ctx;
		if (!dashboardState.visible) {
			dashboardState.visible = true;
			dashboardState.mode = "compact";
		} else if (dashboardState.mode === "compact") {
			dashboardState.mode = "normal";
		} else if (dashboardState.mode === "normal") {
			dashboardState.mode = "expanded";
		} else {
			dashboardState.visible = false;
		}
		dashboardState.collapsed = false;
		syncDashboard(ctx);
	};
	const shortcut = dashboardShortcut();
	if (shortcut !== "none") {
		pi.registerShortcut(shortcut as any, { description: "Cycle agent dashboard display", handler: async (ctx) => toggleDashboardMode(ctx as ExtensionContext) });
	}
	const openAgentsPopup = async (ctx: ExtensionContext) => {
		dashboardCtx = ctx;
		if (!ctx.hasUI) return;
		const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const parentThinkingLevel = pi.getThinkingLevel();
		const parentSessionId = runtimeSessionId(ctx);
		const runtimeRoot = sessionRuntimeDir(parentSessionId);
		await openAgentsBrowser(ctx, "project", undefined, runtimeRoot, parentSessionId, parentModel, parentThinkingLevel, pi.getActiveTools(), () => activeDashboardItems(Object.values(dashboardState.items)), removeDashboardAgent);
	};
	const popup = popupShortcut();
	if (popup !== "none") {
		pi.registerShortcut(popup as any, {
			description: "Open the /agents browser popup",
			handler: async (ctx) => openAgentsPopup(ctx as ExtensionContext),
		});
	}
	if (popup.toLowerCase() !== "f3") {
		pi.registerShortcut("f3" as any, {
			description: "Open the /agents browser popup",
			handler: async (ctx) => openAgentsPopup(ctx as ExtensionContext),
		});
	}

	pi.registerTool({
		renderShell: "self",
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Retrieve status/results for persistent pane agent tasks by taskId or latest agent task. This is a recovery/status tool for pane tasks and does not change Flightdeck or Orchestration ownership.",
		parameters: GetSubagentResultParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.taskId && !params.agent) {
				return {
					content: [{ type: "text", text: "Provide either taskId or agent." }],
					details: {} satisfies GetSubagentResultDetails,
					isError: true,
				};
			}
			const runtimeRoot = sessionRuntimeDir(runtimeSessionId(ctx));
			const deadline = Date.now() + Math.max(0, Math.floor(params.timeoutMs ?? 30000));
			let record: PaneTaskRecord | undefined;
			let diagnostics: string[] = [];
			do {
				await pollPaneCompletions(runtimeRoot, pi, false);
				const records = await readTaskRegistry(runtimeRoot);
				record = params.taskId ? records[params.taskId] : latestTaskRecord(records, params.agent);
				if (record) {
					const refreshed = await refreshTaskDiagnostics(runtimeRoot, record);
					record = refreshed.record;
					diagnostics = refreshed.diagnostics;
				}
				if (!params.wait || (record && (isTerminalTaskStatus(record.status) || record.status === "needs_completion"))) break;
				if (Date.now() >= deadline) break;
				await delay(500);
			} while (true);

			if (!record) {
				const selector = params.taskId ? `taskId ${params.taskId}` : `agent ${params.agent}`;
				return { content: [{ type: "text", text: `No persistent agent task record found for ${selector}.` }], details: { agent: params.agent, taskId: params.taskId } satisfies GetSubagentResultDetails, isError: true };
			}
			updateDashboardFromTaskRecord({ ...record, updatedAt: new Date().toISOString() });
			const diagnosticBlock = params.verbose && diagnostics.length > 0 ? `\n\n### Artifact diagnostics\n${diagnostics.map((line) => `- ${line}`).join("\n")}` : "";
			return {
				content: [{ type: "text", text: `${formatTaskRecordResult(record, params.verbose ?? false)}${diagnosticBlock}` }],
				details: { agent: record.agent, paneId: record.paneId, summary: record.summary, status: record.status, taskId: record.taskId, notes: record.notes, diagnostics: record.diagnostics } satisfies GetSubagentResultDetails,
			};
		},
		renderCall(_args, _theme, _context) {
			return new Container();
		},
		renderResult(result, _options, theme, context) {
			const raw = (result.content as any[] | undefined)?.find?.((part: any) => part?.type === "text" && typeof part.text === "string")?.text ?? "";
			const details = result.details as GetSubagentResultDetails | undefined;
			if (context?.isError) return wrappedText(`${theme.fg("error", ICONS.times)} ${theme.fg("toolTitle", "Agent result lookup failed")}\n${theme.fg("muted", raw)}`);
			const target = details?.agent ? details.agent : "unknown";
			const tone = details?.status === "completed" ? "success" : details?.status === "failed" ? "error" : "warning";
			// One-liner only, expanded or not. The full task record is reachable
			// via `/agents trace <ref>` and is also surfaced as the agent-
			// completion message - rendering it again here just duplicates output.
			return wrappedText(agentStatusLine(theme, target, details?.status ?? "result", tone));
		},
	});

	pi.registerTool({
		renderShell: "self",
		name: "steer_subagent",
		label: "Steer Agent",
		description: "Send a steering message to a persistent pane agent via pi-session-bridge. Bridge targeting requires the agent's child session to live under this parent session's runtime; otherwise an inbox-file fallback is queued instead.",
		parameters: SteerSubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtimeRoot = sessionRuntimeDir(runtimeSessionId(ctx));
			const records = await readTaskRegistry(runtimeRoot);
			let agentName = params.agent;
			let record: PaneTaskRecord | undefined;
			if (params.taskId) {
				record = records[params.taskId];
				if (!record && !agentName) return { content: [{ type: "text", text: `No task record found for ${params.taskId}; provide agent to steer directly.` }], details: {}, isError: true };
				agentName = agentName ?? record?.agent;
			}
			if (!agentName) return { content: [{ type: "text", text: "Provide either agent or taskId." }], details: {}, isError: true };
			if (params.taskId && record) {
				const steerKind: DashboardKind = record.paneId ? "pane" : "oneshot";
				updateDashboard({
					agent: record.agent,
					artifacts: Boolean(record.completionArchivePath || record.outboxFile || record.transcriptPath),
					completedAt: record.completedAt,
					kind: steerKind,
					message: record.summary || record.task,
					paneId: record.paneId,
					startedAt: record.createdAt,
					status: dashboardStatusFor(record.status, steerKind),
					task: record.task,
					taskId: record.taskId,
					transcriptPath: record.transcriptPath,
					updatedAt: new Date().toISOString(),
				});
			}

			const registry = await readPaneRegistry(runtimeRoot);
			const entry = registry[agentName];
			if (!entry) return { content: [{ type: "text", text: `No persistent pane registry entry for ${agentName} in runtime ${runtimeRoot}.` }], details: {}, isError: true };
			if (!paneSessionBelongsToRuntime(runtimeRoot, entry)) return { content: [{ type: "text", text: `Refusing to steer ${agentName}: pane session file is outside this runtime. Session: ${entry.sessionFile}. Runtime: ${runtimeRoot}` }], details: {}, isError: true };
			if (!(await paneExists(entry.paneId))) return { content: [{ type: "text", text: `Agent ${agentName} is not live.` }], details: {}, isError: true };

			const deliverAs = params.deliverAs ?? "steer";
			const metadata = await ensurePaneBridgeMetadata(runtimeRoot, entry);
			const bridgeBin = metadata ? await resolvePiBridgeBin() : undefined;
			const targetArgs = metadata ? bridgeTargetArgs(metadata) : [];
			const baseDetails = {
				agent: agentName,
				bridge: Boolean(bridgeBin && targetArgs.length > 0),
				bridgePid: metadata?.pid,
				bridgeSocket: metadata?.socket,
				deliverAs,
				paneId: entry.paneId,
				runtimeRoot,
				sessionFile: entry.sessionFile,
				taskId: params.taskId ?? record?.taskId,
			} satisfies SteerSubagentDetails;

			if (bridgeBin && targetArgs.length > 0) {
				const command = deliverAs === "follow-up" ? "follow-up" : deliverAs === "send" ? "send" : "steer";
				const args = [command, ...targetArgs];
				if (command === "send") args.push("--auto");
				args.push(formatSteeringForChild(agentName, params.message, true));
				const result = await execCapture(bridgeBin, args, { cwd: entry.cwd });
				if (result.code === 0) {
					patchDashboard(params.taskId ?? record?.taskId, { bridge: true, paneId: entry.paneId });
					emitSubagentEvent(pi, "subagents:steered", {
						mode: "pane",
						agent: agentName,
						taskId: params.taskId ?? record?.taskId,
						paneId: entry.paneId,
						bridge: true,
						bridgePid: metadata?.pid,
						bridgeSocket: metadata?.socket,
						deliverAs,
						runtimeRoot,
						transcriptPath: entry.sessionFile,
					});
					return {
						content: [{ type: "text", text: [`Steered ${agentName} via bridge (${deliverAs}).`, ...steerDiagnostics(baseDetails)].join("\n") }],
						details: baseDetails,
					};
				}
				const fallbackFile = await queueSteeringFallback(runtimeRoot, agentName, params.message);
				const details = { ...baseDetails, bridge: false, fallbackFile } satisfies SteerSubagentDetails;
				patchDashboard(params.taskId ?? record?.taskId, { bridge: false, paneId: entry.paneId });
				emitSubagentEvent(pi, "subagents:steered", {
					mode: "pane",
					agent: agentName,
					taskId: params.taskId ?? record?.taskId,
					paneId: entry.paneId,
					bridge: false,
					deliverAs,
					runtimeRoot,
					transcriptPath: entry.sessionFile,
				});
				return {
					content: [{ type: "text", text: [`Bridge for ${agentName} found, but pi-bridge ${command} failed (exit ${result.code}); queued inbox fallback instead.`, result.stderr || result.stdout ? `Bridge output: ${(result.stderr || result.stdout).trim()}` : "", ...steerDiagnostics(details)].filter(Boolean).join("\n") }],
					details,
				};
			}

			const fallbackFile = await queueSteeringFallback(runtimeRoot, agentName, params.message);
			const details = { ...baseDetails, bridge: false, fallbackFile } satisfies SteerSubagentDetails;
			patchDashboard(params.taskId ?? record?.taskId, { bridge: false, paneId: entry.paneId });
			emitSubagentEvent(pi, "subagents:steered", {
				mode: "pane",
				agent: agentName,
				taskId: params.taskId ?? record?.taskId,
				paneId: entry.paneId,
				bridge: false,
				deliverAs,
				runtimeRoot,
				transcriptPath: entry.sessionFile,
			});
			return {
				content: [
					{
						type: "text",
						text: [`No live bridge for ${agentName}; no bridge message was sent. Queued inbox fallback instead, which is not true mid-run steering and will be read when the pane is idle.`, ...steerDiagnostics(details)].join("\n"),
					},
				],
				details,
			};
		},
		renderCall(_args, _theme, _context) {
			return new Container();
		},
		renderResult(result, { expanded }, theme, context) {
			const raw = (result.content as any[] | undefined)?.find?.((part: any) => part?.type === "text" && typeof part.text === "string")?.text ?? "";
			const details = result.details as SteerSubagentDetails | undefined;
			if (context?.isError) return wrappedText(`${theme.fg("error", ICONS.times)} ${theme.fg("toolTitle", "Steer agent failed")}\n${theme.fg("muted", raw)}`);
			if (!details) return wrappedText(raw);
			if (expanded) return wrappedText(raw);
			const status = details.bridge ? "steered" : "queued steering";
			const via = details.bridge ? theme.fg("success", "bridge") : theme.fg("warning", "inbox fallback");
			return wrappedText(`${agentStatusLine(theme, details.agent, status, details.bridge ? "success" : "warning")} ${theme.fg("dim", "via")} ${via}`);
		},
	});

	pi.registerTool({
		renderShell: "self",
		name: "stop_subagent",
		label: "Stop Agent",
		description: "Stop a persistent pane agent, kill its tmux pane, remove it from the live pane registry/dashboard, and mark any non-terminal active task as blocked.",
		parameters: StopSubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtimeRoot = sessionRuntimeDir(runtimeSessionId(ctx));
			const stopped = await stopPersistentPane(runtimeRoot, params.agent);
			removeDashboardAgent(stopped.agent);
			return {
				content: [{ type: "text", text: `Stopped ${stopped.agent}. Pane ${stopped.paneId} was killed and removed from the active registry.` }],
				details: { agent: stopped.agent, paneId: stopped.paneId, sessionFile: stopped.sessionFile },
			};
		},
		renderCall(_args, _theme, _context) {
			return new Container();
		},
		renderResult(result, _options, theme, context) {
			const raw = (result.content as any[] | undefined)?.find?.((part: any) => part?.type === "text" && typeof part.text === "string")?.text ?? "";
			const details = result.details as { agent?: string } | undefined;
			if (context?.isError) return wrappedText(`${theme.fg("error", ICONS.times)} ${theme.fg("toolTitle", "Stop agent failed")}\n${theme.fg("muted", raw)}`);
			return wrappedText(agentStatusLine(theme, details?.agent ?? "agent", "stopped", "success"));
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;

		const discovery = discoverAgents(ctx.cwd, "project");
		if (discovery.agents.length === 0) return;

		const agentLines = discovery.agents
			.map((agent) => {
				const model = agent.model ? ` model=${agent.model}` : "";
				const tools = agent.tools ? ` tools=${agent.tools.join(",")}` : "";
				const denyTools = agent.denyTools && agent.denyTools.length > 0 ? ` deny-tools=${agent.denyTools.join(",")}` : "";
				const pane = agent.pane ? " pane=true" : "";
				return `- ${agent.name}: ${agent.description} (${agent.source}${model}${tools}${denyTools}${pane})`;
			})
			.join("\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Agents\nUse the \`subagent\` tool when isolated context, specialist review, reconnaissance, planning, or parallel read-only investigation would help. Project-local agents are loaded from .pi/agents, with .claude/agents as a compatibility source. Agents with \`pane=true\` run in persistent tmux panes and can also be managed with \`/agents start|new|send|attach|stop|status\`. For persistent panes, save the returned taskId, use \`get_subagent_result\` to recover missed completions, use \`steer_subagent\` only for mid-run correction, and use \`stop_subagent\` to kill/close a pane. Available project agents:\n${agentLines}\n\nDefault \`agentScope\` is \"project\". Use \"both\" only when user-level agents are explicitly needed.`,
		};
	});

	pi.registerTool({
		renderShell: "self",
		name: "subagent",
		label: "Agent",
		description: [
			"Delegate tasks to specialized agents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Results are truncated by default to ${DEFAULT_RESULT_MAX_LINES} lines or ${formatSize(DEFAULT_RESULT_MAX_BYTES)}; full oversized output is saved under the session runtime when enabled.`,
			'Default agent scope is "project" (.pi/agents plus .claude/agents compatibility).',
			'Use agentScope: "both" to include user-level agents from ~/.pi/agent/agents.',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? false;
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();
			const parentSessionId = runtimeSessionId(ctx);
			const runtimeRoot = sessionRuntimeDir(parentSessionId);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult].map((result) => {
										const rawOutput = getFinalOutput(result.messages);
										return {
											...result,
											messages: cloneMessagesForDetails(
												result.messages,
												rawOutput ? truncateForDetails(rawOutput, ctx.cwd) : undefined,
												ctx.cwd,
											),
										};
									});
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const stepAgent = agents.find((agent) => agent.name === step.agent);
					const result = stepAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								runtimeRoot,
								parentSessionId,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
								pi,
								params.forceSpawn ?? false,
							)
						: await runSingleAgent(
								ctx.cwd,
								runtimeRoot,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
								pi,
								signal,
								chainUpdate,
								makeDetails("chain"),
								step.sessionKey,
							);
					results.push(result);
					if (!stepAgent?.pane) {
						updateDashboard({
							agent: result.agent,
							kind: "oneshot",
							message: oneLinePreview(getFinalOutput(result.messages), 120) || result.task,
							status: result.exitCode === 0 ? "completed" : "failed",
							task: result.task,
							taskId: result.taskId ?? `${result.agent}-step-${i + 1}`,
							transcriptPath: result.transcriptPath,
							updatedAt: new Date().toISOString(),
						});
					}

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						const preparedResults = await Promise.all(
							results.map((candidate, index) =>
								prepareSingleResultForReturn(
									candidate,
									runtimeRoot,
									ctx.cwd,
									`chain-step-${candidate.step ?? index + 1}`,
									candidate === result ? errorMsg : undefined,
								),
							),
						);
						const failed = preparedResults[preparedResults.length - 1];
						failed.result.errorMessage = failed.text || errorMsg;
						const details = makeDetails("chain")(preparedResults.map((prepared) => prepared.result));
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${failed.text || "(no output)"}` },
							],
							details: detailsWithTruncation(details, failed),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const preparedResults = await Promise.all(
					results.map((result, index) =>
						prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, `chain-step-${result.step ?? index + 1}`),
					),
				);
				const last = preparedResults[preparedResults.length - 1];
				const details = makeDetails("chain")(preparedResults.map((prepared) => prepared.result));
				return {
					content: [{ type: "text", text: last.text || "(no output)" }],
					details: detailsWithTruncation(details, last),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				const maxParallelTasks = Math.max(1, Math.floor(settingNumber("maxParallelTasks", MAX_PARALLEL_TASKS, ctx.cwd)));
				if (params.tasks.length > maxParallelTasks)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						const updateResults = allResults.map((result) => {
							const rawOutput = getFinalOutput(result.messages);
							return {
								...result,
								messages: cloneMessagesForDetails(
									result.messages,
									rawOutput ? truncateForDetails(rawOutput, ctx.cwd) : undefined,
									ctx.cwd,
								),
							};
						});
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")(updateResults),
						});
					}
				};

				const maxConcurrency = Math.max(1, Math.floor(settingNumber("maxConcurrency", MAX_CONCURRENCY, ctx.cwd)));
				const results = await mapWithConcurrencyLimit(params.tasks, maxConcurrency, async (t: { agent: string; task: string; cwd?: string; sessionKey?: string }, index) => {
					const updateOneshotDashboard = (item: SingleResult) => {
						updateDashboard({
							agent: item.agent,
							kind: "oneshot",
							message: oneLinePreview(getFinalOutput(item.messages), 120) || item.task,
							status: item.exitCode === -1 ? "running" : item.exitCode === 0 ? "completed" : "failed",
							task: item.task,
							taskId: item.taskId ?? `${item.agent}-${index}`,
							transcriptPath: item.transcriptPath,
							updatedAt: new Date().toISOString(),
						});
					};
					const taskAgent = agents.find((agent) => agent.name === t.agent);
					const result = taskAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								runtimeRoot,
								parentSessionId,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
								pi,
								params.forceSpawn ?? false,
							)
						: await runSingleAgent(
								ctx.cwd,
								runtimeRoot,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
								pi,
								signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										updateOneshotDashboard(partial.details.results[0]);
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								t.sessionKey,
							);
					allResults[index] = result;
					if (!taskAgent?.pane) updateOneshotDashboard(result);
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const perResultLimits = splitResultLimits(resultLimits(ctx.cwd), results.length);
				const preparedResults = await Promise.all(
					results.map((result, index) =>
						prepareSingleResultForReturn(
							result,
							runtimeRoot,
							ctx.cwd,
							`parallel-${index + 1}-${result.agent}`,
							undefined,
							perResultLimits,
						),
					),
				);
				const sections = preparedResults.map((prepared) => {
					const r = prepared.result;
					const status = r.exitCode === 0 ? "completed" : r.exitCode === -1 ? "running" : "failed";
					return `## ${r.agent} (${status})\n${prepared.text || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${sections.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(preparedResults.map((prepared) => prepared.result)),
				};
			}

			if (params.agent && params.task) {
				const agent = agents.find((candidate) => candidate.name === params.agent);
				const result = agent?.pane
					? await runPersistentPaneAgent(
							ctx.cwd,
							runtimeRoot,
							parentSessionId,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
							pi,
							params.forceSpawn ?? false,
						)
					: await runSingleAgent(
							ctx.cwd,
							runtimeRoot,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
							pi,
							signal,
							onUpdate,
							makeDetails("single"),
							params.sessionKey,
						);
				if (!agent?.pane) {
					updateDashboard({
						agent: result.agent,
						kind: "oneshot",
						message: oneLinePreview(getFinalOutput(result.messages), 120) || result.task,
						status: result.exitCode === 0 ? "completed" : "failed",
						task: result.task,
						taskId: result.taskId ?? result.agent,
						transcriptPath: result.transcriptPath,
						updatedAt: new Date().toISOString(),
					});
				}
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					const prepared = await prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, "single-error", errorMsg);
					prepared.result.errorMessage = prepared.text || errorMsg;
					const details = makeDetails("single")([prepared.result]);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${prepared.text || "(no output)"}` }],
						details: detailsWithTruncation(details, prepared),
						isError: true,
					};
				}
				const prepared = await prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, "single");
				const details = makeDetails("single")([prepared.result]);
				return {
					content: [{ type: "text", text: prepared.text || "(no output)" }],
					details: detailsWithTruncation(details, prepared),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "project";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("agents ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return wrappedText(text);
			}
			if (args.tasks && args.tasks.length > 0) {
				// Suppressed: renderResult renders the tree once results land, so the
				// renderCall preview would just stack a duplicate header above it.
				return new Container();
			}
			const agentName = args.agent || "...";
			const preview = args.task ? oneLinePreview(args.task, 56) : "...";
			let text = `${agentsCommandBullet(theme)}${agentWord(theme)} ${ansiMagenta(theme.bold(agentName))}`;
			if (scope !== "project") text += theme.fg("dim", ` · ${scope}`);
			text += `\n${subagentBranch(theme, "└", _context?.cwd)}${theme.fg("dim", preview)}`;
			return wrappedText(text);
		},

		renderResult(result, { expanded }, theme, context) {
			const cwd = context?.cwd;
			const collapsedItemCount = Math.max(1, Math.floor(settingNumber("collapsedItemCount", COLLAPSED_ITEM_COUNT, context?.cwd)));
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return wrappedText(text?.type === "text" ? text.text : "(no output)");
			}

			const mdTheme = getMarkdownTheme();
			const truncationBadge = (r: SingleResult) => (r.truncation?.truncated ? theme.fg("warning", " · truncated") : "");
			const fullOutputLine = (r: SingleResult) =>
				r.fullOutputPath
					? theme.fg("dim", `Full output: ${compactPath(r.fullOutputPath)}`)
					: r.fullOutputError
						? theme.fg("warning", `Full output unavailable: ${r.fullOutputError}`)
						: "";
			const transcriptLine = (r: SingleResult) => (r.transcriptPath ? theme.fg("dim", `Transcript: ${compactPath(r.transcriptPath)}`) : "");
			const queuedPaneLine = (r: SingleResult) => {
				if (!r.taskId || !r.paneId) return "";
				const hint = theme.fg("dim", " · ctrl+o");
				return agentStatusLine(theme, r.agent, "Queued task", "warning", `${theme.fg("dim", " · pane")}${hint}`);
			};
			const addFinalResponseMarkdown = (container: Container, finalOutput: string, toolCalls: DisplayItem[]) => {
				if (!finalOutput.trim()) {
					container.addChild(wrappedText(theme.fg("muted", "(no final response)")));
					return;
				}
				if (finalOutputLooksLikeToolEcho(finalOutput, toolCalls)) {
					container.addChild(wrappedText(finalResponseSuppressedLine(theme)));
					return;
				}
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			};

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const [index, item] of toShow.entries()) {
					const branch = subagentBranch(theme, index === toShow.length - 1 ? "└" : "├", cwd);
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						const lines = preview.split(/\r?\n/);
						text += `${branch}${theme.fg("toolOutput", lines[0] ?? "")}\n`;
						for (const line of lines.slice(1)) text += `${subagentBranch(theme, "│", cwd)}${theme.fg("toolOutput", line)}\n`;
					} else {
						text += `${branch}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const isQueued = !isError && Boolean(r.taskId && r.paneId);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const queued = queuedPaneLine(r);
				const quietDashboard = !expanded && dashboardEnabled(cwd) && quietInline(cwd);

				if (expanded) {
					const container = new Container();
					let header = agentStatusLine(theme, r.agent, isQueued ? "Queued task" : isError ? "failed" : "completed", isQueued ? "warning" : isError ? "error" : "success", theme.fg("dim", ` · ${isQueued ? "pane" : "bg"}`));
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					header += truncationBadge(r);
					container.addChild(wrappedText(header));
					if (isError && r.errorMessage)
						container.addChild(wrappedText(theme.fg("error", `Error: ${r.errorMessage}`)));
					container.addChild(new Spacer(1));
					container.addChild(wrappedText(theme.fg("muted", "─── Task ───")));
					container.addChild(wrappedText(theme.fg("dim", r.task)));
					container.addChild(new Spacer(1));
					const toolCalls = displayItems.filter((item) => item.type === "toolCall");
					container.addChild(wrappedText(theme.fg("muted", "─── Tools used ───")));
					if (toolCalls.length === 0) container.addChild(wrappedText(theme.fg("muted", "(none)")));
					else {
						for (const item of toolCalls) {
							container.addChild(
								wrappedText(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))),
							);
						}
					}
					container.addChild(new Spacer(1));
					container.addChild(wrappedText(theme.fg("muted", "─── Final response ───")));
					addFinalResponseMarkdown(container, finalOutput, toolCalls);
					const outputPath = fullOutputLine(r);
					if (outputPath) container.addChild(wrappedText(outputPath));
					const transcript = transcriptLine(r);
					if (transcript) container.addChild(wrappedText(transcript));
					const usageStr = queued ? "" : formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(wrappedText(theme.fg("dim", usageStr)));
					}
					return container;
				}

				if (quietDashboard && queued) {
					return wrappedText(agentStatusLine(theme, r.agent, "Queued task", "warning", `${theme.fg("dim", " · pane · dashboard")}${theme.fg("dim", " · ctrl+o")}`));
				}

				if (quietDashboard && !queued && !isError) {
					const toolCalls = displayItems.filter((item) => item.type === "toolCall");
					const preview = finalOutput && !finalOutputLooksLikeToolEcho(finalOutput, toolCalls)
						? oneLinePreview(finalOutput, 180)
						: r.task
							? oneLinePreview(r.task, 140)
							: "completed";
					let text = `${theme.fg("toolTitle", theme.bold("Result from"))} ${ansiMagenta(theme.bold(r.agent))}${theme.fg("dim", " · bg · ctrl+o")}${truncationBadge(r)}`;
					if (preview) text += `\n${subagentBranch(theme, "└", cwd)}${theme.fg("toolOutput", preview)}`;
					const outputPath = fullOutputLine(r);
					if (outputPath) text += `\n${outputPath}`;
					return wrappedText(text);
				}

				let text = queued || agentStatusLine(theme, r.agent, isError ? "failed" : "completed", isError ? "error" : "success", `${theme.fg("dim", " · bg")}${theme.fg("dim", " · ctrl+o")}`);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				text += truncationBadge(r);
				if (queued) text += `\n${subagentBranch(theme, "└", cwd)}${theme.fg("dim", r.task ? oneLinePreview(r.task, 120) : "queued task")}`;
				else if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${subagentBranch(theme, "└", cwd)}${theme.fg("dim", r.task ? oneLinePreview(r.task, 120) : "(no output)")}`;
				else {
					if (r.task) text += `\n${subagentBranch(theme, "├", cwd)}${theme.fg("dim", oneLinePreview(r.task, 120))}`;
					text += `\n${renderDisplayItems(displayItems, collapsedItemCount)}`;
					if (displayItems.length > collapsedItemCount) text += `\n${theme.fg("muted", "… more in ctrl+o")}`;
				}
				const outputPath = queued ? "" : fullOutputLine(r);
				if (outputPath) text += `\n${outputPath}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return wrappedText(text);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens || 0);
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", ICONS.check) : theme.fg("error", ICONS.times);

				if (expanded) {
					const container = new Container();
					container.addChild(
						wrappedText(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", ICONS.check) : theme.fg("error", ICONS.times);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							wrappedText(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}${truncationBadge(r)}`,
							),
						);
						container.addChild(wrappedText(theme.fg("muted", "Task: ") + theme.fg("dim", r.task)));
						const toolCalls = displayItems.filter((item) => item.type === "toolCall");
						container.addChild(wrappedText(theme.fg("muted", "Tools used:")));
						if (toolCalls.length === 0) container.addChild(wrappedText(theme.fg("muted", "(none)")));
						else {
							for (const item of toolCalls) {
								container.addChild(
									wrappedText(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))),
								);
							}
						}

						container.addChild(wrappedText(theme.fg("muted", "Final response:")));
						addFinalResponseMarkdown(container, finalOutput, toolCalls);

						const outputPath = fullOutputLine(r);
						if (outputPath) container.addChild(wrappedText(outputPath));
						const transcript = transcriptLine(r);
						if (transcript) container.addChild(wrappedText(transcript));
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(wrappedText(theme.fg("dim", stepUsage)));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(wrappedText(theme.fg("dim", `Total: ${usageStr}`)));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", ICONS.check) : theme.fg("error", ICONS.times);
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${truncationBadge(r)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const outputPath = fullOutputLine(r);
					if (outputPath) text += `\n${outputPath}`;
					const transcript = transcriptLine(r);
					if (transcript) text += `\n${transcript}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(ctrl+o to expand)")}`;
				return wrappedText(text);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const queuedPaneCount = details.results.filter((r) => r.exitCode === 0 && r.taskId && r.paneId).length;
				const oneshotCompletedCount = successCount - queuedPaneCount;
				const isRunning = running > 0;
				const total = details.results.length;
				const pluralN = (n: number) => (n === 1 ? "" : "s");
				const headerLabel = isRunning
					? `${total} agent${pluralN(total)} running`
					: failCount > 0
						? `${successCount}/${total} agent${pluralN(total)} completed`
						: queuedPaneCount === total
							? `${total} agent${pluralN(total)} launched`
							: queuedPaneCount > 0
								? `${total} agents launched (${oneshotCompletedCount} bg, ${queuedPaneCount} pane)`
								: `${total} agent${pluralN(total)} completed`;
				const hint = isRunning
					? ""
					: queuedPaneCount > 0
						? theme.fg("muted", " · see dashboard for live status")
						: dashboardEnabled(cwd) && quietInline(cwd) && !expanded
							? theme.fg("muted", " · lifecycle in dashboard")
						: expanded
							? ""
							: theme.fg("muted", " (ctrl+o to inspect)");
				const headerText =
					theme.fg("accent", "● ") +
					theme.fg("toolTitle", theme.bold(headerLabel)) +
					hint;
				const nameWidth = Math.min(28, Math.max(0, ...details.results.map((r) => visibleWidth(r.agent))));
				const rowTaskPreview = (r: SingleResult, maxChars: number) =>
					r.task ? theme.fg("dim", ` · ${oneLinePreview(r.task, maxChars)}`) : "";
				const treeText = details.results
					.map((r, index) => {
						const prefix = index === details.results.length - 1 ? "└" : "├";
						const name = padAnsi(ansiMagenta(theme.bold(r.agent)), nameWidth);
						return `${subagentBranch(theme, prefix, cwd)}${name}${rowTaskPreview(r, 100)}${truncationBadge(r)}`;
					})
					.join("\n");

				// Always render the simple tree, expanded or not. The previous expanded
				// branch dumped per-agent Tools/Final/Transcript blocks that duplicated
				// the data the dashboard and subagent-completion messages already show.
				void isRunning;
				return wrappedText(`${headerText}\n${treeText}`);
			}

			const text = result.content[0];
			return wrappedText(text?.type === "text" ? text.text : "(no output)");
		},
	});

	emitSubagentEvent(pi, "subagents:ready", { mode: "extension" });
}
