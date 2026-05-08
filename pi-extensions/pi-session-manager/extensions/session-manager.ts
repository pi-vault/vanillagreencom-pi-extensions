import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-session-manager.installed");
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
const PACKAGE_ID = "@vanillagreen/pi-session-manager";
const LEGACY_STATUS_KEY = "session-manager";
const DEFAULT_SHORTCUT = "f1";
const DEFAULT_WIDTH = 112;
const DEFAULT_ROWS = 12;
const POPUP_HEIGHT_RATIO = 0.9;
const POPUP_PADDING_X = 2;
const POPUP_PADDING_Y = 1;
const POPUP_MARGIN_ROWS = 1;
const ROW_META_MAX_WIDTH = 44;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_RED_FG = "\x1b[31m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

function ansiGreen(text: string): string { return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`; }
function ansiRed(text: string): string { return `${ANSI_RED_FG}${text}${ANSI_FG_RESET}`; }
function ansiYellow(text: string): string { return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`; }

function padAnsi(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = truncateToWidth(text, safeWidth, "");
	return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

function centerAnsi(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = truncateToWidth(text, safeWidth, "");
	const left = Math.max(0, Math.floor((safeWidth - visibleWidth(clipped)) / 2));
	return `${" ".repeat(left)}${clipped}`;
}

type SessionInfo = Awaited<ReturnType<typeof SessionManager.list>>[number];
type Scope = "current" | "all";
type SortMode = "threaded" | "recent" | "relevance";
type NameFilter = "all" | "named";
type Mode = "browse" | "loading" | "rename" | "confirm-delete" | "confirm-delete-all" | "deleting";

type SessionAction = { type: "resume"; path: string; title: string; keepCurrentModel?: boolean } | { type: "cancel" };
type SessionManagerContext = ExtensionCommandContext | ExtensionContext;
const pendingSessionManagerActions = new Map<string, SessionAction>();
let pendingSessionManagerActionCounter = 0;

function pinSessionModel(sessionPath: string, model: NonNullable<ExtensionContext["model"]>, thinkingLevel?: string): void {
	const manager = SessionManager.open(sessionPath);
	const context = manager.buildSessionContext();
	if (context.model?.provider !== model.provider || context.model?.modelId !== model.id) {
		manager.appendModelChange(model.provider, model.id);
	}
	if (thinkingLevel) {
		const branch = manager.getBranch();
		const lastThinking = [...branch].reverse().find((entry: any) => entry?.type === "thinking_level_change") as { thinkingLevel?: string } | undefined;
		if (lastThinking?.thinkingLevel !== thinkingLevel) manager.appendThinkingLevelChange(thinkingLevel as any);
	}
}

interface VstackModalLock {
	depth: number;
}

interface SearchToken {
	kind: "fuzzy" | "phrase";
	value: string;
}

interface ParsedQuery {
	mode: "tokens" | "regex";
	tokens: SearchToken[];
	regex?: RegExp;
	error?: string;
}

interface MatchResult {
	matches: boolean;
	score: number;
}

interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
	score: number;
	snippet?: string;
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
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function piSettingsPaths(cwd = process.cwd()): string[] {
	const userDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
	return [join(userDir, "settings.json"), projectSettingsPath(cwd)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = asRecord(asRecord(asRecord(parsed?.vstack)?.extensionManager)?.config)?.[PACKAGE_ID];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional settings.
		}
	}
	return merged;
}

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function settingStringAllowEmpty(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value.trim() : fallback;
}

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function settingScope(cwd?: string): Scope {
	return settingString("defaultScope", "current", cwd).toLowerCase() === "all" ? "all" : "current";
}

function settingSort(cwd?: string): SortMode {
	const value = settingString("defaultSort", "threaded", cwd).toLowerCase();
	return value === "recent" || value === "relevance" ? value : "threaded";
}

function configuredShortcut(cwd?: string): string | undefined {
	const shortcut = settingStringAllowEmpty("shortcutKey", DEFAULT_SHORTCUT, cwd).trim().toLowerCase();
	if (!shortcut || shortcut === "none" || shortcut === "off" || shortcut === "false") return undefined;
	if (shortcut === "alt+shift+r" || shortcut === "ctrl+shift+r") return DEFAULT_SHORTCUT;
	return shortcut;
}

function resolveSettingsRelativePath(value: string, settingsPath: string): string {
	const expanded = expandHome(value.trim());
	return isAbsolute(expanded) ? expanded : resolve(dirname(settingsPath), expanded);
}

