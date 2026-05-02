import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@mariozechner/pi-tui";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-session-manager.installed");
const PACKAGE_ID = "pi-session-manager";
const STATUS_KEY = "session-manager";
const DEFAULT_SHORTCUT = "ctrl+shift+r";
const DEFAULT_WIDTH = 112;
const DEFAULT_ROWS = 12;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

type SessionInfo = Awaited<ReturnType<typeof SessionManager.list>>[number];
type Scope = "current" | "all";
type SortMode = "threaded" | "recent" | "relevance";
type NameFilter = "all" | "named";
type Mode = "browse" | "loading" | "rename" | "confirm-delete" | "deleting";

type SessionAction = { type: "resume"; path: string; title: string } | { type: "cancel" };

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

function updateSessionStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!settingBoolean("showStatus", true, ctx.cwd)) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const name = oneLine(ctx.sessionManager.getSessionName());
	ctx.ui.setStatus(STATUS_KEY, name ? ctx.ui.theme.fg("accent", `📁 ${name}`) : undefined);
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
	private notice: { kind: "info" | "error"; text: string } | undefined;
	private queryError: string | undefined;
	private loadingProgress: { loaded: number; total: number } | undefined;
	private loadSeq = 0;
	private scope: Scope;
	private sortMode: SortMode;
	private nameFilter: NameFilter = "all";
	private showPath = false;
	private currentSessionPath: string | undefined;

	constructor(
		private readonly ctx: ExtensionCommandContext,
		private readonly pi: ExtensionAPI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (action: SessionAction) => void,
		private readonly requestRenderFn: () => void,
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
		return Math.max(5, Math.min(30, Math.floor(settingNumber("visibleRows", DEFAULT_ROWS, this.ctx.cwd))));
	}

	private notify(kind: "info" | "error", text: string): void {
		this.notice = { kind, text: oneLine(text) };
	}

	private requestRender(): void {
		this.requestRenderFn();
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
				updateSessionStatus(this.ctx);
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
	}

	private startDelete(session: SessionInfo): void {
		if (this.isCurrent(session)) {
			this.notify("error", "Cannot delete the current active session");
			return;
		}
		this.deleteTarget = session;
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

		if (this.mode === "confirm-delete") {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				void this.confirmDelete();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel")) {
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

		if (this.keybindings.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
			this.applyFilter();
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "app.session.toggleNamedFilter")) {
			this.nameFilter = this.nameFilter === "all" ? "named" : "all";
			this.applyFilter();
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "app.session.rename") || (data === "r" && !this.searchInput.getValue())) {
			const selected = this.selected();
			if (selected) this.startRename(selected);
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "app.session.delete") || (data === "d" && !this.searchInput.getValue())) {
			const selected = this.selected();
			if (selected) this.startDelete(selected);
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.selected();
			if (selected) this.done({ type: "resume", path: selected.path, title: sessionResumeTitle(selected) });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			this.moveSelection(-1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.moveSelection(1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.setSelection(this.selectedIndex - this.visibleRows);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
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
		const inner = Math.max(10, renderWidth - 2);
		const th = this.theme;
		const border = (s: string) => th.fg("borderAccent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const accent = (s: string) => th.fg("accent", s);
		const warning = (s: string) => th.fg("warning", s);
		const error = (s: string) => th.fg("error", s);
		const success = (s: string) => th.fg("success", s);

		const fixed = (content = "", rowWidth = inner): string => {
			const safe = content.replace(/[\r\n\t]+/g, " ");
			const clipped = truncateToWidth(safe, rowWidth, "");
			return clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
		};
		const row = (content = "") => border("│") + fixed(content) + border("│");
		const divider = () => row(muted("─".repeat(inner)));
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(inner)}╮`));
		lines.push(row(this.renderHeader(inner, accent, muted, dim)));
		lines.push(row(this.renderSubheader(inner, accent, muted, dim, warning, error)));
		lines.push(row(this.renderSearch(inner, dim)));
		lines.push(divider());

		if (this.mode === "loading") {
			const progress = this.loadingProgress ? ` ${this.loadingProgress.loaded}/${this.loadingProgress.total}` : "";
			lines.push(row(dim(`  Loading sessions${progress}…`)));
			for (let i = 1; i < this.visibleRows; i++) lines.push(row(""));
		} else {
			lines.push(...this.renderListRows(inner, { row, fixed, dim, muted, accent, warning, error }));
		}

		lines.push(divider());
		lines.push(...this.renderDetailRows(inner, { row, fixed, dim, muted, accent, warning, error, success }));
		lines.push(row(this.renderFooter(inner, dim, warning, error)));
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}

	private renderHeader(inner: number, accent: (s: string) => string, muted: (s: string) => string, dim: (s: string) => string): string {
		const title = accent(this.theme.bold("✦ Session Manager"));
		const scopeText = `${this.scope === "current" ? accent("● current") : muted("○ current")} ${dim("·")} ${this.scope === "all" ? accent("● all") : muted("○ all")}`;
		const sortText = `${muted("sort:")} ${accent(this.sortMode)}`;
		const nameText = `${muted("names:")} ${accent(this.nameFilter)}`;
		const right = `${scopeText}  ${sortText}  ${nameText}`;
		const available = Math.max(0, inner - visibleWidth(right) - 1);
		const left = truncateToWidth(` ${title}`, available, "");
		return left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right))) + right;
	}

	private renderSubheader(inner: number, accent: (s: string) => string, muted: (s: string) => string, dim: (s: string) => string, warning: (s: string) => string, error: (s: string) => string): string {
		if (this.mode === "confirm-delete" && this.deleteTarget) {
			return error(` Delete “${truncateToWidth(sessionResumeTitle(this.deleteTarget), Math.max(12, inner - 30), "…")}”? Enter confirms, Esc cancels.`);
		}
		if (this.mode === "deleting") return warning(" Deleting session…");
		if (this.mode === "rename" && this.renameTarget) return accent(` Rename “${truncateToWidth(sessionResumeTitle(this.renameTarget), Math.max(12, inner - 28), "…")}” — Enter saves, Esc cancels.`);
		if (this.notice) {
			return this.notice.kind === "error" ? error(` ${this.notice.text}`) : accent(` ${this.notice.text}`);
		}
		if (this.queryError) return error(` Search error: ${this.queryError}`);
		return dim(" Type to search · quote phrases · re:<pattern> regex · titles match Pi /resume");
	}

	private renderSearch(inner: number, dim: (s: string) => string): string {
		if (this.mode === "rename") {
			const prefix = ` ${dim("rename ›")} `;
			const input = this.renameInput.render(Math.max(1, inner - visibleWidth(prefix)))[0] ?? "";
			return prefix + input;
		}
		const prefix = ` ${dim("search ›")} `;
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
		const cursor = selected ? ui.accent("› ") : "  ";
		const markers = `${current ? ui.accent("● ") : session.parentSessionPath ? ui.dim("⑂ ") : "  "}`;
		const rightParts = [
			`${session.messageCount} msg`,
			formatAge(session.modified),
			this.showPath ? shortenPath(session.path) : this.scope === "all" && session.cwd ? shortenPath(session.cwd) : "",
		].filter(Boolean);
		const right = ui.dim(rightParts.join(" · "));
		const leftFixed = cursor + ui.dim(prefix) + markers;
		const availableTitle = Math.max(8, inner - visibleWidth(leftFixed) - visibleWidth(right) - 2);
		let title = truncateToWidth(titleRaw, availableTitle, "…");
		if (current) title = ui.accent(title);
		else if (isNamed(session)) title = ui.warning(title);
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
		const selected = this.selected();
		const range = this.filtered.length === 0 ? "0 sessions" : `${this.selectedIndex + 1}/${this.filtered.length}`;
		const scope = this.scope === "current" ? "current project" : "all sessions";
		lines.push(ui.row(ui.dim(` ${range} · ${scope} · ${this.sortMode} sort${this.nameFilter === "named" ? " · named only" : ""}`)));
		if (!selected) {
			lines.push(ui.row(""));
			lines.push(ui.row(""));
			return lines;
		}
		const title = sessionResumeTitle(selected);
		const snippet = this.filtered[this.selectedIndex]?.snippet || oneLine(selected.firstMessage);
		const path = this.showPath ? shortenPath(selected.path) : shortenPath(selected.cwd || selected.path);
		const titlePrefix = this.isCurrent(selected) ? ui.success(" current ") : isNamed(selected) ? ui.warning(" named ") : ui.dim(" session ");
		lines.push(ui.row(` ${titlePrefix}${truncateToWidth(title, Math.max(10, inner - visibleWidth(titlePrefix) - 2), "…")}`));
		lines.push(ui.row(ui.dim(` ${path}${selected.parentSessionPath ? " · forked" : ""}${selected.id ? ` · ${selected.id.slice(0, 8)}` : ""}`)));
		if (snippet) lines.push(ui.row(ui.muted(` “${truncateToWidth(snippet, Math.max(10, inner - 4), "…")}`)));
		else lines.push(ui.row(""));
		return lines;
	}

	private renderFooter(inner: number, dim: (s: string) => string, warning: (s: string) => string, error: (s: string) => string): string {
		if (this.mode === "confirm-delete") return error(" Enter confirm · Esc cancel");
		if (this.mode === "rename") return warning(" Enter save · Esc cancel · empty name clears title");
		return dim(" ↑↓/jk move · Enter resume · Ctrl+R rename · Ctrl+D delete · Tab scope · Ctrl+S sort · Ctrl+N names · Ctrl+P path · Esc close");
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.renameInput.invalidate();
	}
}

async function openManager(ctx: ExtensionCommandContext, pi: ExtensionAPI, initialScope?: Scope): Promise<SessionAction> {
	const result = await ctx.ui.custom<SessionAction | undefined>(
		(tui, theme, keybindings, done) => new SessionManagerOverlay(ctx, pi, theme, keybindings, (action) => done(action), () => tui.requestRender(), initialScope),
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
}

function initialScopeFromArgs(args: string, cwd: string): Scope | undefined {
	const first = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
	if (first === "all" || first === "--all") return "all";
	if (first === "current" || first === "--current") return "current";
	return settingScope(cwd);
}

async function handleSessionsCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/sessions requires interactive UI", "error");
		return;
	}
	await ctx.waitForIdle();
	const action = await openManager(ctx, pi, initialScopeFromArgs(args, ctx.cwd));
	if (action.type !== "resume") return;
	if (samePath(action.path, ctx.sessionManager.getSessionFile())) {
		ctx.ui.notify("Already in this session", "info");
		return;
	}
	const targetTitle = action.title || basename(action.path);
	const result = await ctx.switchSession(action.path, {
		withSession: async (replacementCtx) => {
			updateSessionStatus(replacementCtx);
			replacementCtx.ui.notify(`Resumed ${targetTitle}`, "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	if (!settingBoolean("enabled", true)) return;

	pi.on("session_start", async (_event, ctx) => {
		if (!settingBoolean("enabled", true, ctx.cwd)) return;
		updateSessionStatus(ctx);
	});

	pi.registerCommand("sessions", {
		description: "Browse, search, resume, rename, and delete Pi sessions",
		handler: async (args, ctx) => handleSessionsCommand(args, ctx, pi),
	});

	const shortcut = configuredShortcut();
	if (shortcut) {
		pi.registerShortcut(shortcut, {
			description: "Open session manager",
			handler: async (ctx) => {
				if (!ctx.hasUI) return;
				if (!ctx.isIdle()) {
					ctx.ui.notify("Session manager can open after the current turn finishes", "warning");
					return;
				}
				pi.sendUserMessage("/sessions");
			},
		});
	}
}
