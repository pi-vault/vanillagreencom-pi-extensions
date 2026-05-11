/**
 * pi-flightdeck — read-only mission control for the flightdeck skill.
 *
 * Reads on-disk artifacts produced by skills/flightdeck/scripts/* — never
 * mutates them. Renders three surfaces:
 *   1. A persistent dashboard widget above the editor with one row per
 *      tracked issue.
 *   2. A high-contrast pause banner above the editor whenever master
 *      sets paused_for_user. This is the primary attention surface.
 *   3. A /flightdeck popup with six tabs (Overview / Live feed /
 *      Conversations / Conflicts & merges / Decisions / Daemon).
 *
 * Pi extension only — the underlying flightdeck skill works without this
 * extension via the same on-disk files.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	type ConversationTurn,
	type FlightdeckSnapshot,
	type IssueRecord,
	type IssueState,
	ageSecondsSince,
	buildSnapshot,
	flatDecisionsLog,
	flightdeckSessionStatus,
	foldWakeEventsIntoConversations,
	formatAge,
	mostRecentPollMs,
	type SettingsLike,
	sortedIssues,
} from "./state.js";
import {
	buildPaneTargetToIdMap,
	formatUsageCompact,
	getAgentsBridge,
	type AgentsBridgeItem,
} from "./agents-bridge.js";
import {
	ANSI_BELL,
	ansiGreen,
	ansiYellow,
	daemonHealthChip,
	divider,
	dotIndicator,
	formatShortcutHint,
	frameContentWidth,
	framePanel,
	framePopup,
	harnessChip,
	label,
	pad,
	panelBranch,
	searchRow,
	selectedRow,
	stateBadge,
	stateColor,
	stateGlyph,
	tagBadge,
	type TreeStyle,
	wrapLine,
} from "./render.js";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-flightdeck.installed");
const CONFIG_ID = "@vanillagreen/pi-flightdeck";
const SETTINGS_EVENT = "vstack:extension-settings-changed";
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
const WIDGET_KEY = "vstack-flightdeck-widget";
const POPUP_WIDTH_PERCENT = "92%";
const POPUP_MAX_HEIGHT = "85%";

type DashboardState = "hidden" | "compact" | "expanded";

interface VstackModalLock { depth: number }

function expandHome(input: string): string {
	if (!input) return input;
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function userPiDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function projectPiSettingsPath(cwd: string): string {
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
	return [join(userPiDir(), "settings.json"), projectPiSettingsPath(cwd)];
}

type ConfigBag = Record<string, unknown>;

function readVstackConfig(cwd?: string): ConfigBag {
	const merged: ConfigBag = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
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

function settingsLike(cwd?: string): SettingsLike {
	const stateDir = settingString("stateDir", "", cwd);
	const flightdeckStateDir = settingString("flightdeckStateDir", "tmp", cwd);
	return {
		flightdeckStateDir,
		stateDir: stateDir || undefined,
	};
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

function compactPath(input: string): string {
	const home = homedir();
	if (input.startsWith(home)) return `~${input.slice(home.length)}`;
	return input;
}

function classifyDaemonLogLine(line: string): "info" | "warn" | "error" | "wake" | "classify" | "heartbeat" {
	if (/\] (wake|adapter-wake)/i.test(line)) return "wake";
	if (/\] heartbeat /i.test(line)) return "heartbeat";
	if (/\] (warn|error|fail|stale|gone)/i.test(line)) return "warn";
	if (/\] classify /i.test(line)) return "classify";
	return "info";
}

function colorizeDaemonLogLine(line: string, theme: Theme): string {
	const kind = classifyDaemonLogLine(line);
	switch (kind) {
		case "wake": return theme.fg("success", line);
		case "warn": return theme.fg("warning", line);
		case "error": return theme.fg("error", line);
		case "classify": return theme.fg("accent", line);
		case "heartbeat": return theme.fg("dim", line);
		default: return theme.fg("text", line);
	}
}

interface DashboardCache {
	state: DashboardState;
	conversations: Map<string, ConversationTurn[]>;
	lastSnapshot?: FlightdeckSnapshot;
	pauseSeenIssue?: string;
	pauseSeenAt?: number;
	// Tmux `session:window.pane` → `%N` map, refreshed on each tick so issue
	// rows can join against the pi-agents-tmux stats bridge.
	paneTargetToId: Map<string, string>;
}

function usageForIssue(issue: IssueRecord, paneMap: Map<string, string>, bridge: ReturnType<typeof getAgentsBridge>): AgentsBridgeItem | undefined {
	if (!bridge) return undefined;
	// Prefer the registry-recorded pane_id (immutable for the life of the
	// pane). Fall back to resolving pane_target via tmux for legacy
	// registry entries that haven't been re-init'd since pane_id support.
	const paneId = issue.pane_id || (issue.pane_target ? paneMap.get(issue.pane_target) : undefined);
	if (!paneId) return undefined;
	return bridge.getByPaneId(paneId);
}

function defaultDashboardState(cwd?: string): DashboardState {
	const value = settingString("dashboardDefaultState", "compact", cwd);
	return value === "hidden" || value === "expanded" ? value : "compact";
}

function pollIntervalMs(cwd?: string): number {
	const raw = Math.floor(settingNumber("pollIntervalMs", 1500, cwd));
	return Math.max(500, raw);
}

// ============================================================================
// Widget render — pause banner + persistent dashboard
// ============================================================================

function renderPauseBannerLines(snapshot: FlightdeckSnapshot, theme: Theme, width: number): string[] {
	const paused = snapshot.master?.paused_for_user;
	if (!paused) return [];
	const issueId = paused.issue_id ?? "(unknown)";
	const reason = paused.reason ?? "paused for user";
	const promptText = (paused.prompt_text ?? "").replace(/\s+/g, " ").trim();
	const inner = frameContentWidth(width) - 2;
	const titleLine = `${theme.fg("warning", "▲ FLIGHTDECK PAUSED")} ${theme.fg("muted", "for")} ${theme.fg("accent", issueId)} ${theme.fg("dim", "—")} ${theme.fg("warning", reason)}`;
	const issue = snapshot.master?.issues?.[issueId];
	const paneInfo = issue?.pane_target ? `${theme.fg("muted", "pane")} ${theme.fg("text", issue.pane_target)} ${theme.fg("dim", "·")} ${harnessChip(theme, issue.harness)}` : "";
	const prInfo = issue?.pr_number ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", "PR")} ${theme.fg("accent", `#${issue.pr_number}`)}` : "";
	const meta = paneInfo ? `${paneInfo}${prInfo}` : "";
	const promptWrap = promptText ? wrapLine(theme.fg("dim", promptText), inner).slice(0, 4) : [];
	const hint = theme.fg("dim", "Respond in chat to resume the master agent. ") + theme.fg("warning", `${settingString("popupShortcut", "f6")} `) + theme.fg("dim", "for full context.");
	const lines: string[] = [];
	lines.push(titleLine);
	if (meta) lines.push(meta);
	if (promptWrap.length > 0) {
		lines.push("");
		for (const row of promptWrap) lines.push(row);
	}
	lines.push("");
	lines.push(hint);
	return framePanel(lines, width, theme, "warning", " PAUSE — awaiting user ");
}

function renderStaleHintLine(snapshot: FlightdeckSnapshot, theme: Theme, width: number): string[] {
	const latest = mostRecentPollMs(snapshot);
	const ageSec = latest === undefined ? undefined : Math.max(0, Math.floor((Date.now() - latest) / 1000));
	const ageText = ageSec === undefined ? "unknown age" : `${formatAge(ageSec)} ago`;
	const daemon = daemonHealthChip(theme, snapshot.daemon.pidAlive, snapshot.daemon.heartbeatAgeSec);
	const line = `${daemon} ${theme.fg("dim", "·")} ${theme.fg("dim", `Flightdeck · stale state from ${ageText} — restart with /skill:flightdeck start, or archive state file to dismiss`)}`;
	return [truncateToWidth(line, Math.max(1, width), "…")];
}

function renderDashboardLines(snapshot: FlightdeckSnapshot, theme: Theme, width: number, state: DashboardState, cwd: string, paneMap: Map<string, string>): string[] {
	if (state === "hidden") return [];
	const issues = sortedIssues(snapshot.master);
	const max = Math.max(1, Math.floor(settingNumber("dashboardMaxItems", 8, cwd)));
	const treeStyle = (settingString("treeStyle", "unicode", cwd) === "ascii" ? "ascii" : "unicode") as TreeStyle;
	const totalIssues = issues.length;
	const counts: Record<string, number> = {};
	for (const issue of issues) counts[issue.state ?? "?"] = (counts[issue.state ?? "?"] ?? 0) + 1;
	const summaryParts: string[] = [];
	const order: IssueState[] = ["prompting", "merge-ready", "submitting", "waiting", "merged", "aborted", "dead"];
	// Suppress the per-state count strip when the single issue row below
	// already shows the same state badge — avoids "✱ 1 · CC-511 · ✱ waiting".
	const showStateCounts = totalIssues > 1;
	if (showStateCounts) for (const s of order) if (counts[s]) summaryParts.push(theme.fg(stateColor(s), `${stateGlyph(s)} ${counts[s]}`));
	const daemonHealth = daemonHealthChip(theme, snapshot.daemon.pidAlive, snapshot.daemon.heartbeatAgeSec);
	const queueLen = snapshot.master?.merge_queue?.length ?? 0;
	const queueBadge = queueLen > 0 ? ` ${theme.fg("muted", "·")} ${theme.fg("accent", `merge-queue ${queueLen}`)}` : "";
	// Keyhints — same pattern as pi-agents-tmux dashboard header:
	// `<title> <stats> · Alt+F toggle · F6 popup · <daemon-health>`. Both
	// shortcuts read from extension settings so user overrides are reflected.
	const toggleShortcut = settingString("dashboardShortcut", "alt+m", cwd);
	const popupShortcut = settingString("popupShortcut", "f6", cwd);
	const toggleHint = toggleShortcut === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(toggleShortcut)} toggle`);
	const popupHint = popupShortcut === "none" ? "" : theme.fg("dim", ` · ${formatShortcutHint(popupShortcut)} popup`);
	const hints = `${toggleHint}${popupHint}`;
	const headerLeft = `${theme.fg("customMessageLabel", theme.bold("Flightdeck"))} ${theme.fg("muted", `${totalIssues} issue${totalIssues === 1 ? "" : "s"}`)}${summaryParts.length > 0 ? ` ${theme.fg("muted", "·")} ${summaryParts.join(theme.fg("dim", " "))}` : ""}${queueBadge}${hints}`;
	const header = `${headerLeft}  ${theme.fg("dim", "·")}  ${daemonHealth}`;
	const bridge = getAgentsBridge();
	if (state === "compact") {
		const lines = [header];
		const visible = issues.slice(0, max);
		for (const [index, issue] of visible.entries()) {
			const isLast = index === visible.length - 1 && issues.length === visible.length;
			const stats = usageForIssue(issue, paneMap, bridge);
			lines.push(`${panelBranch(theme, isLast ? "└" : "├", treeStyle)}${renderIssueLine(issue, theme, snapshot, stats)}`);
		}
		const hidden = Math.max(0, issues.length - visible.length);
		if (hidden > 0) lines.push(`${panelBranch(theme, "└", treeStyle)}${theme.fg("muted", `… ${hidden} more`)}`);
		return framePanel(lines, width, theme);
	}
	// expanded
	const lines = [header, ""];
	for (const [index, issue] of issues.entries()) {
		const isLast = index === issues.length - 1;
		const stats = usageForIssue(issue, paneMap, bridge);
		lines.push(`${panelBranch(theme, isLast ? "└" : "├", treeStyle)}${renderIssueLine(issue, theme, snapshot, stats)}`);
		const stem = panelBranch(theme, "│", treeStyle);
		const detailRows = renderIssueDetailLines(issue, theme, stats);
		for (const row of detailRows) lines.push(`${stem}${row}`);
	}
	return framePanel(lines, width, theme);
}

function renderIssueLine(issue: IssueRecord, theme: Theme, _snapshot: FlightdeckSnapshot, stats?: AgentsBridgeItem): string {
	const state = stateBadge(theme, issue.state);
	const harness = harnessChip(theme, issue.harness);
	const pr = issue.pr_number ? theme.fg("accent", `PR#${issue.pr_number}`) : theme.fg("dim", "no-PR");
	const sub = issue.substate ? ` ${theme.fg("dim", "·")} ${tagBadge(theme, issue.substate)}` : "";
	const polled = ageSecondsSince(issue.last_polled_at);
	const polledTxt = polled !== undefined ? ` ${theme.fg("dim", `(${formatAge(polled)})`)}` : "";
	const usageText = formatUsageCompact(stats?.usage);
	const usageTxt = usageText ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", usageText)}` : "";
	return `${theme.bold(theme.fg("text", issue.issue))} ${theme.fg("dim", "·")} ${state} ${theme.fg("dim", "·")} ${harness} ${theme.fg("dim", "·")} ${pr}${sub}${usageTxt}${polledTxt}`;
}

function renderIssueDetailLines(issue: IssueRecord, theme: Theme, stats?: AgentsBridgeItem): string[] {
	const out: string[] = [];
	if (issue.pane_target) out.push(theme.fg("dim", `pane ${issue.pane_target}`));
	if (issue.launch?.model || issue.launch?.effort) out.push(theme.fg("dim", `run  ${formatLaunchProfile(issue)}`));
	const usageText = formatUsageCompact(stats?.usage);
	if (usageText) out.push(theme.fg("dim", `cost ${usageText}`));
	if (issue.worktree) out.push(theme.fg("dim", `wt   ${compactPath(issue.worktree)}`));
	const decisions = issue.decisions_log ?? [];
	const last = decisions[decisions.length - 1];
	if (last) {
		out.push(`${theme.fg("dim", "last ")}${tagBadge(theme, last.prompt_tag)} ${theme.fg("dim", "→")} ${theme.fg("text", last.answer)} ${theme.fg("dim", `${formatAge(ageSecondsSince(last.ts))} ago`)}`);
	}
	if (issue.unknown_since) {
		const sec = ageSecondsSince(issue.unknown_since);
		out.push(theme.fg("warning", `unknown for ${formatAge(sec)}`));
	}
	if (typeof issue.scope_files_actual === "number" && typeof issue.scope_files_declared === "number" && issue.scope_files_declared > 0) {
		const ratio = issue.scope_files_actual / issue.scope_files_declared;
		const txt = `scope ${issue.scope_files_actual}/${issue.scope_files_declared}`;
		out.push(ratio > 2 ? theme.fg("error", `${txt} (>2× — possible creep)`) : theme.fg("dim", txt));
	}
	return out;
}

function formatLaunchProfile(issue: IssueRecord): string {
	const model = typeof issue.launch?.model === "string" && issue.launch.model.trim() ? issue.launch.model.trim() : "default-model";
	const effort = typeof issue.launch?.effort === "string" && issue.launch.effort.trim() ? issue.launch.effort.trim() : "default-effort";
	return `${model} · ${effort}`;
}

// ============================================================================
// Popup — six tabs
// ============================================================================

const TAB_OVERVIEW = "overview";
const TAB_LIVE = "live";
const TAB_CONVERSATIONS = "conversations";
const TAB_CONFLICTS = "conflicts";
const TAB_DECISIONS = "decisions";
const TAB_DAEMON = "daemon";

type Tab = typeof TAB_OVERVIEW | typeof TAB_LIVE | typeof TAB_CONVERSATIONS | typeof TAB_CONFLICTS | typeof TAB_DECISIONS | typeof TAB_DAEMON;

const TABS: Array<{ id: Tab; label: string }> = [
	{ id: TAB_OVERVIEW, label: "Overview" },
	{ id: TAB_LIVE, label: "Live feed" },
	{ id: TAB_CONVERSATIONS, label: "Conversations" },
	{ id: TAB_CONFLICTS, label: "Conflicts & merges" },
	{ id: TAB_DECISIONS, label: "Decisions" },
	{ id: TAB_DAEMON, label: "Daemon" },
];

interface PopupUiState {
	tab: Tab;
	scroll: number;
	selected: number;
	search: string;
	showHelp: boolean;
}

function makeInitialPopupState(): PopupUiState {
	return { scroll: 0, search: "", selected: 0, showHelp: false, tab: TAB_OVERVIEW };
}

function renderTabBar(active: Tab, width: number, theme: Theme): string {
	const cells = TABS.map((tab) => {
		const text = ` ${tab.label} `;
		if (tab.id === active) return theme.fg("accent", theme.inverse(theme.bold(text)));
		return theme.bg("selectedBg", theme.fg("accent", text));
	});
	return pad(cells.join(" "), width);
}

function isPlainSearchInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function activePopupCwd(ctx: ExtensionContext | ExtensionCommandContext): string {
	return (ctx as { cwd?: string }).cwd ?? process.cwd();
}

// ----- Tab renderers --------------------------------------------------------

function renderOverviewTab(snapshot: FlightdeckSnapshot, ui: PopupUiState, width: number, theme: Theme, viewportRows: number, paneMap: Map<string, string>): string[] {
	const issues = sortedIssues(snapshot.master);
	const filtered = ui.search.trim()
		? issues.filter((issue) => {
			const hay = `${issue.issue} ${issue.window ?? ""} ${issue.harness ?? ""} ${issue.state ?? ""} ${issue.substate ?? ""}`.toLowerCase();
			return hay.includes(ui.search.trim().toLowerCase());
		})
		: issues;
	clampSelection(ui, filtered.length, viewportRows);
	const lines: string[] = [];
	lines.push(searchRow(theme, ui.search, width));
	lines.push("");
	if (filtered.length === 0) {
		if (issues.length === 0) {
			lines.push(`${theme.fg("dim", "No issues tracked yet. Run ")}${ansiGreen("'/skill:flightdeck start'")}${theme.fg("dim", " to spawn.")}`);
		} else {
			lines.push(theme.fg("dim", "No matches for current search."));
		}
		return lines;
	}
	const bridge = getAgentsBridge();
	const statsByIssue = new Map<string, AgentsBridgeItem | undefined>();
	for (const issue of filtered) statsByIssue.set(issue.issue, usageForIssue(issue, paneMap, bridge));
	const hasStats = Array.from(statsByIssue.values()).some((stat) => Boolean(stat?.usage));
	const hdr = formatOverviewHeader(theme, width, hasStats);
	lines.push(hdr);
	lines.push(divider(width, theme));
	const rows = Math.max(1, viewportRows - lines.length - 2);
	const tail = Math.max(0, filtered.length - (ui.scroll + rows));
	if (ui.scroll > 0) lines.push(theme.fg("dim", `↑ ${ui.scroll} earlier`));
	for (const [vi, issue] of filtered.slice(ui.scroll, ui.scroll + rows).entries()) {
		const idx = ui.scroll + vi;
		const selected = idx === ui.selected;
		const statsText = formatUsageCompact(statsByIssue.get(issue.issue)?.usage);
		const row = formatOverviewRow(issue, theme, width, statsText, hasStats);
		lines.push(selected ? selectedRow(theme, row, width) : row);
	}
	if (tail > 0) lines.push(theme.fg("dim", `↓ ${tail} more`));
	const issue = filtered[ui.selected];
	if (issue) {
		lines.push("");
		lines.push(divider(width, theme));
		lines.push(...renderIssueDetailBlock(issue, theme, width, statsByIssue.get(issue.issue)));
	}
	return lines;
}

function formatOverviewHeader(theme: Theme, width: number, hasStats: boolean): string {
	const base = `${pad(label(theme, "ID"), 18)} ${pad(label(theme, "STATE / PROMPT"), 32)} ${pad(label(theme, "HARNESS"), 10)} ${pad(label(theme, "PR"), 8)}`;
	const stats = hasStats ? ` ${pad(label(theme, "COST / TURNS / TOKENS"), 30)}` : "";
	const line = `${base}${stats} ${label(theme, "AGE")}`;
	return truncateToWidth(line, width, "");
}

function formatOverviewRow(issue: IssueRecord, theme: Theme, width: number, stats: string | undefined, hasStats: boolean): string {
	const id = pad(theme.fg("text", issue.issue), 18);
	const stateAndPrompt = issue.substate
		? `${stateBadge(theme, issue.state)} ${theme.fg("dim", "·")} ${tagBadge(theme, issue.substate)}`
		: stateBadge(theme, issue.state);
	const state = pad(stateAndPrompt, 32);
	const harness = pad(harnessChip(theme, issue.harness), 10);
	const pr = pad(issue.pr_number ? theme.fg("accent", `#${issue.pr_number}`) : theme.fg("dim", "—"), 8);
	const statsCell = hasStats ? ` ${pad(stats ? theme.fg("dim", stats) : theme.fg("dim", "—"), 30)}` : "";
	const age = formatAge(ageSecondsSince(issue.last_polled_at));
	return truncateToWidth(`${id} ${state} ${harness} ${pr}${statsCell} ${theme.fg("dim", age)}`, width, "");
}

function renderIssueDetailBlock(issue: IssueRecord, theme: Theme, width: number, stats?: AgentsBridgeItem): string[] {
	const lines: string[] = [];
	lines.push(`${theme.fg("customMessageLabel", theme.bold(issue.issue))} ${theme.fg("dim", "·")} ${stateBadge(theme, issue.state)} ${theme.fg("dim", "·")} ${harnessChip(theme, issue.harness)}`);
	if (issue.pane_target) lines.push(`${label(theme, "pane:")} ${theme.fg("text", issue.pane_target)}`);
	if (issue.launch?.model || issue.launch?.effort) lines.push(`${label(theme, "run:")}  ${theme.fg("text", formatLaunchProfile(issue))}`);
	if (issue.worktree) lines.push(`${label(theme, "wt:")}   ${theme.fg("text", compactPath(issue.worktree))}`);
	if (issue.pr_number) lines.push(`${label(theme, "PR:")}   ${theme.fg("accent", `#${issue.pr_number}`)}`);
	if (issue.substate) lines.push(`${label(theme, "tag:")}  ${tagBadge(theme, issue.substate)}`);
	const usageText = formatUsageCompact(stats?.usage);
	if (usageText) {
		const modelSuffix = stats?.model ? ` ${theme.fg("dim", `(${stats.model})`)}` : "";
		lines.push(`${label(theme, "usage:")} ${theme.fg("text", usageText)}${modelSuffix}`);
	}
	if (issue.unknown_since) {
		const sec = ageSecondsSince(issue.unknown_since);
		lines.push(`${label(theme, "unknown:")} ${theme.fg("warning", formatAge(sec))}`);
	}
	if (typeof issue.scope_files_actual === "number" && typeof issue.scope_files_declared === "number") {
		lines.push(`${label(theme, "scope:")} ${theme.fg("text", `${issue.scope_files_actual} files`)} ${theme.fg("dim", `(declared ${issue.scope_files_declared})`)}`);
	}
	const decisions = issue.decisions_log ?? [];
	if (decisions.length > 0) {
		lines.push("");
		lines.push(label(theme, `last decisions (${decisions.length}):`));
		const recent = decisions.slice(-5);
		for (const entry of recent) {
			lines.push(`  ${theme.fg("dim", entry.ts.slice(11, 19))}  ${tagBadge(theme, entry.prompt_tag)} ${theme.fg("dim", "→")} ${theme.fg("text", entry.answer)}`);
		}
	}
	return lines.flatMap((line) => wrapLine(line, width));
}

interface LiveEvent {
	ts: string;          // HH:MM:SS short form, for display
	isoTs: string;       // full ISO timestamp, for sorting
	kind: "daemon" | "decision" | "event-pending" | "event-wake" | "heartbeat-fold";
	line: string;
	count?: number;
}

function renderLiveFeedTab(snapshot: FlightdeckSnapshot, ui: PopupUiState, width: number, theme: Theme, viewportRows: number, cwd: string): string[] {
	const max = Math.max(20, Math.floor(settingNumber("liveFeedLines", 200, cwd)));
	const raw: LiveEvent[] = [];
	for (const line of (snapshot.daemon.logTail ?? []).slice(-max)) {
		const isoTs = line.match(/^[^ ]+/)?.[0] ?? "";
		raw.push({ kind: classifyDaemonLogLine(line) === "heartbeat" ? "daemon" : "daemon", line, ts: isoTs.slice(11, 19), isoTs });
	}
	const decisions = flatDecisionsLog(snapshot.master, max);
	for (const d of decisions) {
		raw.push({ kind: "decision", line: `${d.ts} [decision] ${d.issue} ${d.prompt_tag} → ${d.answer}`, ts: d.ts.slice(11, 19), isoTs: d.ts });
	}
	for (const ev of snapshot.pendingEvents.slice(-max)) {
		const isoTs = ev.ts ?? "";
		raw.push({ kind: "event-pending", line: `${isoTs} [pending] pane=${ev.pane_id ?? "?"} tag=${ev.tag ?? "?"} reason=${ev.reason ?? "?"} age=${ev.stable_age_sec ?? 0}s`, ts: isoTs.slice(11, 19), isoTs });
	}
	for (const ev of snapshot.wakeEvents.slice(-max)) {
		const tag = ev.classifier_tag ?? "?";
		const text = (ev.last_assistant_text ?? "").slice(0, 80).replace(/\s+/g, " ");
		const extra = ev.event_type === "question" && typeof ev.question === "object"
			? ` request_id=${ev.request_id ?? "?"}`
			: ev.event_type === "subagent-completion" ? " subagent-completion" : "";
		const isoTs = ev.ts ?? "";
		raw.push({ kind: "event-wake", line: `${isoTs} [adapter:${ev.harness ?? "?"}] pane=${ev.pane_id ?? "?"} tag=${tag}${extra}${text ? ` :: ${text}` : ""}`, ts: isoTs.slice(11, 19), isoTs });
	}
	// Chronological order — the prior `localeCompare(line)` sort mixed daemon
	// timestamps with adapter timestamps and obscured causality.
	raw.sort((a, b) => a.isoTs.localeCompare(b.isoTs));
	const events = foldHeartbeats(raw);
	const filtered = ui.search.trim() ? events.filter((e) => e.line.toLowerCase().includes(ui.search.trim().toLowerCase())) : events;
	const lines: string[] = [];
	lines.push(searchRow(theme, ui.search, width));
	lines.push("");
	if (filtered.length === 0) {
		lines.push(theme.fg("dim", "No live events. Daemon may be quiet or not running."));
		return lines;
	}
	const rows = Math.max(1, viewportRows - lines.length - 1);
	clampSelection(ui, filtered.length, rows);
	const start = Math.max(0, Math.min(ui.scroll, Math.max(0, filtered.length - rows)));
	const end = Math.min(filtered.length, start + rows);
	if (start > 0) lines.push(theme.fg("dim", `↑ ${start} earlier`));
	for (const [vi, ev] of filtered.slice(start, end).entries()) {
		const idx = start + vi;
		const selected = idx === ui.selected;
		const colored = colorizeLiveEvent(ev, theme);
		const rowText = truncateToWidth(colored, width, "");
		lines.push(selected ? selectedRow(theme, rowText, width) : rowText);
	}
	const tail = Math.max(0, filtered.length - end);
	if (tail > 0) lines.push(theme.fg("dim", `↓ ${tail} more`));
	return lines;
}

function colorizeLiveEvent(ev: LiveEvent, theme: Theme): string {
	switch (ev.kind) {
		case "daemon": return colorizeDaemonLogLine(ev.line, theme);
		case "decision": return theme.fg("accent", ev.line);
		case "event-wake": return theme.fg("text", ev.line);
		case "event-pending": return theme.fg("warning", ev.line);
		case "heartbeat-fold": return theme.fg("dim", ev.line);
	}
}

// Consecutive `[heartbeat]` daemon lines fold into one summary row so the
// feed surfaces real activity. Non-heartbeat lines split the run.
function foldHeartbeats(events: LiveEvent[]): LiveEvent[] {
	const out: LiveEvent[] = [];
	let runStart: LiveEvent | undefined;
	let runEnd: LiveEvent | undefined;
	let runCount = 0;
	const flush = () => {
		if (!runStart || runCount === 0) return;
		if (runCount === 1) {
			out.push(runStart);
		} else {
			const endTs = runEnd?.ts ?? runStart.ts;
			out.push({
				kind: "heartbeat-fold",
				ts: endTs,
				isoTs: runEnd?.isoTs ?? runStart.isoTs,
				line: `${runStart.ts}→${endTs}  ×${runCount} heartbeats (daemon alive)`,
				count: runCount,
			});
		}
		runStart = undefined;
		runEnd = undefined;
		runCount = 0;
	};
	for (const ev of events) {
		const isHeartbeat = ev.kind === "daemon" && /\[heartbeat\]/.test(ev.line);
		if (isHeartbeat) {
			if (!runStart) runStart = ev;
			runEnd = ev;
			runCount += 1;
			continue;
		}
		flush();
		out.push(ev);
	}
	flush();
	return out;
}

function renderConversationsTab(snapshot: FlightdeckSnapshot, conversations: Map<string, ConversationTurn[]>, ui: PopupUiState, width: number, theme: Theme, viewportRows: number, cwd: string): string[] {
	const issues = sortedIssues(snapshot.master);
	// Build a pane-id → issue map so the rendered rows show the issue id
	// alongside the raw pane id. Modern registry entries store the
	// immutable `pane_id` (`%N`) at init; legacy entries are backfilled by
	// `pane-registry reconcile`. The conversation Map is keyed by pane_id
	// from wake events, so this join is direct.
	const issueByPane = new Map<string, IssueRecord>();
	for (const issue of issues) {
		if (issue.pane_id) issueByPane.set(issue.pane_id, issue);
	}
	const excerptChars = Math.max(120, Math.floor(settingNumber("conversationExcerptChars", 800, cwd)));
	const lines: string[] = [];
	lines.push(searchRow(theme, ui.search, width));
	lines.push("");
	if (conversations.size === 0) {
		lines.push(theme.fg("dim", "No assistant turns captured yet."));
		lines.push("");
		lines.push(theme.fg("dim", "Conversations are populated from adapter wake events as inner panes finish turns."));
		lines.push(theme.fg("dim", "Events get drained on each master turn boundary, so this is a rolling buffer."));
		return lines;
	}
	const entries = [...conversations.entries()].sort();
	const filtered = ui.search.trim()
		? entries.filter(([pane, turns]) => `${pane} ${turns.map((t) => t.excerpt).join(" ")}`.toLowerCase().includes(ui.search.trim().toLowerCase()))
		: entries;
	for (const [pane, turns] of filtered) {
		const issue = issueByPane.get(pane);
		const issueLabel = issue ? ` ${theme.fg("accent", issue.issue)}` : "";
		lines.push(`${theme.fg("customMessageLabel", theme.bold(pane))}${issueLabel} ${theme.fg("dim", `(${turns.length} turn${turns.length === 1 ? "" : "s"})`)}`);
		for (const turn of turns.slice(-3)) {
			const ts = turn.ts.slice(11, 19);
			lines.push(`  ${theme.fg("dim", ts)} ${harnessChip(theme, turn.harness)} ${theme.fg("dim", "·")} ${tagBadge(theme, turn.tag)}`);
			const wrapped = wrapLine(theme.fg("text", turn.excerpt.slice(0, excerptChars)), width - 4);
			for (const row of wrapped.slice(0, 4)) lines.push(`    ${row}`);
		}
		lines.push("");
	}
	const limited = lines.slice(0, viewportRows);
	if (lines.length > viewportRows) limited.push(theme.fg("dim", `↓ ${lines.length - viewportRows} more lines`));
	return limited;
}

function renderConflictsTab(snapshot: FlightdeckSnapshot, _ui: PopupUiState, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const queue = snapshot.master?.merge_queue ?? [];
	const edges = snapshot.master?.conflict_graph?.edges ?? [];
	const computed = snapshot.master?.conflict_graph?.computed_at;
	lines.push(`${theme.fg("customMessageLabel", theme.bold("Merge queue"))} ${theme.fg("dim", `(${queue.length})`)}`);
	if (queue.length === 0) lines.push(theme.fg("dim", "  (empty)"));
	else for (const [i, id] of queue.entries()) {
		const issue = snapshot.master?.issues[id];
		const state = stateBadge(theme, issue?.state);
		const pr = issue?.pr_number ? theme.fg("accent", `PR#${issue.pr_number}`) : theme.fg("dim", "no-PR");
		lines.push(`  ${theme.fg("muted", `${i + 1}.`)} ${theme.bold(theme.fg("text", id))} ${theme.fg("dim", "·")} ${state} ${theme.fg("dim", "·")} ${pr}`);
	}
	lines.push("");
	lines.push(`${theme.fg("customMessageLabel", theme.bold("Conflict graph"))} ${theme.fg("dim", `(${edges.length} edge${edges.length === 1 ? "" : "s"}${computed ? `, ${formatAge(ageSecondsSince(computed))} ago` : ""})`)}`);
	if (edges.length === 0) lines.push(theme.fg("dim", "  (no detected file overlap)"));
	else for (const [a, b] of edges) {
		const aIssue = snapshot.master?.issues[a];
		const bIssue = snapshot.master?.issues[b];
		const ap = aIssue?.pr_number ? `#${aIssue.pr_number}` : "";
		const bp = bIssue?.pr_number ? `#${bIssue.pr_number}` : "";
		lines.push(`  ${theme.fg("text", a)}${ap ? theme.fg("dim", ` ${ap}`) : ""} ${theme.fg("warning", "↔")} ${theme.fg("text", b)}${bp ? theme.fg("dim", ` ${bp}`) : ""}`);
	}
	return lines.flatMap((line) => wrapLine(line, width));
}

function renderDecisionsTab(snapshot: FlightdeckSnapshot, ui: PopupUiState, width: number, theme: Theme, viewportRows: number, cwd: string): string[] {
	const max = Math.max(50, Math.floor(settingNumber("liveFeedLines", 200, cwd)));
	const decisions = flatDecisionsLog(snapshot.master, max);
	const filtered = ui.search.trim()
		? decisions.filter((d) => `${d.issue} ${d.prompt_tag} ${d.answer}`.toLowerCase().includes(ui.search.trim().toLowerCase()))
		: decisions;
	clampSelection(ui, filtered.length, viewportRows);
	const lines: string[] = [];
	lines.push(searchRow(theme, ui.search, width));
	lines.push("");
	if (filtered.length === 0) {
		lines.push(theme.fg("dim", decisions.length === 0 ? "No decisions logged yet." : "No matches for current search."));
		return lines;
	}
	lines.push(`${pad(label(theme, "TIME"), 10)} ${pad(label(theme, "ISSUE"), 16)} ${pad(label(theme, "PROMPT TAG"), 26)} ${label(theme, "ANSWER")}`);
	lines.push(divider(width, theme));
	const rows = Math.max(1, viewportRows - lines.length);
	const sliceStart = Math.max(0, filtered.length - rows);
	for (const d of filtered.slice(sliceStart)) {
		const time = pad(theme.fg("dim", d.ts.slice(11, 19)), 10);
		const issue = pad(theme.fg("text", d.issue), 16);
		const tag = pad(tagBadge(theme, d.prompt_tag), 26);
		const answer = theme.fg("text", d.answer);
		lines.push(truncateToWidth(`${time} ${issue} ${tag} ${answer}`, width, ""));
	}
	return lines;
}

type HarnessKey = "opencode" | "claude" | "pi" | "codex";
const HARNESS_KEY_BY_NAME: Record<string, HarnessKey> = { opencode: "opencode", claude: "claude", pi: "pi", codex: "codex" };

function isActiveIssue(issue: IssueRecord): boolean {
	return issue.state !== "merged" && issue.state !== "aborted" && issue.state !== "dead";
}

// An issue is "adapter-eligible" only when its registry record carries
// the adapter metadata fields the daemon's spawn_<h>_subscriber path
// reads. Without this gate, expectedSubscribers counted every active
// pi/claude/codex issue as needing a subscriber even when the spawn
// failed gracefully and the pane is intentionally on tmux fallback
// (cross-harness review finding #5).
function issueIsAdapterEligible(issue: IssueRecord, harness: HarnessKey): boolean {
	const rec = issue as Record<string, unknown>;
	const hasField = (k: string): boolean => {
		const v = rec[k];
		return typeof v === "string" ? v.length > 0 : v !== null && v !== undefined && v !== "";
	};
	switch (harness) {
		case "opencode": return hasField("oc_url") && hasField("oc_session_id");
		case "claude":   return hasField("cc_url") && hasField("cc_transcript");
		case "pi":       return hasField("pi_bridge_socket") || hasField("pi_bridge_pid");
		case "codex":    return hasField("cx_ws") && hasField("cx_thread_id");
	}
}

function expectedSubscribersByHarness(snapshot: FlightdeckSnapshot): Record<HarnessKey, number> {
	const out: Record<HarnessKey, number> = { opencode: 0, claude: 0, pi: 0, codex: 0 };
	for (const issue of Object.values(snapshot.master?.issues ?? {})) {
		if (!isActiveIssue(issue)) continue;
		const key = HARNESS_KEY_BY_NAME[issue.harness ?? ""];
		if (key && issueIsAdapterEligible(issue, key)) out[key] += 1;
	}
	return out;
}

function formatSubscriberCounts(theme: Theme, counts: Record<HarnessKey, number>, expected: Record<HarnessKey, number>): string {
	const pairs: Array<{ label: string; key: HarnessKey }> = [
		{ label: "oc", key: "opencode" },
		{ label: "cc", key: "claude" },
		{ label: "pi", key: "pi" },
		{ label: "cx", key: "codex" },
	];
	const parts = pairs.map(({ label, key }) => {
		const actual = counts[key];
		const want = expected[key];
		const tag = want > 0 ? `${label}=${actual}/${want}` : `${label}=${actual}`;
		if (want > 0 && actual < want) return theme.fg("warning", tag);
		if (want > 0 && actual === want) return theme.fg("success", tag);
		return theme.fg("text", tag);
	});
	return parts.join(theme.fg("dim", " "));
}

function shortSubscriberHarnesses(expected: Record<HarnessKey, number>, counts: Record<HarnessKey, number>): Set<HarnessKey> {
	const out = new Set<HarnessKey>();
	for (const key of Object.keys(expected) as HarnessKey[]) {
		if (expected[key] > counts[key]) out.add(key);
	}
	return out;
}

function unsubscribedPanes(snapshot: FlightdeckSnapshot, expected: Record<HarnessKey, number>, counts: Record<HarnessKey, number>): IssueRecord[] {
	// Only surface adapter-eligible issues whose harness is short on
	// subscribers. Panes intentionally on tmux fallback (no adapter
	// metadata recorded) are not surfaced as "unsubscribed" since the
	// daemon never tried to subscribe them in the first place
	// (cross-harness review finding #5).
	const missingHarnesses = shortSubscriberHarnesses(expected, counts);
	if (missingHarnesses.size === 0) return [];
	const out: IssueRecord[] = [];
	for (const issue of Object.values(snapshot.master?.issues ?? {})) {
		if (!isActiveIssue(issue)) continue;
		const key = HARNESS_KEY_BY_NAME[issue.harness ?? ""];
		if (key && missingHarnesses.has(key) && issueIsAdapterEligible(issue, key)) out.push(issue);
	}
	return out;
}

function issueForPane(snapshot: FlightdeckSnapshot, paneId: string): IssueRecord | undefined {
	return Object.values(snapshot.master?.issues ?? {}).find((issue) => issue.pane_id === paneId || issue.pane_target === paneId);
}

function renderDaemonTab(snapshot: FlightdeckSnapshot, ui: PopupUiState, width: number, theme: Theme, viewportRows: number): string[] {
	const lines: string[] = [];
	const d = snapshot.daemon;
	lines.push(`${theme.fg("customMessageLabel", theme.bold("Daemon"))} ${dotIndicator(theme, d.pidAlive)} ${theme.fg("dim", `pid=${d.pid ?? "—"}`)}`);
	lines.push(`${label(theme, "state dir:")} ${theme.fg("text", compactPath(d.stateDir))}`);
	lines.push(`${label(theme, "session:")}   ${theme.fg("text", snapshot.tmux.sessionName)} ${theme.fg("dim", `(${snapshot.tmux.sessionId})`)}`);
	lines.push(`${label(theme, "key:")}       ${theme.fg("text", d.sessionKey ?? "")}`);
	const heartbeatColor = d.heartbeatAgeSec === undefined ? "dim" : d.heartbeatAgeSec < 30 ? "success" : d.heartbeatAgeSec < 120 ? "warning" : "error";
	lines.push(`${label(theme, "heartbeat:")} ${theme.fg(heartbeatColor, formatAge(d.heartbeatAgeSec))}`);
	lines.push(`${label(theme, "busy:")}      ${d.busy ? theme.fg("warning", `master pid=${d.busy.pid ?? "?"} pane=${d.busy.master_pane_id ?? "?"} since ${d.busy.started_at?.slice(11, 19) ?? "?"}`) : theme.fg("success", "free")}`);
	const wp = d.wakePending;
	lines.push(`${label(theme, "wake-pending:")} ${wp ? theme.fg("warning", `${wp.in_flight?.length ?? 0} in-flight since ${wp.delivered_at?.slice(11, 19) ?? "?"}`) : theme.fg("success", "none")}`);
	const counts = d.subscriberCounts;
	const expected = expectedSubscribersByHarness(snapshot);
	lines.push(`${label(theme, "subscribers:")} ${formatSubscriberCounts(theme, counts, expected)}`);
	const shortHarnesses = shortSubscriberHarnesses(expected, counts);
	const liveShortSubscribers = (d.subscribers ?? []).filter((sub) => shortHarnesses.has(sub.harness));
	if (liveShortSubscribers.length > 0) {
		lines.push(`${label(theme, "live subs:")} ${theme.fg("dim", "pids for short harness buckets")}`);
		for (const sub of liveShortSubscribers.slice(0, 8)) {
			const issue = issueForPane(snapshot, sub.paneId);
			const issueLabel = issue?.issue ? `${issue.issue} ` : "";
			lines.push(`   ${theme.fg("dim", "· ")}${theme.fg("text", `${issueLabel}${sub.paneId}`)} ${theme.fg("dim", "·")} ${harnessChip(theme, sub.harness)} ${theme.fg("dim", "·")} ${theme.fg("dim", `pid=${sub.pid}`)}`);
		}
		if (liveShortSubscribers.length > 8) lines.push(`   ${theme.fg("dim", `… ${liveShortSubscribers.length - 8} more`)}`);
	}
	const unsubscribed = unsubscribedPanes(snapshot, expected, counts);
	if (unsubscribed.length > 0) {
		lines.push(`${label(theme, "unsubscribed:")} ${theme.fg("warning", `${unsubscribed.length} tracked pane${unsubscribed.length === 1 ? "" : "s"} without an adapter subscriber`)}`);
		for (const issue of unsubscribed.slice(0, 6)) {
			const hint = issue.pane_target ? `pane ${issue.pane_target}` : "(no pane recorded)";
			lines.push(`   ${theme.fg("dim", "· ")}${theme.fg("text", issue.issue)} ${theme.fg("dim", "·")} ${harnessChip(theme, issue.harness)} ${theme.fg("dim", "·")} ${theme.fg("dim", hint)}`);
		}
		if (unsubscribed.length > 6) lines.push(`   ${theme.fg("dim", `… ${unsubscribed.length - 6} more`)}`);
	}
	if (snapshot.masterStatePath) lines.push(`${label(theme, "master state:")} ${theme.fg("text", compactPath(snapshot.masterStatePath))}`);
	if (snapshot.masterError) lines.push(theme.fg("error", `master read error: ${snapshot.masterError}`));
	lines.push("");
	lines.push(`${theme.fg("customMessageLabel", theme.bold("Daemon log"))} ${theme.fg("dim", `(tail ${(d.logTail ?? []).length} lines)`)}`);
	const logRows = Math.max(4, viewportRows - lines.length);
	const tail = (d.logTail ?? []).slice(-logRows);
	for (const line of tail) lines.push(truncateToWidth(colorizeDaemonLogLine(line, theme), width, ""));
	if (ui.search.trim()) {
		// Search highlight not implemented; treat search as filter for the daemon
		// log only on this tab.
		const q = ui.search.trim().toLowerCase();
		return [searchRow(theme, ui.search, width), "", ...lines.filter((l) => l.toLowerCase().includes(q))];
	}
	return lines;
}

function clampSelection(ui: PopupUiState, total: number, viewportRows: number): void {
	const rows = Math.max(1, viewportRows);
	ui.selected = Math.max(0, Math.min(ui.selected, Math.max(0, total - 1)));
	if (ui.selected < ui.scroll) ui.scroll = ui.selected;
	else if (ui.selected >= ui.scroll + rows) ui.scroll = ui.selected - rows + 1;
	ui.scroll = Math.max(0, Math.min(ui.scroll, Math.max(0, total - rows)));
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function flightdeck(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const cache: DashboardCache = {
		conversations: new Map(),
		state: defaultDashboardState(),
		paneTargetToId: new Map(),
	};
	let activeCtx: ExtensionContext | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let popupTui: { requestRender: () => void } | undefined;

	const refreshSnapshot = (cwd: string): FlightdeckSnapshot | undefined => {
		const snapshot = buildSnapshot(cwd, settingsLike(cwd), {
			logTailLines: Math.max(50, Math.floor(settingNumber("liveFeedLines", 200, cwd))),
			wakeEventsLines: Math.max(50, Math.floor(settingNumber("liveFeedLines", 200, cwd))),
		});
		if (snapshot) {
			const turnsPerPane = Math.max(1, Math.floor(settingNumber("conversationsHistory", 5, cwd)));
			const excerptChars = Math.max(120, Math.floor(settingNumber("conversationExcerptChars", 800, cwd)));
			cache.conversations = foldWakeEventsIntoConversations(cache.conversations, snapshot.wakeEvents, turnsPerPane, excerptChars);
			// Skip the tmux list-panes call entirely when there are no issues
			// to join against. Key the cache by the joined pane_target set so
			// repeated polls with the same issue set reuse the cached map
			// instead of re-shelling tmux every 1.5s (perf review finding #2).
			const issues = snapshot.master ? Object.values(snapshot.master.issues) : [];
			if (issues.length === 0 || !getAgentsBridge()) {
				cache.paneTargetToId = new Map();
			} else {
				const issueKey = issues.map((issue) => issue.pane_target ?? "").sort().join("|");
				cache.paneTargetToId = buildPaneTargetToIdMap(issueKey);
			}
		}
		cache.lastSnapshot = snapshot;
		return snapshot;
	};

	const handlePauseTransition = (ctx: ExtensionContext, snapshot: FlightdeckSnapshot | undefined) => {
		const paused = snapshot?.master?.paused_for_user;
		const issueId = paused?.issue_id;
		if (!paused) {
			cache.pauseSeenIssue = undefined;
			cache.pauseSeenAt = undefined;
			return;
		}
		if (cache.pauseSeenIssue === issueId) return;
		cache.pauseSeenIssue = issueId;
		cache.pauseSeenAt = Date.now();
		if (settingBoolean("pauseBeep", true, ctx.cwd)) process.stdout.write(ANSI_BELL);
		if (settingBoolean("autoOpenOnPause", false, ctx.cwd)) {
			openPopup(pi, ctx).catch(() => undefined);
		}
	};

	const syncWidget = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (!ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = cache.lastSnapshot;
		// Child subagent panes (spawned via pi-agents-tmux) read the same
		// project state as the master coordinator pane, so the dashboard would
		// otherwise render inside every child. Suppress it there; keep the
		// pause banner since a parent pause is still actionable context.
		const inChildPane = Boolean(process.env.PI_SUBAGENT_CHILD_AGENT);
		const showBanner = settingBoolean("pauseBanner", true, ctx.cwd) && Boolean(snapshot?.master?.paused_for_user);
		const dashboardEnabled = !inChildPane && settingBoolean("dashboard", true, ctx.cwd) && cache.state !== "hidden";
		const staleAfterMin = Math.max(0, Math.floor(settingNumber("dashboardStaleAfterMin", 5, ctx.cwd)));
		const status = flightdeckSessionStatus(snapshot, { staleAfterMin });
		if (status === "inactive" && !showBanner) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			invalidate() { /* no-op; we drive renders via setInterval+setWidget */ },
			render(width: number): string[] {
				const lines: string[] = [];
				if (showBanner && snapshot) lines.push(...renderPauseBannerLines(snapshot, theme, width));
				if (dashboardEnabled && snapshot) {
					if (status === "live") {
						if (lines.length > 0) lines.push("");
						lines.push(...renderDashboardLines(snapshot, theme, width, cache.state, ctx.cwd, cache.paneTargetToId));
					} else if (status === "stale") {
						if (lines.length > 0) lines.push("");
						lines.push(...renderStaleHintLine(snapshot, theme, width));
					}
				}
				return lines;
			},
		}), { placement: "aboveEditor" });
	};

	const tick = (ctx: ExtensionContext) => {
		const snapshot = refreshSnapshot(ctx.cwd);
		handlePauseTransition(ctx, snapshot);
		syncWidget(ctx);
		if (popupTui) popupTui.requestRender();
	};

	const startPoller = (ctx: ExtensionContext) => {
		if (poller) clearInterval(poller);
		const interval = pollIntervalMs(ctx.cwd);
		poller = setInterval(() => {
			const live = activeCtx ?? ctx;
			tick(live);
		}, interval);
		// Immediate first tick so the dashboard appears on session start without
		// waiting a full interval.
		tick(ctx);
	};

	const stopPoller = () => {
		if (poller) clearInterval(poller);
		poller = undefined;
	};

	const cycleDashboard = (ctx: ExtensionContext) => {
		cache.state = cache.state === "hidden" ? "compact" : cache.state === "compact" ? "expanded" : "hidden";
		syncWidget(ctx);
		ctx.ui.notify(`Flightdeck dashboard ${cache.state}`, "info");
	};

	async function openPopup(_pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Flightdeck popup requires a TUI; running headless.", "warning");
			return;
		}
		const releaseModal = acquireVstackModalLock();
		const ui = makeInitialPopupState();
		try {
			await ctx.ui.custom((tui, theme, _kb, done) => {
				popupTui = tui;
				return {
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done(undefined);
							return;
						}
						if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "alt+right") || matchesKey(data, "ctrl+l")) {
							const idx = TABS.findIndex((t) => t.id === ui.tab);
							ui.tab = TABS[(idx + 1) % TABS.length].id;
							ui.scroll = 0;
							ui.selected = 0;
							ui.search = "";
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "alt+left") || matchesKey(data, "ctrl+h")) {
							const idx = TABS.findIndex((t) => t.id === ui.tab);
							ui.tab = TABS[(idx - 1 + TABS.length) % TABS.length].id;
							ui.scroll = 0;
							ui.selected = 0;
							ui.search = "";
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "up")) {
							ui.selected = Math.max(0, ui.selected - 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "down")) {
							ui.selected += 1;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "pageUp") || matchesKey(data, "-")) {
							ui.selected = Math.max(0, ui.selected - 10);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "pageDown") || matchesKey(data, "=")) {
							ui.selected += 10;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "home")) {
							ui.selected = 0;
							ui.scroll = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "end")) {
							ui.selected = Number.MAX_SAFE_INTEGER;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "backspace")) {
							ui.search = ui.search.slice(0, -1);
							ui.selected = 0;
							ui.scroll = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "ctrl+u")) {
							ui.search = "";
							ui.selected = 0;
							ui.scroll = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "?")) {
							ui.showHelp = !ui.showHelp;
							tui.requestRender();
							return;
						}
						if (isPlainSearchInput(data)) {
							ui.search += data;
							ui.selected = 0;
							ui.scroll = 0;
							tui.requestRender();
							return;
						}
					},
					invalidate() { /* no-op */ },
					render(width: number) {
						const safeWidth = Math.max(1, width);
						const innerWidth = frameContentWidth(safeWidth);
						const innerRows = Math.max(10, Math.floor(tui.terminal.rows * 0.85) - 6);
						const snapshot = cache.lastSnapshot ?? refreshSnapshot(activePopupCwd(ctx));
						const lines: string[] = [];
						if (!snapshot) {
							lines.push(theme.fg("warning", "Not running inside a tmux session — flightdeck has nothing to show."));
							lines.push(theme.fg("dim", "Run pi from inside the tmux session that hosts flightdeck."));
							return framePopup(lines, safeWidth, theme, "Flightdeck", innerRows);
						}
						lines.push(renderTabBar(ui.tab, innerWidth, theme));
						lines.push("");
						const headerSummary = renderPopupHeader(snapshot, theme, innerWidth);
						lines.push(headerSummary);
						lines.push(divider(innerWidth, theme));
						const tabRows = Math.max(4, innerRows - lines.length - 3);
						let body: string[] = [];
						switch (ui.tab) {
							case TAB_OVERVIEW: body = renderOverviewTab(snapshot, ui, innerWidth, theme, tabRows, cache.paneTargetToId); break;
							case TAB_LIVE: body = renderLiveFeedTab(snapshot, ui, innerWidth, theme, tabRows, activePopupCwd(ctx)); break;
							case TAB_CONVERSATIONS: body = renderConversationsTab(snapshot, cache.conversations, ui, innerWidth, theme, tabRows, activePopupCwd(ctx)); break;
							case TAB_CONFLICTS: body = renderConflictsTab(snapshot, ui, innerWidth, theme); break;
							case TAB_DECISIONS: body = renderDecisionsTab(snapshot, ui, innerWidth, theme, tabRows, activePopupCwd(ctx)); break;
							case TAB_DAEMON: body = renderDaemonTab(snapshot, ui, innerWidth, theme, tabRows); break;
						}
						lines.push(...body);
						const footer = renderPopupFooter(theme, innerWidth, ui);
						const padded = lines.slice(0, innerRows - 2);
						padded.push(divider(innerWidth, theme));
						padded.push(footer);
						return framePopup(padded, safeWidth, theme, " Flightdeck ", innerRows);
					},
				};
			}, { overlay: true, overlayOptions: { anchor: "center", maxHeight: POPUP_MAX_HEIGHT, width: POPUP_WIDTH_PERCENT } });
		} finally {
			popupTui = undefined;
			releaseModal();
		}
	}

	function renderPopupHeader(snapshot: FlightdeckSnapshot, theme: Theme, width: number): string {
		const issues = sortedIssues(snapshot.master);
		const counts: Record<string, number> = {};
		for (const issue of issues) counts[issue.state ?? "?"] = (counts[issue.state ?? "?"] ?? 0) + 1;
		const order: IssueState[] = ["prompting", "merge-ready", "submitting", "waiting", "merged", "aborted", "dead"];
		// Same redundancy-suppression rule as the mini dashboard: when there's
		// exactly one issue the table row already shows the state badge.
		const showStateCounts = issues.length > 1;
		const summary = showStateCounts
			? order.filter((s) => counts[s]).map((s) => theme.fg(stateColor(s), `${stateGlyph(s)} ${counts[s]} ${s}`)).join(theme.fg("dim", "  ·  "))
			: "";
		const queue = snapshot.master?.merge_queue?.length ?? 0;
		const queuePart = queue > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("accent", `merge-queue ${queue}`)}` : "";
		const headerRight = daemonHealthChip(theme, snapshot.daemon.pidAlive, snapshot.daemon.heartbeatAgeSec);
		// tmux session_id ($N) is dropped here — it never changes for the life
		// of the session and visually collides with USD cost strings; the
		// Daemon tab still shows it for diagnostics.
		const sessionLine = `${theme.fg("muted", "session")} ${theme.fg("text", snapshot.tmux.sessionName)}`;
		const left = `${sessionLine}  ${theme.fg("dim", "·")}  ${theme.fg("muted", `${issues.length} issue${issues.length === 1 ? "" : "s"}`)}${summary ? `  ${theme.fg("dim", "·")}  ${summary}` : ""}${queuePart}`;
		const padded = pad(left, Math.max(0, width - visibleWidth(headerRight) - 2));
		return truncateToWidth(`${padded}  ${headerRight}`, width, "");
	}

	function renderPopupFooter(theme: Theme, _width: number, ui: PopupUiState): string {
		const tabHint = `${ansiYellow("tab")} ${theme.fg("dim", "next tab · ")}${ansiYellow("shift+tab")} ${theme.fg("dim", "prev")}`;
		const navHint = `${ansiYellow("↑/↓")} ${theme.fg("dim", "select · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("home/end")} ${theme.fg("dim", "ends")}`;
		const searchHint = ui.search ? `${ansiYellow("ctrl+u")} ${theme.fg("dim", "clear search")}` : `${theme.fg("dim", "type to filter")}`;
		const closeHint = `${ansiYellow("esc")} ${theme.fg("dim", "close")}`;
		return `${tabHint}  ${theme.fg("dim", "·")}  ${navHint}  ${theme.fg("dim", "·")}  ${searchHint}  ${theme.fg("dim", "·")}  ${closeHint}`;
	}

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		startPoller(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		// Force a refresh on tree changes (e.g., resume).
		tick(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopPoller();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	// React to settings changes — clear cache so next tick reflects new values.
	pi.events.on(SETTINGS_EVENT, (_payload: unknown) => {
		const ctx = activeCtx;
		if (!ctx) return;
		if (cache.state === "hidden" && settingBoolean("dashboard", true, ctx.cwd)) {
			cache.state = defaultDashboardState(ctx.cwd);
		}
		tick(ctx);
	});

	pi.registerCommand("flightdeck", {
		description: "Open the flightdeck mission-control popup.",
		handler: async (_args, ctx) => openPopup(pi, ctx),
	});
	pi.registerCommand("flightdeck:toggle", {
		description: "Cycle the persistent flightdeck dashboard widget hidden → compact → expanded.",
		handler: async (_args, ctx) => cycleDashboard(ctx as ExtensionContext),
	});

	const popupShortcut = settingString("popupShortcut", "f6");
	if (popupShortcut !== "none") {
		pi.registerShortcut(popupShortcut as Parameters<typeof pi.registerShortcut>[0], {
			description: "Open the flightdeck mission-control popup",
			handler: async (ctx) => openPopup(pi, ctx as ExtensionContext),
		});
	}
	const dashboardShortcut = settingString("dashboardShortcut", "alt+m");
	if (dashboardShortcut !== "none") {
		pi.registerShortcut(dashboardShortcut as Parameters<typeof pi.registerShortcut>[0], {
			description: "Cycle the flightdeck dashboard widget",
			handler: async (ctx) => cycleDashboard(ctx as ExtensionContext),
		});
	}
}