function configuredSessionDir(cwd: string): string | undefined {
	const envDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
	if (envDir) return resolveSettingsRelativePath(envDir, join(resolve(cwd), ".pi", "settings.json"));
	let configured: string | undefined;
	for (const settingsPath of piSettingsPaths(cwd)) {
		if (!existsSync(settingsPath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (typeof parsed?.sessionDir === "string" && parsed.sessionDir.trim()) {
				configured = resolveSettingsRelativePath(parsed.sessionDir, settingsPath);
			}
		} catch {
			// Ignore malformed optional settings.
		}
	}
	return configured;
}

function canonicalPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return canonicalPath(a) === canonicalPath(b);
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
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

function oneLine(value: unknown, fallback = ""): string {
	const text = typeof value === "string" ? value : fallback;
	return stripAnsi(text)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function shortenPath(path: string): string {
	const cleaned = oneLine(path);
	const home = homedir();
	if (!cleaned) return "";
	if (cleaned === home) return "~";
	if (cleaned.startsWith(`${home}/`)) return `~${cleaned.slice(home.length)}`;
	const parts = cleaned.split(/[\\/]+/).filter(Boolean);
	return parts.length <= 4 ? cleaned : `…/${parts.slice(-4).join("/")}`;
}

function formatAge(date: Date): string {
	const diffMs = Math.max(0, Date.now() - date.getTime());
	const mins = Math.floor(diffMs / 60_000);
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function sessionFallbackName(session: SessionInfo): string {
	const file = basename(session.path || "session", ".jsonl");
	return oneLine(file, "session") || "session";
}

function sessionResumeTitle(session: SessionInfo): string {
	const name = oneLine(session.name);
	if (name) return name;
	const first = oneLine(session.firstMessage);
	if (first && first !== "(no messages)") return first;
	return sessionFallbackName(session);
}

function sessionSearchText(session: SessionInfo): string {
	return [
		session.id,
		session.name ?? "",
		session.cwd,
		session.path,
		session.firstMessage,
		session.allMessagesText,
	]
		.map((part) => oneLine(part))
		.join("\n");
}

function normalizeSearchText(text: string): string {
	return oneLine(text).toLowerCase();
}

function parseQuery(query: string): ParsedQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [] };

	if (trimmed.startsWith("re:")) {
		const source = trimmed.slice(3).trim();
		if (!source) return { mode: "regex", tokens: [], error: "Empty regex" };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(source, "i") };
		} catch (error) {
			return { mode: "regex", tokens: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	const tokens: SearchToken[] = [];
	let buffer = "";
	let inQuote = false;
	let unclosed = false;
	const flush = (kind: "fuzzy" | "phrase") => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}
		buffer += ch;
	}

	if (inQuote) unclosed = true;
	if (unclosed) {
		return {
			mode: "tokens",
			tokens: trimmed.split(/\s+/).filter(Boolean).map((value) => ({ kind: "fuzzy", value })),
		};
	}

	flush("fuzzy");
	return { mode: "tokens", tokens };
}

function simpleFuzzyScore(needle: string, haystack: string): number | undefined {
	const query = needle.toLowerCase();
	const text = haystack.toLowerCase();
	if (!query) return 0;
	const direct = text.indexOf(query);
	if (direct >= 0) return direct * 0.1;
	let pos = 0;
	let score = 1000;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found < 0) return undefined;
		score += found - pos + 1;
		pos = found + 1;
	}
	return score;
}

function matchSession(session: SessionInfo, parsed: ParsedQuery): MatchResult {
	const text = sessionSearchText(session);
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const index = text.search(parsed.regex);
		return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
	}
	if (parsed.tokens.length === 0) return { matches: true, score: 0 };

	let score = 0;
	let normalized: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			normalized ??= normalizeSearchText(text);
			const phrase = normalizeSearchText(token.value);
			const index = normalized.indexOf(phrase);
			if (index < 0) return { matches: false, score: 0 };
			score += index * 0.1;
			continue;
		}
		const tokenScore = simpleFuzzyScore(token.value, text);
		if (tokenScore === undefined) return { matches: false, score: 0 };
		score += tokenScore;
	}
	return { matches: true, score };
}

function snippetSource(session: SessionInfo): string {
	return oneLine(session.allMessagesText || session.firstMessage || "");
}

function snippetAround(text: string, start: number, length: number, width: number): string {
	const safeStart = Math.max(0, start - Math.floor(width / 3));
	const safeEnd = Math.min(text.length, start + length + Math.floor((width * 2) / 3));
	const prefix = safeStart > 0 ? "…" : "";
	const suffix = safeEnd < text.length ? "…" : "";
	return `${prefix}${text.slice(safeStart, safeEnd)}${suffix}`;
}

function buildSnippet(session: SessionInfo, parsed: ParsedQuery): string | undefined {
	const source = snippetSource(session);
	if (!source) return undefined;
	if (parsed.mode === "regex" && parsed.regex) {
		parsed.regex.lastIndex = 0;
		const match = parsed.regex.exec(source);
		return match ? snippetAround(source, match.index, match[0].length, 180) : undefined;
	}
	if (parsed.mode === "tokens") {
		const lower = source.toLowerCase();
		for (const token of parsed.tokens) {
			const value = normalizeSearchText(token.value);
			if (!value) continue;
			const index = lower.indexOf(value.toLowerCase());
			if (index >= 0) return snippetAround(source, index, value.length, 180);
		}
	}
	return source.slice(0, 180);
}

function styleSearchMatches(text: string, query: string): string {
	let styled = text;
	const parsed = parseQuery(query);
	if (parsed.mode !== "tokens") return styled;
	for (const token of parsed.tokens) {
		const value = token.value.trim();
		if (!value || value.length > 80) continue;
		try {
			styled = styled.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (match) => ansiRed(match));
		} catch {
			// Keep unstyled text if a token cannot be highlighted safely.
		}
	}
	return styled;
}

function isNamed(session: SessionInfo): boolean {
	return oneLine(session.name).length > 0;
}

interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();
	for (const session of sessions) {
		const key = canonicalPath(session.path) ?? session.path;
		byPath.set(key, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];
	for (const session of sessions) {
		const key = canonicalPath(session.path) ?? session.path;
		const node = byPath.get(key)!;
		const parent = canonicalPath(session.parentSessionPath);
		if (parent && byPath.has(parent)) byPath.get(parent)!.children.push(node);
		else roots.push(node);
	}

	const sortNodes = (nodes: SessionTreeNode[]) => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) sortNodes(node.children);
	};
	sortNodes(roots);
	return roots;
}

function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];
	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
		result.push({ session: node.session, depth, isLast, ancestorContinues, score: 0 });
		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};
	for (let i = 0; i < roots.length; i++) walk(roots[i]!, 0, [], i === roots.length - 1);
	return result;
}

function rowTreePrefix(node: FlatSessionNode): string {
	if (node.depth === 0) return "";
	const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
	return parts.join("") + (node.isLast ? "└─ " : "├─ ");
}

function appendSessionInfoFallback(sessionPath: string, name: string): void {
	const ids = new Set<string>();
	let parentId: string | null = null;
	try {
		const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { type?: string; id?: string };
			if (entry.type === "session") continue;
			if (typeof entry.id === "string") {
				ids.add(entry.id);
				parentId = entry.id;
			}
		}
	} catch {
		// If parsing fails, still append a valid standalone session_info entry.
	}

	let id = randomUUID().slice(0, 8);
	while (ids.has(id)) id = randomUUID().slice(0, 8);
	appendFileSync(sessionPath, `${JSON.stringify({ type: "session_info", id, parentId, timestamp: new Date().toISOString(), name: name.trim() })}\n`);
}

function renameSession(path: string, name: string): void {
	try {
		SessionManager.open(path).appendSessionInfo(name);
	} catch {
		appendSessionInfoFallback(path, name);
	}
}

async function deleteSessionFile(sessionPath: string, cwd: string): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	if (settingBoolean("deleteUsesTrash", true, cwd)) {
		const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
		const trashResult = spawnSync("trash", trashArgs, { encoding: "utf8" });
		if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
}

async function loadSessionsForScope(cwd: string, scope: Scope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
	const customSessionDir = configuredSessionDir(cwd);
	if (customSessionDir) {
		const sessions = await SessionManager.list(cwd, customSessionDir, onProgress);
		if (scope === "all") return sessions;
		const current = canonicalPath(cwd);
		return sessions.filter((session) => canonicalPath(session.cwd) === current);
	}
	return scope === "all" ? SessionManager.listAll(onProgress) : SessionManager.list(cwd, undefined, onProgress);
}

function clearLegacySessionStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
}

class SessionManagerOverlay implements Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
		this.renameInput.focused = value;
	}

	private mode: Mode = "loading";
	private sessions: SessionInfo[] = [];
	private filtered: FlatSessionNode[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private searchInput = new Input();
	private renameInput = new Input();
	private renameTarget: SessionInfo | undefined;
	private deleteTarget: SessionInfo | undefined;
	private deleteAllTargets: SessionInfo[] = [];
	private deleteConfirmSelection: 0 | 1 = 0;
	private notice: { kind: "info" | "error"; text: string } | undefined;
	private queryError: string | undefined;
	private loadingProgress: { loaded: number; total: number } | undefined;
	private loadSeq = 0;
	private scope: Scope;
	private sortMode: SortMode;
	private nameFilter: NameFilter = "all";
	private currentSessionPath: string | undefined;

	constructor(
		private readonly ctx: SessionManagerContext,
		private readonly pi: ExtensionAPI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (action: SessionAction) => void,
		private readonly tui: { requestRender(): void; terminal?: { rows?: number } },
		initialScope?: Scope,
	) {
		this.scope = initialScope ?? settingScope(ctx.cwd);
		this.sortMode = settingSort(ctx.cwd);
		this.currentSessionPath = ctx.sessionManager.getSessionFile();
		this.searchInput.focused = true;
		this.renameInput.onSubmit = (value) => void this.commitRename(value);
		void this.reload();
	}

	private get visibleRows(): number {
		const configured = Math.max(1, Math.min(30, Math.floor(settingNumber("visibleRows", DEFAULT_ROWS, this.ctx.cwd))));
		return Math.min(configured, this.responsiveVisibleRows());
	}

	private maxPopupRows(): number {
		const terminalRows = Number(this.tui.terminal?.rows ?? process.stdout.rows ?? 30);
		const safeRows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 30;
		return Math.max(1, Math.floor(safeRows * POPUP_HEIGHT_RATIO) - POPUP_MARGIN_ROWS * 2);
	}

	private footerRowCount(): number {
		return this.mode === "confirm-delete" || this.mode === "confirm-delete-all" || this.mode === "rename" ? 1 : 2;
	}

	private detailRowCount(): number {
		const selectedNode = this.filtered[this.selectedIndex];
		if (!selectedNode?.session) return 1;
		const hasMatchSnippet = Boolean(oneLine(this.searchInput.getValue()) && selectedNode.snippet);
		return hasMatchSnippet ? 3 : 2;
	}

	private responsiveVisibleRows(): number {
		// Fixed chrome around the scrollable session list:
		// top/bottom borders, padding, tabs, search/subheader, dividers, detail pane,
		// blank footer spacer, and footer help. The list is the only section that
		// should shrink on shorter terminals; allow it to collapse all the way to 1 row.
		const chromeRows = 11 + this.detailRowCount() + this.footerRowCount();
		return Math.max(1, this.maxPopupRows() - chromeRows);
	}

	private notify(kind: "info" | "error", text: string): void {
		this.notice = { kind, text: oneLine(text) };
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		this.mode = "loading";
		this.loadingProgress = undefined;
		this.requestRender();
		try {
			const sessions = await loadSessionsForScope(this.ctx.cwd, this.scope, (loaded, total) => {
				if (seq !== this.loadSeq) return;
				this.loadingProgress = { loaded, total };
				this.requestRender();
			});
			if (seq !== this.loadSeq) return;
			this.sessions = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			this.mode = "browse";
			this.applyFilter(false);
		} catch (error) {
			if (seq !== this.loadSeq) return;
			this.sessions = [];
			this.mode = "browse";
			this.notify("error", `Failed to load sessions: ${error instanceof Error ? error.message : String(error)}`);
			this.applyFilter(false);
		}
		this.requestRender();
	}

	private selected(): SessionInfo | undefined {
		return this.filtered[this.selectedIndex]?.session;
	}

	private isCurrent(session: SessionInfo): boolean {
		return samePath(session.path, this.currentSessionPath);
	}

	private applyFilter(resetSelection = true): void {
		const query = this.searchInput.getValue().trim();
		const parsed = parseQuery(query);
		this.queryError = parsed.error;
		const base = this.nameFilter === "named" ? this.sessions.filter(isNamed) : [...this.sessions];

		if (parsed.error) {
			this.filtered = [];
		} else if (!query && this.sortMode === "threaded") {
			this.filtered = flattenSessionTree(buildSessionTree(base));
		} else {
			const nodes: FlatSessionNode[] = [];
			for (const session of base) {
				const match = matchSession(session, parsed);
				if (!match.matches) continue;
				nodes.push({ session, depth: 0, isLast: true, ancestorContinues: [], score: match.score, snippet: buildSnippet(session, parsed) });
			}
			nodes.sort((a, b) => {
				if (this.sortMode === "recent" || !query) return b.session.modified.getTime() - a.session.modified.getTime();
				return a.score - b.score || b.session.modified.getTime() - a.session.modified.getTime();
			});
			this.filtered = nodes;
		}
		if (this.nameFilter === "named") this.filtered = this.filtered.filter((node) => isNamed(node.session));

		if (resetSelection) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
		}
		this.syncSelection();
	}

	private syncSelection(): void {
		if (this.filtered.length === 0) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filtered.length - 1));
		const rows = this.visibleRows;
		const maxScroll = Math.max(0, this.filtered.length - rows);
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		else if (this.selectedIndex >= this.scrollOffset + rows) this.scrollOffset = this.selectedIndex - rows + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
	}

	private moveSelection(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, this.filtered.length - 1));
		this.syncSelection();
	}

	private setSelection(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.filtered.length - 1)));
		this.syncSelection();
	}

	private startRename(session: SessionInfo): void {
		this.renameTarget = session;
		this.renameInput = new Input();
		this.renameInput.focused = this.focused;
		this.renameInput.setValue(oneLine(session.name) || sessionResumeTitle(session));
		this.renameInput.onSubmit = (value) => void this.commitRename(value);
		this.mode = "rename";
		this.notice = undefined;
	}

	private async commitRename(value: string): Promise<void> {
		const target = this.renameTarget;
		if (!target) return;
		const next = oneLine(value);
		try {
			if (this.isCurrent(target)) {
				this.pi.setSessionName(next);
				clearLegacySessionStatus(this.ctx);
			} else {
				renameSession(target.path, next);
			}
			this.notify("info", next ? `Renamed to “${next}”` : "Cleared session name");
			this.mode = "browse";
			this.renameTarget = undefined;
			await this.reload();
		} catch (error) {
			this.mode = "browse";
			this.renameTarget = undefined;
			this.notify("error", `Rename failed: ${error instanceof Error ? error.message : String(error)}`);
			this.requestRender();
		}
	}

	private cancelModalMode(): void {
		this.mode = "browse";
		this.renameTarget = undefined;
		this.deleteTarget = undefined;
		this.deleteAllTargets = [];
		this.deleteConfirmSelection = 0;
	}

	private startDelete(session: SessionInfo): void {
		if (this.isCurrent(session)) {
			this.notify("error", "Cannot delete the current active session");
			return;
		}
		this.deleteTarget = session;
		this.deleteConfirmSelection = 0;
		this.mode = "confirm-delete";
		this.notice = undefined;
	}

	private async confirmDelete(): Promise<void> {
		const target = this.deleteTarget;
		if (!target) return;
		this.mode = "deleting";
		this.requestRender();
		const result = await deleteSessionFile(target.path, this.ctx.cwd);
		if (result.ok) {
			this.sessions = this.sessions.filter((session) => !samePath(session.path, target.path));
			this.mode = "browse";
			this.deleteTarget = undefined;
			this.notify("info", result.method === "trash" ? "Session moved to trash" : "Session deleted");
			this.applyFilter(false);
		} else {
			this.mode = "browse";
			this.deleteTarget = undefined;
			this.notify("error", `Delete failed: ${result.error ?? "unknown error"}`);
		}
		this.requestRender();
	}

	private startDeleteAll(): void {
		const seen = new Set<string>();
		const targets: SessionInfo[] = [];
		for (const node of this.filtered) {
			const session = node.session;
			if (this.isCurrent(session)) continue;
			const key = canonicalPath(session.path) ?? session.path;
			if (seen.has(key)) continue;
			seen.add(key);
			targets.push(session);
		}
		if (targets.length === 0) {
			this.notify("error", "No deletable sessions in the current view");
			return;
		}
		this.deleteAllTargets = targets;
		this.deleteTarget = undefined;
		this.deleteConfirmSelection = 0;
		this.mode = "confirm-delete-all";
		this.notice = undefined;
	}

	private async confirmDeleteAll(): Promise<void> {
		const targets = this.deleteAllTargets;
		if (targets.length === 0) return;
		this.mode = "deleting";
		this.requestRender();
		let deleted = 0;
		let trashed = 0;
		const failures: string[] = [];
		for (const target of targets) {
			if (this.isCurrent(target)) continue;
			const result = await deleteSessionFile(target.path, this.ctx.cwd);
			if (result.ok) {
				deleted += 1;
				if (result.method === "trash") trashed += 1;
				this.sessions = this.sessions.filter((session) => !samePath(session.path, target.path));
			} else {
				failures.push(`${sessionResumeTitle(target)}: ${result.error ?? "unknown error"}`);
			}
		}
		this.mode = "browse";
		this.deleteAllTargets = [];
		if (failures.length > 0) {
			this.notify("error", `Deleted ${deleted}; failed ${failures.length}: ${failures[0]}`);
		} else {
			this.notify("info", trashed > 0 ? `${deleted} sessions moved to trash` : `${deleted} sessions deleted`);
		}
		this.applyFilter(false);
		this.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "rename") {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.cancelModalMode();
				this.requestRender();
				return;
			}
			this.renameInput.handleInput(data);
			this.requestRender();
			return;
		}

		if (this.mode === "confirm-delete" || this.mode === "confirm-delete-all") {
			if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "up") || matchesKey(data, "down")) {
				this.deleteConfirmSelection = this.deleteConfirmSelection === 0 ? 1 : 0;
				this.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || matchesKey(data, "return")) {
				if (this.deleteConfirmSelection === 1) {
					this.cancelModalMode();
					this.requestRender();
					return;
				}
				if (this.mode === "confirm-delete-all") void this.confirmDeleteAll();
				else void this.confirmDelete();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "backspace") || matchesKey(data, "escape")) {
				this.cancelModalMode();
				this.requestRender();
				return;
			}
			return;
		}

		if (this.mode === "deleting" || this.mode === "loading") {
			if (this.keybindings.matches(data, "tui.select.cancel")) this.done({ type: "cancel" });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.applyFilter();
				this.requestRender();
				return;
			}
			this.done({ type: "cancel" });
			return;
		}

		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "current" ? "all" : "current";
			this.searchInput.setValue("");
			void this.reload();
			return;
		}

		if (matchesKey(data, "alt+s") || this.keybindings.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
			this.applyFilter();
			this.requestRender();
			return;
		}

		if (matchesKey(data, "alt+n") || this.keybindings.matches(data, "app.session.toggleNamedFilter")) {
			this.nameFilter = this.nameFilter === "all" ? "named" : "all";
			this.applyFilter();
			this.requestRender();
			return;
		}

		if (matchesKey(data, "alt+r") || this.keybindings.matches(data, "app.session.rename")) {
			const selected = this.selected();
			if (selected) this.startRename(selected);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "alt+d") || this.keybindings.matches(data, "app.session.delete")) {
			const selected = this.selected();
			if (selected) this.startDelete(selected);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "alt+x") || matchesKey(data, "ctrl+x")) {
			this.startDeleteAll();
			this.requestRender();
			return;
		}

		if (matchesKey(data, "alt+m")) {
			const selected = this.selected();
			if (selected) this.done({ type: "resume", path: selected.path, title: sessionResumeTitle(selected), keepCurrentModel: true });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.selected();
			if (selected) this.done({ type: "resume", path: selected.path, title: sessionResumeTitle(selected) });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "-") || this.keybindings.matches(data, "tui.select.pageUp")) {
			this.setSelection(this.selectedIndex - this.visibleRows);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "=") || this.keybindings.matches(data, "tui.select.pageDown")) {
			this.setSelection(this.selectedIndex + this.visibleRows);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.setSelection(0);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.setSelection(this.filtered.length - 1);
			this.requestRender();
			return;
		}

		this.searchInput.handleInput(data);
		this.applyFilter();
		this.requestRender();
	}

	render(width: number): string[] {
		const configured = Math.max(72, Math.floor(settingNumber("overlayWidth", DEFAULT_WIDTH, this.ctx.cwd)));
		const renderWidth = Math.min(Math.max(48, width), configured);
		const frameInner = Math.max(10, renderWidth - 2);
		const bodyWidth = Math.max(10, frameInner - POPUP_PADDING_X * 2);
		const th = this.theme;
		const border = (s: string) => th.fg("borderAccent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const accent = (s: string) => th.fg("accent", s);
		const warning = (s: string) => th.fg("warning", s);
		const error = (s: string) => th.fg("error", s);
		const success = (s: string) => th.fg("success", s);

		const fixed = (content = "", rowWidth = bodyWidth): string => {
			const safe = content.replace(/[\r\n\t]+/g, " ");
			const clipped = truncateToWidth(safe, rowWidth, "");
			return clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
		};
		const top = (title: string, right = "") => {
			const rightPlain = right ? ` ${right} ` : "";
			const titleBudget = Math.max(1, frameInner - visibleWidth(rightPlain) - 1);
			const titlePlain = ` ${truncateToWidth(title, Math.max(1, titleBudget - 2), "…")} `;
			const fill = Math.max(1, frameInner - visibleWidth(titlePlain) - visibleWidth(rightPlain));
			return `${border("┏")}${ansiGreen(titlePlain)}${border("━".repeat(fill))}${right ? dim(rightPlain) : ""}${border("┓")}`;
		};
		const blank = () => border("┃") + " ".repeat(frameInner) + border("┃");
		const row = (content = "") => border("┃") + " ".repeat(POPUP_PADDING_X) + fixed(content) + " ".repeat(POPUP_PADDING_X) + border("┃");
		const filledRow = (content = "") => border("┃") + " ".repeat(POPUP_PADDING_X) + th.bg("toolPendingBg", fixed(content)) + " ".repeat(POPUP_PADDING_X) + border("┃");
		const divider = () => row(muted("━".repeat(bodyWidth)));
		const lines: string[] = [];

		lines.push(top("Session Manager", `${this.filtered.length}/${this.sessions.length} shown`));
		for (let i = 0; i < POPUP_PADDING_Y; i++) lines.push(blank());
		lines.push(row(this.renderScopeTabs(bodyWidth)));
		lines.push(row(""));

		if (this.mode === "confirm-delete" || this.mode === "confirm-delete-all") {
			const rowsBeforeConfirmBody = 1 + POPUP_PADDING_Y + 2;
			const rowsAfterConfirmBody = POPUP_PADDING_Y + 1;
			const targetRows = Math.max(10, this.maxPopupRows() - rowsBeforeConfirmBody - rowsAfterConfirmBody);
			lines.push(...this.renderDeleteConfirmationRows(bodyWidth, targetRows, { row, dim, muted, accent, warning, error, border }));
			for (let i = 0; i < POPUP_PADDING_Y; i++) lines.push(blank());
			lines.push(border(`┗${"━".repeat(frameInner)}┛`));
			return lines.map((line) => truncateToWidth(line, renderWidth, ""));
		}

		lines.push(row(this.renderSubheader(bodyWidth, accent, muted, dim, warning, error)));
		lines.push(filledRow(this.renderSearch(bodyWidth, dim)));
		lines.push(divider());

		if (this.mode === "loading") {
			const progress = this.loadingProgress ? ` ${this.loadingProgress.loaded}/${this.loadingProgress.total}` : "";
			lines.push(row(dim(`Loading sessions${progress}…`)));
			for (let i = 1; i < this.visibleRows; i++) lines.push(row(""));
		} else {
			lines.push(...this.renderListRows(bodyWidth, { row, fixed, dim, muted, accent, warning, error }));
		}

		lines.push(divider());
		lines.push(...this.renderDetailRows(bodyWidth, { row, fixed, dim, muted, accent, warning, error, success }));
		lines.push(row(""));
		for (const footerLine of this.renderFooter(bodyWidth, dim, warning, error)) lines.push(row(footerLine));
		for (let i = 0; i < POPUP_PADDING_Y; i++) lines.push(blank());
		lines.push(border(`┗${"━".repeat(frameInner)}┛`));
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}

	private renderDeleteConfirmationRows(
		inner: number,
		targetRows: number,
		ui: {
			row: (content?: string) => string;
			dim: (s: string) => string;
			muted: (s: string) => string;
			accent: (s: string) => string;
			warning: (s: string) => string;
			error: (s: string) => string;
			border: (s: string) => string;
		},
	): string[] {
		const deleteAll = this.mode === "confirm-delete-all";
		const target = deleteAll ? undefined : this.deleteTarget;
		const boxWidth = Math.max(1, Math.min(inner, Math.max(32, Math.min(74, inner - 18))));
		const boxInner = Math.max(1, boxWidth - 4);
		const centeredBoxLine = (line: string) => `${" ".repeat(Math.max(0, Math.floor((inner - boxWidth) / 2)))}${line}`;
		const top = () => {
			const label = " Confirm delete ";
			const fill = Math.max(1, boxWidth - 2 - visibleWidth(label));
			return `${ui.error("┏")}${ansiRed(label)}${ui.error("━".repeat(fill))}${ui.error("┓")}`;
		};
		const bottom = () => ui.error(`┗${"━".repeat(Math.max(0, boxWidth - 2))}┛`);
		const boxRow = (content = "") => `${ui.error("┃ ")}${padAnsi(content, boxInner)}${ui.error(" ┃")}`;
		const boxDivider = () => `${ui.error("┃ ")}${ui.muted("─".repeat(boxInner))}${ui.error(" ┃")}`;

		const subject = deleteAll
			? `${this.deleteAllTargets.length} shown deletable sessions`
			: target
				? `“${truncateToWidth(sessionResumeTitle(target), Math.max(8, boxInner - 2), "…")}”`
				: "selected session";
		const scope = this.scope === "current" ? "current project" : "all sessions";
		const search = oneLine(this.searchInput.getValue());
		const context = `${scope}${search ? ` · query “${truncateToWidth(search, 20, "…")}”` : ""}`;
		const optionRow = (index: 0 | 1, label: string) => {
			const selected = this.deleteConfirmSelection === index;
			const prefix = selected ? "› " : "  ";
			const content = `${ui.warning(prefix)}${index === 0 ? ui.error(label) : ui.dim(label)}`;
			const padded = padAnsi(content, boxInner);
			return selected ? this.theme.bg(index === 0 ? "toolErrorBg" : "selectedBg", padded) : padded;
		};

		const boxLines = [
			top(),
			boxRow(centerAnsi(ui.error(this.theme.bold(deleteAll ? "Delete sessions?" : "Delete session?")), boxInner)),
			boxRow(centerAnsi(ui.accent(subject), boxInner)),
			boxRow(""),
			boxRow(ui.warning("This removes the session file.")),
			boxRow(ui.dim("If trash is unavailable, deletion is permanent.")),
			...(deleteAll ? [boxRow(ui.dim(truncateToWidth(context, boxInner, "…")))] : []),
			boxDivider(),
			boxRow(optionRow(0, deleteAll ? "Delete all shown sessions" : "Delete this session")),
			boxRow(optionRow(1, "Go back to previous screen")),
			bottom(),
		];

		const bodyRows = Math.max(boxLines.length, targetRows);
		const topPad = Math.max(0, Math.floor((bodyRows - boxLines.length) / 2));
		const lines: string[] = [];
		for (let i = 0; i < topPad; i++) lines.push(ui.row(""));
		for (const line of boxLines) lines.push(ui.row(centeredBoxLine(line)));
		while (lines.length < bodyRows) lines.push(ui.row(""));
		return lines;
	}

	private renderHeader(inner: number, accent: (s: string) => string, muted: (s: string) => string): string {
		const title = accent(this.theme.bold(" Session Manager")); // nf-fa-star
		const sortText = `${muted("sort:")} ${accent(this.sortMode)}`;
		const nameText = `${muted("names:")} ${accent(this.nameFilter)}`;
		const right = `${sortText}  ${nameText}`;
		const available = Math.max(0, inner - visibleWidth(right) - 1);
		const left = truncateToWidth(title, available, "");
		return left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right))) + right;
	}

	private renderScopeTabs(inner: number): string {
		const tabs: { id: Scope; label: string }[] = [
			{ id: "current", label: "Current" },
			{ id: "all", label: "All" },
		];
		const parts = tabs.map((tab) => {
			const label = ` ${truncateToWidth(tab.label, 18, "…")} `;
			if (tab.id === this.scope) return this.theme.fg("accent", this.theme.inverse(this.theme.bold(label)));
			return this.theme.bg("selectedBg", this.theme.fg("accent", label));
		});
		return truncateToWidth(parts.join(" "), inner, "");
	}

	private renderSubheader(inner: number, accent: (s: string) => string, muted: (s: string) => string, dim: (s: string) => string, warning: (s: string) => string, error: (s: string) => string): string {
		if (this.mode === "confirm-delete" && this.deleteTarget) {
			return error(`Delete “${truncateToWidth(sessionResumeTitle(this.deleteTarget), Math.max(12, inner - 10), "…")}”?`);
		}
		if (this.mode === "confirm-delete-all") {
			return error(`Delete all ${this.deleteAllTargets.length} shown deletable sessions?`);
		}
		if (this.mode === "deleting") return warning("Deleting session…");
		if (this.mode === "rename" && this.renameTarget) return accent(`Rename “${truncateToWidth(sessionResumeTitle(this.renameTarget), Math.max(12, inner - 10), "…")}”`);
		if (this.notice) {
			return this.notice.kind === "error" ? error(this.notice.text) : accent(this.notice.text);
		}
		if (this.queryError) return error(`Search error: ${this.queryError}`);
		return dim("Search supports re:<pattern> regex and \"phrase\" exact matching.");
	}

	private renderSearch(inner: number, dim: (s: string) => string): string {
		if (this.mode === "rename") {
			const prefix = " ";
			const input = this.renameInput.render(Math.max(1, inner - visibleWidth(prefix)))[0] ?? "";
			return prefix + input;
		}
		const prefix = " ";
		const input = this.searchInput.render(Math.max(1, inner - visibleWidth(prefix)))[0] ?? "";
		return prefix + input;
	}

	private renderListRows(
		inner: number,
		ui: {
			row: (content?: string) => string;
			fixed: (content?: string, width?: number) => string;
			dim: (s: string) => string;
			muted: (s: string) => string;
			accent: (s: string) => string;
			warning: (s: string) => string;
			error: (s: string) => string;
		},
	): string[] {
		const lines: string[] = [];
		if (this.filtered.length === 0) {
			const message = this.queryError
				? "  No sessions match because the search query is invalid"
				: this.searchInput.getValue().trim()
					? "  No matching sessions"
					: this.nameFilter === "named"
						? "  No named sessions found"
						: "  No sessions found";
			lines.push(ui.row(ui.dim(message)));
			for (let i = 1; i < this.visibleRows; i++) lines.push(ui.row(""));
			return lines;
		}

		const end = Math.min(this.scrollOffset + this.visibleRows, this.filtered.length);
		for (let i = this.scrollOffset; i < end; i++) {
			const node = this.filtered[i]!;
			lines.push(ui.row(this.renderSessionRow(node, i, inner, ui)));
		}
		for (let i = end - this.scrollOffset; i < this.visibleRows; i++) lines.push(ui.row(""));
		return lines;
	}

	private renderSessionRow(
		node: FlatSessionNode,
		index: number,
		inner: number,
		ui: {
			fixed: (content?: string, width?: number) => string;
			dim: (s: string) => string;
			muted: (s: string) => string;
			accent: (s: string) => string;
			warning: (s: string) => string;
			error: (s: string) => string;
		},
	): string {
		const session = node.session;
		const selected = index === this.selectedIndex;
		const current = this.isCurrent(session);
		const titleRaw = sessionResumeTitle(session);
		const prefix = rowTreePrefix(node);
		const cursor = " ";
		const marker = "";
		const rightParts = [
			`${session.messageCount} msg`,
			formatAge(session.modified),
		].filter(Boolean);
		const rightRaw = rightParts.join(" · ");
		const rightMax = Math.min(ROW_META_MAX_WIDTH, Math.max(14, Math.floor(inner * 0.38)));
		const right = selected ? this.theme.fg("text", truncateToWidth(rightRaw, rightMax, "…")) : ui.dim(truncateToWidth(rightRaw, rightMax, "…"));
		const leftFixed = cursor + ui.dim(prefix) + marker;
		const availableTitle = Math.max(8, inner - visibleWidth(leftFixed) - visibleWidth(right) - 2);
		let title = truncateToWidth(titleRaw, availableTitle, "…");
		if (current) title = this.theme.fg("success", title);
		else if (isNamed(session)) title = ui.accent(title);
		if (selected) title = this.theme.bold(title);
		const left = leftFixed + title;
		const spacing = " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right)));
		let line = ui.fixed(left + spacing + right, inner);
		if (selected) line = this.theme.bg("selectedBg", line);
		return line;
	}

	private renderDetailRows(
		inner: number,
		ui: {
			row: (content?: string) => string;
			fixed: (content?: string, width?: number) => string;
			dim: (s: string) => string;
			muted: (s: string) => string;
			accent: (s: string) => string;
			warning: (s: string) => string;
			error: (s: string) => string;
			success: (s: string) => string;
		},
	): string[] {
		const lines: string[] = [];
		const selectedNode = this.filtered[this.selectedIndex];
		const selected = selectedNode?.session;
		const scope = this.scope === "current" ? "current project" : "all sessions";
		const shown = `${this.filtered.length}/${this.sessions.length}`;
		const search = oneLine(this.searchInput.getValue());
		if (!selected) {
			const state = `${shown} shown · ${scope} · ${this.sortMode} sort · ${this.nameFilter === "named" ? "named only" : "all names"}${search ? ` · query “${truncateToWidth(search, 28, "…")}”` : ""}`;
			lines.push(ui.row(ui.dim(state)));
			return lines;
		}

		const locationPrefix = ui.dim("Session CWD: ");
		const location = selected.cwd || selected.path;
		lines.push(ui.row(locationPrefix + ui.muted(truncateToWidth(shortenPath(location), Math.max(10, inner - visibleWidth(locationPrefix)), "…"))));

		const state = `${shown} shown · ${scope} · ${this.sortMode} sort · ${this.nameFilter === "named" ? "named only" : "all names"}${search ? ` · query “${truncateToWidth(search, 28, "…")}”` : ""}`;
		lines.push(ui.row(ui.dim(state)));

		const snippet = oneLine(this.searchInput.getValue()) ? selectedNode?.snippet : undefined;
		if (snippet) {
			const previewPrefix = ui.dim("match   ");
			const preview = truncateToWidth(styleSearchMatches(snippet, this.searchInput.getValue()), Math.max(10, inner - visibleWidth(previewPrefix) - 1), "…");
			lines.push(ui.row(previewPrefix + ui.muted(`“${preview}`)));
		}
		return lines;
	}

	private renderFooter(inner: number, dim: (s: string) => string, warning: (s: string) => string, error: (s: string) => string): string[] {
		if (this.mode === "confirm-delete" || this.mode === "confirm-delete-all") return [];
		if (this.mode === "rename") return [warning("empty name clears title")];
		return [
			`${ansiYellow("-/=")} ${dim("page · ")}${ansiYellow("enter")} ${dim("resume · ")}${ansiYellow("alt+m")} ${dim("resume+model · ")}${ansiYellow("alt+r")} ${dim("rename")}`,
			`${ansiYellow("tab")} ${dim("scope · ")}${ansiYellow("alt+s")} ${dim("sort · ")}${ansiYellow("alt+n")} ${dim("names · ")}${ansiYellow("alt+d")} ${dim("delete · ")}${ansiYellow("alt+x")} ${dim("delete all")}`,
		];
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.renameInput.invalidate();
	}
}

async function openManager(ctx: SessionManagerContext, pi: ExtensionAPI): Promise<SessionAction> {
	const releaseModalLock = acquireVstackModalLock();
	try {
		const result = await ctx.ui.custom<SessionAction | undefined>(
			(tui, theme, keybindings, done) => new SessionManagerOverlay(ctx, pi, theme, keybindings, (action) => done(action), tui),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: Math.max(72, Math.floor(settingNumber("overlayWidth", DEFAULT_WIDTH, ctx.cwd))),
					maxHeight: "90%",
					margin: 1,
				},
			},
		);
		return result ?? { type: "cancel" };
	} finally {
		releaseModalLock();
	}
}

function queueSessionManagerCommandAction(ctx: SessionManagerContext, action: SessionAction): void {
	if (action.type !== "resume") return;
	const id = `sm-${Date.now().toString(36)}-${(++pendingSessionManagerActionCounter).toString(36)}`;
	pendingSessionManagerActions.set(id, action);
	ctx.ui.setEditorText(`/sessions:resume-pending ${id}`);
	ctx.ui.notify(`${action.title || basename(action.path)} — press Enter to resume`, "info");
}

async function runSessionManagerAction(ctx: SessionManagerContext, pi: ExtensionAPI, action: SessionAction): Promise<boolean> {
	if (action.type !== "resume") return true;
	const switchSession = (ctx as { switchSession?: ExtensionCommandContext["switchSession"] }).switchSession;
	if (typeof switchSession !== "function") return false;
	if (samePath(action.path, ctx.sessionManager.getSessionFile())) {
		ctx.ui.notify("Already in this session", "info");
		return true;
	}
	const targetTitle = action.title || basename(action.path);
	const currentModel = action.keepCurrentModel ? ctx.model : undefined;
	const currentThinking = action.keepCurrentModel && typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
	if (currentModel) pinSessionModel(action.path, currentModel, currentThinking);
	const result = await switchSession.call(ctx, action.path, {
		withSession: async (replacementCtx) => {
			if (currentModel) replacementCtx.ui.notify(`Using current model: ${currentModel.provider}/${currentModel.id}`, "info");
			clearLegacySessionStatus(replacementCtx);
			replacementCtx.ui.notify(`Resumed ${targetTitle}${currentModel ? " with current model" : ""}`, "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
	return true;
}

async function handleSessionsCommand(_args: string, ctx: SessionManagerContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/sessions requires interactive UI", "error");
		return;
	}
	const waitForIdle = (ctx as { waitForIdle?: () => Promise<void> }).waitForIdle;
	if (typeof waitForIdle === "function") await waitForIdle.call(ctx);
	else if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
		ctx.ui.notify("Session manager can open after the current turn finishes", "warning");
		return;
	}
	const action = await openManager(ctx, pi);
	if (!(await runSessionManagerAction(ctx, pi, action))) queueSessionManagerCommandAction(ctx, action);
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	if (!settingBoolean("enabled", true)) return;

	pi.on("session_start", async (_event, ctx) => {
		if (!settingBoolean("enabled", true, ctx.cwd)) return;
		clearLegacySessionStatus(ctx);
	});

	pi.registerCommand("sessions", {
		description: "Pi session browser and resume manager.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.startsWith("resume-pending")) {
				const id = trimmed.slice("resume-pending".length).trim();
				const action = pendingSessionManagerActions.get(id);
				if (!action) {
					ctx.ui.notify("No pending session-manager resume action found.", "warning");
					return;
				}
				pendingSessionManagerActions.delete(id);
				if (!(await runSessionManagerAction(ctx, pi, action))) ctx.ui.notify("Session resume is unavailable in this context.", "error");
				return;
			}
			await handleSessionsCommand(args, ctx, pi);
		},
	});
	pi.registerCommand("sessions:resume-pending", {
		description: "Run a pending session-manager resume action",
		handler: async (args, ctx) => {
			const id = args.trim();
			const action = pendingSessionManagerActions.get(id);
			if (!action) {
				ctx.ui.notify("No pending session-manager resume action found.", "warning");
				return;
			}
			pendingSessionManagerActions.delete(id);
			if (!(await runSessionManagerAction(ctx, pi, action))) ctx.ui.notify("Session resume is unavailable in this context.", "error");
		},
	});

	const shortcut = configuredShortcut();
	if (shortcut) {
		pi.registerShortcut(shortcut, {
			description: "Open session manager",
			handler: async (ctx) => handleSessionsCommand("", ctx, pi),
		});
	}
}
