import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete, type Message } from "@mariozechner/pi-ai";
import { AssistantMessageComponent, BorderedLoader, convertToLlm, CustomEditor, serializeConversation, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager, type SessionEntry, type Theme } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteSuggestions, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-qol.installed");
const STATUS_KEY = "qol-attachments";
const SESSION_SEARCH_STATUS_KEY = "qol-session-search";
const SESSION_SEARCH_CONTEXT_TYPE = "qol-session-context";
const CONTEXT_USAGE_MESSAGE_TYPE = "qol-context-usage";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const IMAGE_PATH_PATTERN = /(^|[\s(\[{<"'`])(@?(?:~|\.\.?|\/)[^\s)\]}>"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s)\]}>"'`,.;:!?])/gi;
const IMAGE_ALIAS_SYMBOL = Symbol.for("vstack.pi-qol.image-path-aliases");
const QUESTION_SERVICE_SYMBOL = Symbol.for("vstack.pi-questions.service");
const QOL_NOTIFICATION_SERVICE_SYMBOL = Symbol.for("vstack.pi-qol.notification-service");
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
const THINKING_TIMER_STORE_SYMBOL = Symbol.for("vstack.pi-qol.thinking-timer.store");
const THINKING_TIMER_PATCH_SYMBOL = Symbol.for("vstack.pi-qol.thinking-timer.patch");
const SESSION_SEARCH_PENDING_SYMBOL = Symbol.for("vstack.pi-qol.session-search.pending-context");
const QUESTION_OPENED_EVENT = "vstack:pi-questions:opened";
const QUESTION_NOTIFY_DEDUP_MS = 2000;
const DEFAULT_NOTIFICATION_TITLE = "Pi";
const DEFAULT_NOTIFICATION_COOLDOWN_SECONDS = 8;
const DEFAULT_NOTIFICATION_BODY_MAX_CHARS = 240;
const DEFAULT_TMUX_MESSAGE_DURATION_MS = 5000;
const DEFAULT_COMPACTION_MODEL = "google/gemini-2.5-flash";
const DEFAULT_COMPACTION_MAX_TOKENS = 8192;
const DEFAULT_IDLE_COMPACTION_THRESHOLD_TOKENS = 200000;
const DEFAULT_IDLE_COMPACTION_SECONDS = 300;
const DEFAULT_PERMISSION_GATE_COMMANDS = "rm -Rf";
const DEFAULT_PERMISSION_GATE_PREVIEW_LINES = 12;
const DEFAULT_PERMISSION_GATE_PREVIEW_CHARS = 1200;
const DEFAULT_PERMISSION_GATE_PREVIEW_LINE_WIDTH = 120;
const DEFAULT_SESSION_SEARCH_LIMIT = 40;
const DEFAULT_SESSION_SEARCH_PREVIEW_SNIPPETS = 6;
const DEFAULT_SESSION_SEARCH_SHORTCUT = "f3";
const DEFAULT_SESSION_SEARCH_SUMMARY_INPUT_CHARS = 180_000;
const DEFAULT_SESSION_SEARCH_SUMMARY_MAX_TOKENS = 4096;
const DEFAULT_SESSION_SEARCH_CACHE_TTL_SECONDS = 0;
const DEFAULT_AUTO_RENAME_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_AUTO_RENAME_FALLBACK_MODEL = "current";
const DEFAULT_AUTO_RENAME_INPUT_CHARS = 2000;
const DEFAULT_AUTO_RENAME_NAME_CHARS = 80;
const DEFAULT_AUTO_RENAME_MAX_TOKENS = 96;
const DEFAULT_AUTO_RENAME_TIMEOUT_MS = 12_000;

const AUTO_RENAME_SYSTEM_PROMPT = "You create short, descriptive session names for coding-agent chats. Use 2-6 words in Title Case. Respond with only the name, no quotes, explanations, markdown, emoji, or trailing punctuation.";

const DEFAULT_AUTO_RENAME_PROMPT = `Generate a short, descriptive title for this Pi coding-agent session based on the first user message.

Rules:
- Use 2-6 words
- Use Title Case
- Be specific about the user's task or topic
- Do not mention Pi unless Pi itself is the task
- Return only the title

First user message:
{{message}}`;

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

type VstackConfig = Record<string, unknown>;

interface ImageAliasState {
	next: number;
	byLabel: Record<string, string>;
	byPath: Record<string, string>;
}

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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-qol"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
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

function newlineFallbackKey(cwd?: string): "ctrl+j" | "none" {
	const configured = settingString("newlineFallbackKey", "ctrl+j", cwd).toLowerCase();
	return configured === "none" ? "none" : "ctrl+j";
}

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

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

function styleAutocompleteHintItem(item: AutocompleteItem, theme: Theme): AutocompleteItem {
	const label = stripAnsi(item.label || item.value);
	const styled: AutocompleteItem = { ...item, label: theme.fg("accent", label) };
	if (typeof item.description === "string" && item.description.length > 0) {
		styled.description = theme.fg("text", stripAnsi(item.description));
	}
	return styled;
}

function styleSlashAutocompleteHints(suggestions: AutocompleteSuggestions | null, theme: Theme): AutocompleteSuggestions | null {
	if (!suggestions || !suggestions.prefix.startsWith("/")) return suggestions;
	return { ...suggestions, items: suggestions.items.map((item) => styleAutocompleteHintItem(item, theme)) };
}

function installAutocompleteHintStyling(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.addAutocompleteProvider((current) => ({
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			return styleSlashAutocompleteHints(await current.getSuggestions(lines, cursorLine, cursorCol, options), ctx.ui.theme);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	}));
}

const QOL_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show QOL status and current settings" },
	{ value: "rename", label: "rename", description: "Generate a session name from the first user message" },
	{ value: "notify-test", label: "notify-test", description: "Send a test QOL notification" },
];

const QOL_RENAME_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{ value: "rename full", label: "rename full", description: "Generate a session name from the full conversation" },
];

function getQolArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items = query.startsWith("rename ") ? QOL_RENAME_ARGUMENT_COMPLETIONS : QOL_ARGUMENT_COMPLETIONS;
	const filtered = items.filter((item) => item.value.toLowerCase().startsWith(query));
	return filtered.length > 0 ? filtered : null;
}

const SESSION_SEARCH_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{ value: "refresh", label: "refresh", description: "Refresh the session search index" },
];

function getSessionSearchArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const filtered = SESSION_SEARCH_ARGUMENT_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(query) || (item.label ?? item.value).toLowerCase().startsWith(query));
	return filtered.length > 0 ? filtered : null;
}

type QolNotificationKind = "ready" | "direction" | "question" | "task-complete" | "critical" | "test";
type QolNotificationLevel = "info" | "warning" | "error";

interface QuestionRequestLike {
	header?: string;
	question?: string;
}

interface QuestionOpenedEventLike {
	requestId?: string;
	request?: QuestionRequestLike;
	source?: string;
}

interface QuestionServiceLike {
	listPending(): unknown[];
	subscribe(listener: (event: any) => void): () => void;
}

interface QolNotificationService {
	notifyQuestionOpened(ctx: ExtensionContext | undefined, event: QuestionOpenedEventLike): boolean;
}

interface VstackModalLock {
	depth: number;
}

interface ThinkingTimerStore {
	enabled: boolean;
	starts: Map<string, number>;
	durations: Map<string, number>;
	labels: Map<string, Text>;
	theme?: ExtensionContext["ui"]["theme"];
}

interface PermissionGateMatcher {
	label: string;
	pattern: RegExp;
}

function splitPermissionGateCommands(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function regexFromSlashPattern(entry: string): RegExp | undefined {
	if (!entry.startsWith("/")) return undefined;
	const end = entry.lastIndexOf("/");
	if (end <= 0) return undefined;
	const source = entry.slice(1, end);
	const flags = entry.slice(end + 1);
	try {
		return new RegExp(source, flags || "i");
	} catch {
		return undefined;
	}
}

function literalCommandPattern(entry: string): RegExp | undefined {
	const source = entry.split(/\s+/).map(escapeRegex).join("\\s+");
	if (!source) return undefined;
	try {
		return new RegExp(source, "i");
	} catch {
		return undefined;
	}
}

function permissionGateCommands(cwd?: string): string[] {
	return splitPermissionGateCommands(settingStringAllowEmpty("permissionGate.commands", DEFAULT_PERMISSION_GATE_COMMANDS, cwd));
}

function permissionGateMatchers(cwd?: string): PermissionGateMatcher[] {
	return permissionGateCommands(cwd)
		.map((entry) => ({ label: entry, pattern: regexFromSlashPattern(entry) ?? literalCommandPattern(entry) }))
		.filter((matcher): matcher is PermissionGateMatcher => matcher.pattern instanceof RegExp);
}

function permissionGateMatch(command: string, cwd?: string): string | undefined {
	for (const matcher of permissionGateMatchers(cwd)) {
		matcher.pattern.lastIndex = 0;
		if (matcher.pattern.test(command)) return matcher.label;
	}
	return undefined;
}

function boundedSettingNumber(key: string, fallback: number, min: number, max: number, cwd?: string): number {
	return Math.max(min, Math.min(max, Math.floor(settingNumber(key, fallback, cwd))));
}

function formatCount(count: number, label: string): string {
	return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
}

function sanitizePermissionGatePreview(command: string): string {
	return stripAnsi(command)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�");
}

function permissionGateCommandPreview(command: string, cwd?: string): { text: string; totalChars: number; totalLines: number; truncated: boolean } {
	const maxLines = boundedSettingNumber("permissionGate.previewLines", DEFAULT_PERMISSION_GATE_PREVIEW_LINES, 4, 40, cwd);
	const maxChars = boundedSettingNumber("permissionGate.previewChars", DEFAULT_PERMISSION_GATE_PREVIEW_CHARS, 200, 5000, cwd);
	const maxLineWidth = boundedSettingNumber("permissionGate.previewLineWidth", DEFAULT_PERMISSION_GATE_PREVIEW_LINE_WIDTH, 40, 240, cwd);
	const safeCommand = sanitizePermissionGatePreview(command);
	const commandLines = safeCommand.split("\n");
	let selectedLines = commandLines;
	let omittedLines = 0;

	if (commandLines.length > maxLines) {
		const headCount = Math.max(1, Math.ceil((maxLines - 1) * 0.65));
		const tailCount = Math.max(1, maxLines - headCount - 1);
		omittedLines = Math.max(0, commandLines.length - headCount - tailCount);
		selectedLines = [
			...commandLines.slice(0, headCount),
			`… ${formatCount(omittedLines, "line")} omitted …`,
			...commandLines.slice(-tailCount),
		];
	}

	let widthTruncated = false;
	const previewLines = selectedLines.map((line) => {
		if (/^… \d[\d,]* lines? omitted …$/.test(line)) return line;
		if (visibleWidth(line) > maxLineWidth) widthTruncated = true;
		return truncateToWidth(line, maxLineWidth, "…");
	});

	let text = previewLines.join("\n").trimEnd();
	let charTruncated = false;
	if (text.length > maxChars) {
		const marker = `\n… preview clipped to ${formatCount(maxChars, "char")} …\n`;
		const budget = Math.max(0, maxChars - marker.length);
		const headChars = Math.ceil(budget * 0.6);
		const tailChars = Math.max(0, budget - headChars);
		const tail = tailChars > 0 ? text.slice(-tailChars).trimStart() : "";
		text = `${text.slice(0, headChars).trimEnd()}${marker}${tail}`;
		charTruncated = true;
	}

	return {
		text: text || "(empty command)",
		totalChars: command.length,
		totalLines: commandLines.length,
		truncated: omittedLines > 0 || widthTruncated || charTruncated,
	};
}

function permissionGatePrompt(matched: string, command: string, cwd?: string): string {
	const preview = permissionGateCommandPreview(command, cwd);
	const matchedLabel = truncateToWidth(sanitizePermissionGatePreview(matched).replace(/\n+/g, " ").trim() || "configured pattern", DEFAULT_PERMISSION_GATE_PREVIEW_LINE_WIDTH, "…");
	const commandStats = `${formatCount(preview.totalLines, "line")}, ${formatCount(preview.totalChars, "char")}`;
	return [
		`⚠️ Permission gate matched: ${matchedLabel}`,
		"",
		`Bash command (${commandStats}${preview.truncated ? "; compact preview" : ""}):`,
		"```sh",
		preview.text,
		"```",
		...(preview.truncated ? ["Full command is unchanged; only this approval preview was shortened."] : []),
		"",
		"Allow this bash command?",
	].join("\n");
}

const lastNotificationAt = new Map<string, number>();
const lastQuestionNotificationAt = new Map<string, number>();
let tmuxMarkedTarget: string | undefined;
let tmuxOriginalWindowName: string | undefined;
let tmuxWindowMarkTimer: ReturnType<typeof setTimeout> | undefined;

function getThinkingTimerStore(): ThinkingTimerStore | undefined {
	return (globalThis as unknown as Record<PropertyKey, unknown>)[THINKING_TIMER_STORE_SYMBOL] as ThinkingTimerStore | undefined;
}

function formatThinkingElapsed(ms: number): string {
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function thinkingTimerLabel(theme: ThinkingTimerStore["theme"], ms: number): string {
	const base = "Thinking...";
	const elapsed = ` ${formatThinkingElapsed(ms)}`;
	if (!theme) return `${base}${elapsed}`;
	return theme.italic(theme.fg("thinkingText", base) + theme.fg("dim", elapsed));
}

function thinkingTimerKey(timestamp: number, contentIndex: number): string {
	return `${timestamp}:${contentIndex}`;
}

function installThinkingTimerPatch(): void {
	const proto = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, any>;
	if (proto[THINKING_TIMER_PATCH_SYMBOL]) return;
	const originalUpdateContent = proto.updateContent;
	if (typeof originalUpdateContent !== "function") return;
	proto[THINKING_TIMER_PATCH_SYMBOL] = true;
	proto.updateContent = function patchedUpdateContent(this: any, message: any): void {
		originalUpdateContent.call(this, message);
		try {
			const store = getThinkingTimerStore();
			if (!store?.enabled) return;
			if (!message || !Array.isArray(message.content) || typeof message.timestamp !== "number") return;
			if (!this.hideThinkingBlock) return;
			if (!this.contentContainer || !Array.isArray(this.contentContainer.children)) return;

			const thinkingIndices: number[] = [];
			for (let i = 0; i < message.content.length; i++) {
				const content = message.content[i];
				if (content?.type === "thinking" && typeof content.thinking === "string" && content.thinking.trim()) thinkingIndices.push(i);
			}
			if (thinkingIndices.length === 0) return;

			const labelComponents: Text[] = [];
			for (const child of this.contentContainer.children as any[]) {
				if (!child || typeof child !== "object") continue;
				if (typeof child.setText !== "function") continue;
				if (typeof child.text !== "string") continue;
				if (!child.text.includes("Thinking...")) continue;
				labelComponents.push(child as Text);
			}
			if (labelComponents.length === 0) return;

			const count = Math.min(thinkingIndices.length, labelComponents.length);
			for (let i = 0; i < count; i++) {
				const contentIndex = thinkingIndices[i]!;
				const label = labelComponents[i]!;
				const key = thinkingTimerKey(message.timestamp, contentIndex);
				store.labels.set(key, label);
				const duration = store.durations.get(key);
				const start = store.starts.get(key);
				const ms = duration ?? (start === undefined ? undefined : Date.now() - start);
				if (ms !== undefined) label.setText(thinkingTimerLabel(store.theme, ms));
			}
		} catch {
			// Rendering must never break because of this optional monkey-patch.
		}
	};
}

function sanitizeNotificationPart(input: string, maxChars = DEFAULT_NOTIFICATION_BODY_MAX_CHARS): string {
	const cleaned = input
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 1))}…` : cleaned;
}

function windowsToastScript(title: string, body: string): string {
	const escapedTitle = title.replace(/'/g, "''");
	const escapedBody = body.replace(/'/g, "''");
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText02`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapedTitle}')) > $null`,
		`$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('${escapedBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${escapedTitle}').Show(${toast})`,
	].join("; ");
}

function tmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function sourcePaneTty(): string | undefined {
	try {
		if (!process.env.TMUX_PANE) return undefined;
		const tty = execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_tty}"], { encoding: "utf8" }).trim();
		return tty || undefined;
	} catch {
		return undefined;
	}
}

function sourceTmuxSession(): string | undefined {
	try {
		if (!process.env.TMUX_PANE) return undefined;
		const session = execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{session_name}"], { encoding: "utf8" }).trim();
		return session || undefined;
	} catch {
		return undefined;
	}
}

function sourceTmuxWindowActive(): boolean {
	try {
		if (!process.env.TMUX_PANE) return false;
		const active = execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{window_active}"], { encoding: "utf8" }).trim();
		return active === "1";
	} catch {
		return false;
	}
}

function tmuxClientTtys(): string[] {
	try {
		if (!process.env.TMUX) return [];
		const session = sourceTmuxSession();
		const args = ["list-clients", "-F", "#{client_tty}"];
		if (session) args.splice(1, 0, "-t", session);
		const output = execFileSync("tmux", args, { encoding: "utf8" });
		return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
	} catch {
		return [];
	}
}

function writeRawToPaths(paths: string[], output: string): boolean {
	let wrote = false;
	for (const path of paths) {
		try {
			writeFileSync(path, output, "utf8");
			wrote = true;
		} catch {
			// Try remaining paths.
		}
	}
	return wrote;
}

function writeToTerminal(output: string): void {
	const tty = sourcePaneTty();
	try {
		writeFileSync(tty ?? "/dev/tty", output, "utf8");
		return;
	} catch {
		// Fall through to stdout best-effort.
	}
	try {
		if (process.stdout.isTTY) process.stdout.write(output);
	} catch {
		// Notification best-effort only.
	}
}

function writeTerminalSequence(sequence: string, cwd?: string): void {
	if (process.env.TMUX && settingBoolean("notification.tmuxNativeClientTty", true, cwd)) {
		// Inactive tmux windows do not forward arbitrary OSC output to the terminal.
		// Send native terminal notifications straight to attached tmux client TTYs,
		// while BEL still goes through the source pane so tmux marks the right tab.
		if (writeRawToPaths(tmuxClientTtys(), sequence)) return;
	}
	const output = process.env.TMUX && settingBoolean("notification.tmuxPassthrough", true, cwd) ? tmuxPassthrough(sequence) : sequence;
	writeToTerminal(output);
}

function writeTerminalBell(): void {
	// Match Claude-style hooks: resolve the source pane TTY and write raw BEL there.
	// This lets tmux set window_bell_flag for the correct source window.
	writeToTerminal("\x07");
}

function notifyOSC777(title: string, body: string, cwd?: string): void {
	writeTerminalSequence(`\x1b]777;notify;${title};${body}\x07`, cwd);
}

function notifyOSC99(title: string, body: string, cwd?: string): void {
	writeTerminalSequence(`\x1b]99;i=1:d=0;${title}\x1b\\`, cwd);
	writeTerminalSequence(`\x1b]99;i=1:p=body;${body}\x1b\\`, cwd);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => undefined);
}

function notifyNativeTerminal(title: string, body: string, cwd?: string): void {
	const protocol = settingString("notification.oscProtocol", "auto", cwd);
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
		return;
	}
	if (protocol === "off") return;
	if (protocol === "osc99" || (protocol === "auto" && process.env.KITTY_WINDOW_ID)) {
		notifyOSC99(title, body, cwd);
		return;
	}
	notifyOSC777(title, body, cwd);
}

function notifyTmux(title: string, body: string, cwd?: string): void {
	if (!process.env.TMUX && !process.env.TMUX_PANE) return;
	const duration = Math.max(500, Math.floor(settingNumber("notification.tmuxMessageDurationMs", DEFAULT_TMUX_MESSAGE_DURATION_MS, cwd)));
	const message = `${title}: ${body}`;
	const args = ["display-message", "-d", String(duration)];
	if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
	args.push(message);
	execFile("tmux", args, () => undefined);
}

function clearTmuxWindowMark(): void {
	if (tmuxWindowMarkTimer) clearTimeout(tmuxWindowMarkTimer);
	tmuxWindowMarkTimer = undefined;
	const target = tmuxMarkedTarget;
	const original = tmuxOriginalWindowName;
	tmuxMarkedTarget = undefined;
	tmuxOriginalWindowName = undefined;
	if (!target || !original) return;
	execFile("tmux", ["rename-window", "-t", target, original], () => undefined);
}

function markTmuxWindow(cwd?: string): void {
	if (!settingBoolean("notification.tmuxWindowMark", false, cwd)) return;
	if (!process.env.TMUX || !process.env.TMUX_PANE) return;
	const mark = sanitizeNotificationPart(settingString("notification.tmuxWindowMarkText", "!", cwd), 12) || "!";
	const prefix = `${mark} `;
	execFile("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{session_name}:#{window_index}"], (targetError, targetStdout) => {
		if (targetError) return;
		const target = targetStdout.trim();
		if (!target) return;
		execFile("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE!, "#W"], (nameError, nameStdout) => {
			if (nameError) return;
			const current = nameStdout.replace(/\r?\n$/, "");
			if (!current) return;
			const original = current.startsWith(prefix) ? current.slice(prefix.length) : current;
			if (!tmuxMarkedTarget || tmuxMarkedTarget !== target) {
				tmuxMarkedTarget = target;
				tmuxOriginalWindowName = original;
			}
			if (!current.startsWith(prefix)) execFile("tmux", ["rename-window", "-t", target, `${prefix}${current}`], () => undefined);
			const duration = Math.max(0, Math.floor(settingNumber("notification.tmuxWindowMarkDurationMs", 0, cwd)));
			if (tmuxWindowMarkTimer) clearTimeout(tmuxWindowMarkTimer);
			if (duration > 0) {
				tmuxWindowMarkTimer = setTimeout(clearTmuxWindowMark, duration);
				tmuxWindowMarkTimer.unref?.();
			}
		});
	});
}

function notificationEnabledFor(kind: QolNotificationKind, cwd?: string): boolean {
	if (!settingBoolean("notification.enabled", true, cwd)) return false;
	switch (kind) {
		case "ready": return settingBoolean("notification.onAgentReady", true, cwd);
		case "direction": return settingBoolean("notification.onDirectionNeeded", true, cwd);
		case "question": return settingBoolean("notification.onQuestion", true, cwd);
		case "task-complete": return settingBoolean("notification.onTaskComplete", true, cwd);
		case "critical": return settingBoolean("notification.onCritical", true, cwd);
		case "test": return true;
	}
}

function sendQolNotification(ctx: ExtensionContext | undefined, kind: QolNotificationKind, body: string, level: QolNotificationLevel = "info", key: string = kind): void {
	const cwd = ctx?.cwd;
	if (ctx && !ctx.hasUI) return;
	if (!notificationEnabledFor(kind, cwd)) return;
	const cooldownMs = Math.max(0, settingNumber("notification.cooldownSeconds", DEFAULT_NOTIFICATION_COOLDOWN_SECONDS, cwd) * 1000);
	const now = Date.now();
	const last = lastNotificationAt.get(key) ?? 0;
	if (cooldownMs > 0 && now - last < cooldownMs) return;
	lastNotificationAt.set(key, now);

	const title = sanitizeNotificationPart(settingString("notification.title", DEFAULT_NOTIFICATION_TITLE, cwd), 80) || DEFAULT_NOTIFICATION_TITLE;
	const text = sanitizeNotificationPart(body, Math.max(40, Math.floor(settingNumber("notification.bodyMaxChars", DEFAULT_NOTIFICATION_BODY_MAX_CHARS, cwd))));
	const tmuxWindowActive = sourceTmuxWindowActive();
	if (settingBoolean("notification.bell", true, cwd) && (!tmuxWindowActive || settingBoolean("notification.bellWhenActive", false, cwd))) writeTerminalBell();
	if (settingBoolean("notification.native", true, cwd)) notifyNativeTerminal(title, text, cwd);
	if (!tmuxWindowActive) markTmuxWindow(cwd);
	if (settingBoolean("notification.tmux", false, cwd)) notifyTmux(title, text, cwd);
	if (ctx?.hasUI && settingBoolean("notification.piUi", false, cwd)) ctx.ui.notify(text, level);
}

function questionNotificationTitle(request?: QuestionRequestLike): string {
	if (typeof request?.header === "string" && request.header.trim()) return request.header.trim();
	if (typeof request?.question === "string" && request.question.trim()) return request.question.trim();
	return "Question";
}

function notifyQuestionOpened(ctx: ExtensionContext | undefined, event: QuestionOpenedEventLike, keyPrefix = "question"): void {
	const title = questionNotificationTitle(event.request);
	const key = `${keyPrefix}:${event.requestId ?? title}`;
	const now = Date.now();
	const last = lastQuestionNotificationAt.get(key) ?? 0;
	if (now - last < QUESTION_NOTIFY_DEDUP_MS) return;
	lastQuestionNotificationAt.set(key, now);
	for (const [storedKey, timestamp] of lastQuestionNotificationAt) {
		if (now - timestamp > 60_000) lastQuestionNotificationAt.delete(storedKey);
	}
	sendQolNotification(ctx, "question", `Input required: ${title}`, "warning", key);
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveMaybeImagePath(path: string, cwd: string): string | undefined {
	const clean = stripAtPrefix(path);
	const expanded = expandHome(clean);
	const resolved = expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
	const lower = resolved.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0 || !IMAGE_EXTENSIONS.has(lower.slice(dot))) return undefined;
	if (!existsSync(resolved)) return undefined;
	return resolved;
}

function imagePathLabels(text: string, cwd: string): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(IMAGE_PATH_PATTERN)) {
		const resolved = resolveMaybeImagePath(match[2] ?? "", cwd);
		if (resolved) seen.add(`Image ${basename(resolved)}`);
	}
	return [...seen].sort();
}

function aliasState(): ImageAliasState {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[IMAGE_ALIAS_SYMBOL] as ImageAliasState | undefined;
	if (existing?.byLabel && existing.byPath) return existing;
	const created: ImageAliasState = { byLabel: {}, byPath: {}, next: 1 };
	host[IMAGE_ALIAS_SYMBOL] = created;
	return created;
}

function aliasForImagePath(path: string): string {
	const state = aliasState();
	const existing = state.byPath[path];
	if (existing) return existing;
	const label = `[Image #${state.next++}]`;
	state.byPath[path] = label;
	state.byLabel[label] = path;
	return label;
}

function collapseImagePathsInText(text: string, cwd: string): string {
	return text.replace(IMAGE_PATH_PATTERN, (match, prefix: string, rawPath: string) => {
		const resolved = resolveMaybeImagePath(rawPath, cwd);
		if (!resolved) return match;
		return `${prefix}${aliasForImagePath(resolved)}`;
	});
}

function aliasedImagePaths(text: string): string[] {
	const state = aliasState();
	const paths = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#\d+\]/gi)) {
		const path = state.byLabel[match[0]];
		if (path) paths.add(path);
	}
	return [...paths];
}

function mimeTypeForPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".bmp")) return "image/bmp";
	if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
	if (lower.endsWith(".heic")) return "image/heic";
	if (lower.endsWith(".heif")) return "image/heif";
	return "image/png";
}

function imageContentForPath(path: string): { type: "image"; data: string; mimeType: string } | undefined {
	try {
		return { data: readFileSync(path).toString("base64"), mimeType: mimeTypeForPath(path), type: "image" };
	} catch {
		return undefined;
	}
}

function attachmentLabels(text: string, cwd = process.cwd()): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(/\[Image\s+#(\d+)\]/gi)) {
		seen.add(`Image #${match[1]}`);
	}
	for (const label of imagePathLabels(text, cwd)) seen.add(label);
	return [...seen].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")) || a.localeCompare(b));
}

function chip(label: string, theme?: Theme): string {
	const text = ` ${label} `;
	if (theme) return theme.fg("accent", theme.inverse(text));
	return `[${label}]`;
}

interface VisibleMap {
	text: string;
	rawIndexByVisibleIndex: number[];
}

interface VisibleReplacement {
	start: number;
	end: number;
	text: string;
}

function ansiSequenceEnd(input: string, start: number): number {
	const introducer = input[start + 1];
	if (introducer == null) return start + 1;

	// OSC, DCS, APC, PM, SOS strings are zero-width and end in ST (ESC \\).
	// OSC may also end in BEL.
	if (introducer === "]" || introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
		const st = input.indexOf("\x1b\\", start + 2);
		const bell = introducer === "]" ? input.indexOf("\x07", start + 2) : -1;
		if (bell >= 0 && (st < 0 || bell < st)) return bell + 1;
		return st >= 0 ? st + 2 : input.length;
	}

	if (introducer === "[") {
		let index = start + 2;
		while (index < input.length) {
			const code = input.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
			index += 1;
		}
		return input.length;
	}

	return Math.min(start + 2, input.length);
}

function buildVisibleMap(input: string): VisibleMap {
	const rawIndexByVisibleIndex: number[] = [0];
	let text = "";
	let index = 0;

	while (index < input.length) {
		if (input.charCodeAt(index) === 0x1b) {
			index = ansiSequenceEnd(input, index);
			continue;
		}

		if (rawIndexByVisibleIndex[text.length] === undefined) rawIndexByVisibleIndex[text.length] = index;
		text += input[index] ?? "";
		index += 1;
		rawIndexByVisibleIndex[text.length] = index;
	}

	if (rawIndexByVisibleIndex[text.length] === undefined) rawIndexByVisibleIndex[text.length] = index;
	return { rawIndexByVisibleIndex, text };
}

function applyVisibleReplacements(input: string, map: VisibleMap, replacements: VisibleReplacement[]): string {
	if (replacements.length === 0) return input;

	const sorted = replacements
		.filter((replacement) => replacement.end > replacement.start)
		.sort((a, b) => a.start - b.start || b.end - a.end);

	let output = "";
	let lastRawIndex = 0;
	let lastVisibleIndex = 0;

	for (const replacement of sorted) {
		if (replacement.start < lastVisibleIndex) continue;
		const rawStart = map.rawIndexByVisibleIndex[replacement.start];
		const rawEnd = map.rawIndexByVisibleIndex[replacement.end];
		if (rawStart == null || rawEnd == null || rawStart < lastRawIndex) continue;

		output += input.slice(lastRawIndex, rawStart) + replacement.text;
		lastRawIndex = rawEnd;
		lastVisibleIndex = replacement.end;
	}

	return output + input.slice(lastRawIndex);
}

function imageChipReplacements(visibleText: string, cwd: string, theme?: Theme): VisibleReplacement[] {
	const replacements: VisibleReplacement[] = [];

	for (const match of visibleText.matchAll(/\[Image\s+#(\d+)\]/gi)) {
		const start = match.index ?? 0;
		replacements.push({
			start,
			end: start + match[0].length,
			text: chip(`Image #${match[1]}`, theme),
		});
	}

	let imageIndex = 0;
	for (const match of visibleText.matchAll(IMAGE_PATH_PATTERN)) {
		const prefix = match[1] ?? "";
		const rawPath = match[2] ?? "";
		const resolved = resolveMaybeImagePath(rawPath, cwd);
		if (!resolved) continue;

		imageIndex += 1;
		const start = (match.index ?? 0) + prefix.length;
		replacements.push({
			start,
			end: start + rawPath.length,
			text: chip(`Image ${imageIndex}`, theme),
		});
	}

	return replacements;
}

function styleImageChips(line: string, cwd: string, theme?: Theme): string {
	if (!settingBoolean("showImageChips", true, cwd)) return line;
	const map = buildVisibleMap(line);
	const replacements = imageChipReplacements(map.text, cwd, theme);
	return replacements.length === 0 ? line : applyVisibleReplacements(line, map, replacements);
}

function statusText(ctx: ExtensionContext, text: string): string | undefined {
	if (!settingBoolean("showAttachmentCountInStatus", true, ctx.cwd)) return undefined;
	const count = attachmentLabels(text, ctx.cwd).length;
	return count > 0 ? `images:${count}` : undefined;
}

class QolEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
	) {
		super(tui, editorTheme, keybindings);
	}

	handleInput(data: string): void {
		const fallback = newlineFallbackKey(this.ctx.cwd);
		const newlineEnabled = settingBoolean("newlineOnShiftEnter", true, this.ctx.cwd);
		const isShiftEnter = matchesKey(data, "shift+enter") || matchesKey(data, "shift+return");
		const isFallback = fallback !== "none" && matchesKey(data, fallback);
		if (newlineEnabled && (isShiftEnter || isFallback)) {
			super.handleInput("\n");
			this.collapseImagePaths();
			this.refreshAttachmentStatus();
			return;
		}
		super.handleInput(data);
		this.collapseImagePaths();
		this.refreshAttachmentStatus();
	}

	render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(styleImageChips(line, this.ctx.cwd, this.ctx.ui.theme), width, ""));
	}

	private collapseImagePaths(): void {
		if (!settingBoolean("showImageChips", true, this.ctx.cwd)) return;
		const text = this.getText();
		const collapsed = collapseImagePathsInText(text, this.ctx.cwd);
		if (collapsed !== text) this.setText(collapsed);
	}

	private refreshAttachmentStatus(): void {
		const text = this.getText();
		this.ctx.ui.setStatus(STATUS_KEY, statusText(this.ctx, text));
	}
}

function currentEditorText(ctx: ExtensionContext): string {
	try {
		return ctx.ui.getEditorText?.() ?? "";
	} catch {
		return "";
	}
}

function collapseEditorImagePaths(ctx: ExtensionContext): boolean {
	if (!settingBoolean("showImageChips", true, ctx.cwd)) return false;
	const text = currentEditorText(ctx);
	if (!text) return false;
	const collapsed = collapseImagePathsInText(text, ctx.cwd);
	if (collapsed === text) return false;
	ctx.ui.setEditorText(collapsed);
	ctx.ui.setStatus(STATUS_KEY, statusText(ctx, collapsed));
	return true;
}

type QolSummaryProfile = "concise" | "balanced" | "exhaustive";
type QolSummaryPurpose = "compaction" | "branch-summary" | "session-search";

const QOL_COMPACTION_SYSTEM_PROMPT = "You summarize coding-agent sessions for continuation. Preserve exact technical facts, filenames, commands, constraints, decisions, blockers, and next actions. Do not invent details.";

function compactionNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI && settingBoolean("compaction.notify", true, ctx.cwd)) ctx.ui.notify(message, level);
}

function compactionProfile(cwd: string): QolSummaryProfile {
	const value = settingString("compaction.profile", "balanced", cwd);
	return value === "concise" || value === "exhaustive" ? value : "balanced";
}

function compactionProfileInstructions(profile: QolSummaryProfile): string {
	if (profile === "concise") return "Prefer a compact continuation summary. Include only decisions, current state, modified/read files, blockers, and concrete next steps.";
	if (profile === "exhaustive") return "Be thorough. The summary may replace substantial conversation history, so preserve all relevant implementation details, alternatives considered, exact file paths, commands, errors, and pending work.";
	return "Be complete but not verbose. Preserve enough detail for a future assistant to continue without the old transcript.";
}

function buildSummaryPrompt(options: {
	conversationText: string;
	customInstructions?: string;
	previousSummary?: string;
	profile: QolSummaryProfile;
	purpose: QolSummaryPurpose;
}): string {
	const purposeText = options.purpose === "branch-summary"
		? "the branch being left during /tree navigation"
		: options.purpose === "session-search"
			? "the previous session being imported into the current context"
			: "the conversation span being compacted";
	const previous = options.previousSummary ? `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n` : "";
	const custom = options.customInstructions?.trim() ? `<custom-instructions>\n${options.customInstructions.trim()}\n</custom-instructions>\n\n` : "";
	return `${custom}${previous}<conversation>\n${options.conversationText}\n</conversation>\n\nSummarize ${purposeText} for a coding agent that must continue the work.\n\n${compactionProfileInstructions(options.profile)}\n\nUse this markdown shape:\n\n## Goal\n[What the user is trying to accomplish]\n\n## Constraints & Preferences\n- [Requirements, style, safety, or user preferences]\n\n## Progress\n### Done\n- [x] [Completed work]\n\n### In Progress\n- [ ] [Current partial work]\n\n### Blocked\n- [Blockers or none]\n\n## Key Decisions\n- **[Decision]**: [Rationale]\n\n## Files & Commands\n- [Files read/modified and important commands/results]\n\n## Next Steps\n1. [Most important next action]\n\n## Critical Context\n- [Anything easy to lose but needed later]`;
}

async function summarizeWithRemote(endpoint: string, systemPrompt: string, promptText: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
	const response = await fetch(endpoint, {
		body: JSON.stringify({ maxTokens, prompt: promptText, systemPrompt }),
		headers: { "content-type": "application/json" },
		method: "POST",
		signal,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Remote compaction endpoint returned ${response.status}: ${text.slice(0, 500)}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Remote compaction endpoint did not return JSON");
	}
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		if (typeof record.summary === "string") return record.summary;
		if (typeof record.text === "string") return record.text;
	}
	throw new Error("Remote compaction response missing summary");
}

function resolveConfiguredModel(ctx: ExtensionContext, configured: string): any | undefined {
	if (!configured || configured === "current") return ctx.model;
	const withoutThinking = configured.replace(/:(off|minimal|low|medium|high|xhigh)$/i, "");
	const slash = withoutThinking.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(withoutThinking.slice(0, slash), withoutThinking.slice(slash + 1));
	const providers = [ctx.model?.provider, "google", "openai", "anthropic", "mistral", "moonshot", "cloudflare-ai-gateway", "cloudflare-workers-ai"].filter((value): value is string => typeof value === "string");
	for (const provider of providers) {
		const model = ctx.modelRegistry.find(provider, withoutThinking);
		if (model) return model;
	}
	return undefined;
}

function resolveCompactionModel(ctx: ExtensionContext): any | undefined {
	return resolveConfiguredModel(ctx, settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd));
}

function modelLabel(model: any): string {
	return model ? `${model.provider}/${model.id}` : "unknown model";
}

async function generateQolSummary(ctx: ExtensionContext, options: {
	conversationText: string;
	customInstructions?: string;
	previousSummary?: string;
	maxTokens?: number;
	model?: string;
	purpose: QolSummaryPurpose;
	signal?: AbortSignal;
}): Promise<{ model: string; summary: string; via: "model" | "remote" }> {
	const maxTokens = Math.max(256, Math.floor(options.maxTokens ?? settingNumber("compaction.maxTokens", DEFAULT_COMPACTION_MAX_TOKENS, ctx.cwd)));
	const promptText = buildSummaryPrompt({
		conversationText: options.conversationText,
		customInstructions: options.customInstructions,
		previousSummary: settingBoolean("compaction.includePreviousSummary", true, ctx.cwd) ? options.previousSummary : undefined,
		profile: compactionProfile(ctx.cwd),
		purpose: options.purpose,
	});

	const remoteEndpoint = settingString("compaction.remoteEndpoint", "", ctx.cwd);
	if (settingBoolean("compaction.remoteEnabled", false, ctx.cwd) && remoteEndpoint) {
		try {
			const summary = await summarizeWithRemote(remoteEndpoint, QOL_COMPACTION_SYSTEM_PROMPT, promptText, maxTokens, options.signal);
			return { model: remoteEndpoint, summary, via: "remote" };
		} catch (error) {
			compactionNotify(ctx, `Remote compaction failed, trying model fallback: ${stringifyError(error)}`, "warning");
		}
	}

	const configuredModel = options.model ?? settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd);
	const model = resolveConfiguredModel(ctx, configuredModel);
	if (!model) throw new Error(`Summary model not found: ${configuredModel}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`);

	const message: Message = {
		content: [{ text: promptText, type: "text" }],
		role: "user",
		timestamp: Date.now(),
	};
	const response = await complete(
		model,
		{ messages: [message], systemPrompt: QOL_COMPACTION_SYSTEM_PROMPT },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal: options.signal },
	);
	const summary = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	return { model: modelLabel(model), summary, via: "model" };
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function handleQolCompaction(event: any, ctx: ExtensionContext): Promise<any> {
	if (!settingBoolean("compaction.customEnabled", false, ctx.cwd)) return undefined;
	const preparation = event.preparation ?? {};
	const messages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
	if (messages.length === 0) return undefined;
	const tokensBefore = typeof preparation.tokensBefore === "number" ? preparation.tokensBefore : 0;
	compactionNotify(ctx, `QOL compaction: summarizing ${messages.length} message(s), ${tokensBefore.toLocaleString()} token(s).`, "info");
	try {
		const conversationText = serializeConversation(convertToLlm(messages));
		const result = await generateQolSummary(ctx, {
			conversationText,
			customInstructions: event.customInstructions,
			previousSummary: preparation.previousSummary,
			purpose: "compaction",
			signal: event.signal,
		});
		if (!result.summary.trim()) throw new Error("Compaction summary was empty");
		compactionNotify(ctx, `QOL compaction complete via ${result.via}: ${result.model}`, "info");
		return {
			compaction: {
				details: {
					messageCount: messages.length,
					model: result.model,
					profile: compactionProfile(ctx.cwd),
					source: "pi-qol",
					via: result.via,
				},
				firstKeptEntryId: preparation.firstKeptEntryId,
				summary: result.summary,
				tokensBefore: preparation.tokensBefore,
			},
		};
	} catch (error) {
		if (event.signal?.aborted) return undefined;
		compactionNotify(ctx, `QOL compaction failed: ${stringifyError(error)}`, "error");
		return settingBoolean("compaction.fallbackToDefault", true, ctx.cwd) ? undefined : { cancel: true };
	}
}

function summarizeEntryForBranch(entry: any): string[] {
	if (entry?.type === "message" && entry.message) return [serializeConversation(convertToLlm([entry.message]))];
	if (entry?.type === "compaction" && typeof entry.summary === "string") return [`[Compaction summary]: ${entry.summary}`];
	if (entry?.type === "branch_summary" && typeof entry.summary === "string") return [`[Branch summary]: ${entry.summary}`];
	if (entry?.type === "custom_message") return [`[Custom message${entry.customType ? `:${entry.customType}` : ""}]: ${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.data ?? {})}`];
	return [];
}

async function handleQolBranchSummary(event: any, ctx: ExtensionContext): Promise<any> {
	if (!settingBoolean("compaction.branchSummaryEnabled", false, ctx.cwd)) return undefined;
	const preparation = event.preparation ?? {};
	if (preparation.userWantsSummary !== true) return undefined;
	const entries = Array.isArray(preparation.entriesToSummarize) ? preparation.entriesToSummarize : [];
	const conversationText = entries.flatMap(summarizeEntryForBranch).join("\n\n").trim();
	if (!conversationText) return undefined;
	compactionNotify(ctx, `QOL branch summary: summarizing ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`, "info");
	try {
		const result = await generateQolSummary(ctx, {
			conversationText,
			customInstructions: event.customInstructions ?? preparation.customInstructions,
			purpose: "branch-summary",
			signal: event.signal,
		});
		if (!result.summary.trim()) throw new Error("Branch summary was empty");
		return {
			summary: {
				details: { entryCount: entries.length, model: result.model, profile: compactionProfile(ctx.cwd), source: "pi-qol", via: result.via },
				summary: result.summary,
			},
		};
	} catch (error) {
		if (event.signal?.aborted) return undefined;
		compactionNotify(ctx, `QOL branch summary failed: ${stringifyError(error)}`, "error");
		return undefined;
	}
}

function contextUsage(ctx: ExtensionContext): { contextWindow?: number; tokens: number } | undefined {
	const usage = ctx.getContextUsage?.() as { tokens?: unknown; contextWindow?: unknown } | undefined;
	const tokens = Number(usage?.tokens);
	if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
	const contextWindow = Number(usage?.contextWindow ?? ctx.model?.contextWindow);
	return { contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined, tokens };
}

function compactionTriggerReason(ctx: ExtensionContext): string | undefined {
	const usage = contextUsage(ctx);
	if (!usage) return undefined;
	const tokenLimit = settingNumber("compaction.thresholdTokens", -1, ctx.cwd);
	if (tokenLimit > 0 && usage.tokens >= tokenLimit) return `${usage.tokens.toLocaleString()} tokens >= ${Math.floor(tokenLimit).toLocaleString()} token limit`;
	const percentLimit = settingNumber("compaction.thresholdPercent", -1, ctx.cwd);
	if (percentLimit > 0 && usage.contextWindow) {
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent >= percentLimit) return `${percent.toFixed(1)}% context >= ${percentLimit}% limit`;
	}
	const idleLimit = settingNumber("compaction.idleThresholdTokens", DEFAULT_IDLE_COMPACTION_THRESHOLD_TOKENS, ctx.cwd);
	if (usage.tokens >= idleLimit) return `${usage.tokens.toLocaleString()} tokens >= ${Math.floor(idleLimit).toLocaleString()} idle threshold`;
	return undefined;
}

type QolContextColor = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "borderMuted" | "text";

interface QolContextDetailItem {
	label: string;
	tokens: number;
	description?: string;
	group?: string;
}

interface QolContextCategory {
	key: string;
	label: string;
	rawTokens: number;
	tokens: number;
	color: QolContextColor;
	icon: string;
}

interface QolContextUsageMessageDetails {
	usage: {
		contextWindow?: number;
		percent?: number;
		tokens: number;
	};
	model: {
		contextWindow?: number;
		id: string;
		label: string;
		provider: string;
		thinking?: string;
	};
	categories: QolContextCategory[];
	freeTokens?: number;
	contextFiles: QolContextDetailItem[];
	skills: QolContextDetailItem[];
	customAgents: QolContextDetailItem[];
	builtinTools: QolContextDetailItem[];
	extensionTools: QolContextDetailItem[];
	mcpTools: QolContextDetailItem[];
	messageStats: {
		assistant: number;
		bash: number;
		branchEntries: number;
		compact: number;
		contextMessages: number;
		custom: number;
		toolResult: number;
		user: number;
	};
	compactSummaries: QolContextDetailItem[];
	note?: string;
}

function qcuSafeString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, current) => {
			if (typeof current === "function") return undefined;
			if (typeof current === "object" && current !== null) {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		}) ?? "";
	} catch {
		return String(value);
	}
}

function qcuEstimateTokens(value: unknown): number {
	const text = qcuSafeString(value);
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

function qcuFormatTokens(value: number | undefined): string {
	const n = Math.max(0, Math.round(Number(value) || 0));
	const trim = (input: number) => input.toFixed(input >= 10 ? 0 : 1).replace(/\.0$/, "");
	if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
	if (n >= 1_000) return `${trim(n / 1_000)}K`;
	return n.toLocaleString();
}

function qcuPercent(tokens: number, contextWindow?: number): string {
	if (!contextWindow || contextWindow <= 0) return "--";
	return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

function qcuPadAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function qcuOneLine(text: string, maxWidth: number): string {
	return truncateToWidth(text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(), maxWidth, "…");
}

function qcuDetailLabel(item: unknown, fallback: string): string {
	if (typeof item === "string") return qcuOneLine(item, 90) || fallback;
	if (!item || typeof item !== "object") return fallback;
	const obj = item as Record<string, unknown>;
	const raw = obj.name ?? obj.title ?? obj.label ?? obj.id ?? obj.path ?? obj.file ?? obj.filePath ?? obj.sourcePath ?? obj.description ?? fallback;
	const label = typeof raw === "string" ? raw : fallback;
	return qcuOneLine(label, 90) || fallback;
}

function qcuDetailText(item: unknown): string {
	if (typeof item === "string") return item;
	if (!item || typeof item !== "object") return qcuSafeString(item);
	const obj = item as Record<string, unknown>;
	const direct = obj.content ?? obj.text ?? obj.markdown ?? obj.body ?? obj.instructions ?? obj.description ?? obj.prompt;
	if (typeof direct === "string") return direct;
	const pathValue = obj.path ?? obj.file ?? obj.filePath ?? obj.sourcePath;
	if (typeof pathValue === "string" && isAbsolute(pathValue) && existsSync(pathValue)) {
		try {
			return readFileSync(pathValue, "utf8");
		} catch {
			// Fall through to a safe structural estimate.
		}
	}
	return qcuSafeString(item);
}

function qcuDetailsFromItems(items: unknown[], fallbackGroup?: string): QolContextDetailItem[] {
	return items
		.map((item, index) => {
			const obj = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
			const sourceInfo = obj?.sourceInfo && typeof obj.sourceInfo === "object" ? obj.sourceInfo as Record<string, unknown> : undefined;
			const group = typeof obj?.scope === "string" ? obj.scope : typeof sourceInfo?.scope === "string" ? sourceInfo.scope : typeof sourceInfo?.source === "string" ? sourceInfo.source : fallbackGroup;
			const description = typeof obj?.description === "string" ? obj.description : undefined;
			return {
				description: description ? qcuOneLine(description, 120) : undefined,
				group,
				label: qcuDetailLabel(item, `item-${index + 1}`),
				tokens: qcuEstimateTokens(qcuDetailText(item)),
			};
		})
		.filter((item) => item.tokens > 0 || item.label.length > 0);
}

function qcuPromptOptionArray(options: unknown, keys: string[]): unknown[] {
	if (!options || typeof options !== "object") return [];
	const obj = options as Record<string, unknown>;
	for (const key of keys) {
		const value = obj[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}

function qcuUniqDetails(items: QolContextDetailItem[]): QolContextDetailItem[] {
	const byLabel = new Map<string, QolContextDetailItem>();
	for (const item of items) {
		const key = `${item.group ?? ""}:${item.label}`;
		const existing = byLabel.get(key);
		if (!existing || item.tokens > existing.tokens) byLabel.set(key, item);
	}
	return Array.from(byLabel.values()).sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

function qcuTokenSum(items: QolContextDetailItem[]): number {
	return items.reduce((sum, item) => sum + Math.max(0, item.tokens), 0);
}

function qcuMessageTokens(message: any): number {
	if (!message || typeof message !== "object") return 0;
	if (message.role === "bashExecution" && message.excludeFromContext === true) return 0;
	if (message.role === "compactionSummary") return qcuEstimateTokens(message.summary ?? "");
	if (message.role === "branchSummary") return qcuEstimateTokens(message.summary ?? "");
	if (message.role === "custom") return qcuEstimateTokens(message.content ?? "");
	const content = message.content;
	if (typeof content === "string") return qcuEstimateTokens(content);
	if (!Array.isArray(content)) return qcuEstimateTokens(content);
	return content.reduce((sum: number, part: any) => {
		if (part?.type === "text") return sum + qcuEstimateTokens(part.text ?? "");
		if (part?.type === "thinking") return sum + qcuEstimateTokens(part.thinking ?? "");
		if (part?.type === "toolCall") return sum + qcuEstimateTokens(part);
		if (part?.type === "image") return sum + 85;
		return sum + qcuEstimateTokens(part);
	}, 0);
}

function qcuBuildMessageStats(ctx: ExtensionContext): { rawMessageTokens: number; rawCompactTokens: number; stats: QolContextUsageMessageDetails["messageStats"]; compactSummaries: QolContextDetailItem[] } {
	const sm = ctx.sessionManager as any;
	const branch = Array.isArray(sm.getBranch?.()) ? sm.getBranch() : [];
	const built = typeof sm.buildSessionContext === "function" ? sm.buildSessionContext() : undefined;
	const messages = Array.isArray(built?.messages) ? built.messages : branch.filter((entry: any) => entry?.type === "message").map((entry: any) => entry.message);
	const stats = { assistant: 0, bash: 0, branchEntries: branch.length, compact: 0, contextMessages: messages.length, custom: 0, toolResult: 0, user: 0 };
	let rawMessageTokens = 0;
	let rawCompactTokens = 0;
	for (const message of messages) {
		const tokens = qcuMessageTokens(message);
		switch (message?.role) {
			case "user": stats.user += 1; rawMessageTokens += tokens; break;
			case "assistant": stats.assistant += 1; rawMessageTokens += tokens; break;
			case "toolResult": stats.toolResult += 1; rawMessageTokens += tokens; break;
			case "bashExecution": stats.bash += 1; rawMessageTokens += tokens; break;
			case "custom": stats.custom += 1; rawMessageTokens += tokens; break;
			case "compactionSummary":
			case "branchSummary":
				stats.compact += 1;
				rawCompactTokens += tokens;
				break;
			default:
				rawMessageTokens += tokens;
		}
	}
	const compactSummaries = branch
		.filter((entry: any) => entry?.type === "compaction" || entry?.type === "branch_summary")
		.map((entry: any) => ({
			group: entry.type === "compaction" ? "compaction" : "branch",
			label: entry.type === "compaction" ? `Compaction${entry.tokensBefore ? ` (${qcuFormatTokens(Number(entry.tokensBefore))} before)` : ""}` : "Branch summary",
			tokens: qcuEstimateTokens(entry.summary ?? ""),
		}))
		.reverse();
	return { compactSummaries, rawCompactTokens, rawMessageTokens, stats };
}

function qcuToolDetails(pi: ExtensionAPI): {
	builtinTools: QolContextDetailItem[];
	extensionTools: QolContextDetailItem[];
	mcpTools: QolContextDetailItem[];
	rawBuiltinToolTokens: number;
	rawExtensionToolTokens: number;
	rawMcpToolTokens: number;
} {
	const api = pi as any;
	const activeNames = new Set<string>(Array.isArray(api.getActiveTools?.()) ? api.getActiveTools() : []);
	const allTools = Array.isArray(api.getAllTools?.()) ? api.getAllTools() : [];
	const activeTools = allTools.filter((tool: any) => typeof tool?.name === "string" && (activeNames.size === 0 || activeNames.has(tool.name)));
	const details = activeTools.map((tool: any) => {
		const sourceInfo = tool.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo : undefined;
		const source = typeof sourceInfo?.source === "string" ? sourceInfo.source : undefined;
		return {
			description: typeof tool.description === "string" ? qcuOneLine(tool.description, 120) : undefined,
			group: source,
			label: tool.name,
			tokens: qcuEstimateTokens({ description: tool.description, name: tool.name, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines, promptSnippet: tool.promptSnippet }),
		};
	});
	const isMcpTool = (tool: QolContextDetailItem) => /^mcp_{1,2}/i.test(tool.label) || /mcp/i.test(tool.group ?? "");
	const mcpTools = details.filter(isMcpTool);
	const builtinTools = details.filter((tool) => !isMcpTool(tool) && (tool.group === "builtin" || tool.group === "sdk"));
	const extensionTools = details.filter((tool) => !isMcpTool(tool) && tool.group !== "builtin" && tool.group !== "sdk");
	return {
		builtinTools: qcuUniqDetails(builtinTools),
		extensionTools: qcuUniqDetails(extensionTools),
		mcpTools: qcuUniqDetails(mcpTools),
		rawBuiltinToolTokens: qcuTokenSum(builtinTools),
		rawExtensionToolTokens: qcuTokenSum(extensionTools),
		rawMcpToolTokens: qcuTokenSum(mcpTools),
	};
}

function qcuSkillDetails(pi: ExtensionAPI, promptOptions: unknown): QolContextDetailItem[] {
	const fromOptions = qcuDetailsFromItems(qcuPromptOptionArray(promptOptions, ["skills", "loadedSkills", "availableSkills"]), "loaded");
	const commands = Array.isArray((pi as any).getCommands?.()) ? (pi as any).getCommands() : [];
	const fromCommands = commands
		.filter((command: any) => command?.source === "skill")
		.map((command: any) => {
			const sourceInfo = command.sourceInfo && typeof command.sourceInfo === "object" ? command.sourceInfo : undefined;
			return {
				description: typeof command.description === "string" ? qcuOneLine(command.description, 120) : undefined,
				group: typeof sourceInfo?.scope === "string" ? sourceInfo.scope : typeof sourceInfo?.source === "string" ? sourceInfo.source : "skill",
				label: String(command.name ?? "skill").replace(/^skill:/, ""),
				tokens: qcuEstimateTokens(`${command.name ?? ""}\n${command.description ?? ""}`),
			};
		});
	return qcuUniqDetails([...fromOptions, ...fromCommands]);
}

function qcuScaleCategories(rawCategories: Array<Omit<QolContextCategory, "tokens">>, totalTokens: number, contextWindow?: number): QolContextCategory[] {
	const rawTotal = rawCategories.reduce((sum, category) => sum + Math.max(0, category.rawTokens), 0);
	if (rawTotal <= 0) {
		return [{ color: "accent", icon: "◉", key: "messages", label: "Messages", rawTokens: totalTokens, tokens: totalTokens }];
	}
	const ratio = totalTokens / rawTotal;
	const categories = rawCategories
		.map((category) => ({ ...category, tokens: Math.max(0, Math.round(category.rawTokens * ratio)) }))
		.filter((category) => category.tokens > 0 || category.rawTokens > 0);
	const scaledTotal = categories.reduce((sum, category) => sum + category.tokens, 0);
	const delta = totalTokens - scaledTotal;
	const messages = categories.find((category) => category.key === "messages") ?? categories[categories.length - 1];
	if (messages && delta !== 0) messages.tokens = Math.max(0, messages.tokens + delta);
	const used = categories.reduce((sum, category) => sum + category.tokens, 0);
	if (contextWindow && used < totalTokens) {
		const other = totalTokens - used;
		if (other > 0) categories.push({ color: "dim", icon: "◉", key: "other", label: "Other", rawTokens: other, tokens: other });
	}
	return categories;
}

function qcuExtractProjectSubagents(systemPrompt: string): { agents: QolContextDetailItem[]; tokens: number } {
	const marker = "## Project Subagents";
	const start = systemPrompt.indexOf(marker);
	if (start < 0) return { agents: [], tokens: 0 };
	const rest = systemPrompt.slice(start);
	const next = rest.slice(marker.length).search(/\n##\s+/);
	const section = next >= 0 ? rest.slice(0, marker.length + next) : rest;
	const agents = section
		.split(/\r?\n/)
		.filter((line) => line.startsWith("- "))
		.map((line) => {
			const match = line.match(/^-\s*([^:]+):\s*(.*?)(?:\s*\(([^)]*)\))?$/);
			return {
				description: match?.[2] ? qcuOneLine(match[2], 120) : undefined,
				group: match?.[3]?.includes("project") ? "project" : match?.[3]?.includes("user") ? "user" : "agent",
				label: qcuOneLine(match?.[1] ?? line.replace(/^[-\s]+/, ""), 90),
				tokens: qcuEstimateTokens(line),
			};
		});
	return { agents: qcuUniqDetails(agents), tokens: qcuEstimateTokens(section) };
}

function buildQolContextUsageDetails(pi: ExtensionAPI, ctx: ExtensionCommandContext, promptOptions: unknown): QolContextUsageMessageDetails | undefined {
	const usage = ctx.getContextUsage?.() as { contextWindow?: unknown; percent?: unknown; tokens?: unknown } | undefined;
	const tokens = Number(usage?.tokens);
	if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
	const model = (ctx as any).model ?? {};
	const contextWindow = Number(usage?.contextWindow ?? model.contextWindow);
	const safeContextWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
	const percent = Number(usage?.percent);
	const systemPrompt = ctx.getSystemPrompt?.() ?? "";
	const contextFiles = qcuUniqDetails(qcuDetailsFromItems(qcuPromptOptionArray(promptOptions, ["contextFiles", "agentsFiles", "memoryFiles"]), "context"));
	const skills = qcuSkillDetails(pi, promptOptions);
	const extractedSubagents = qcuExtractProjectSubagents(systemPrompt);
	const customAgents = qcuUniqDetails([...qcuDetailsFromItems(qcuPromptOptionArray(promptOptions, ["customAgents", "agents", "agentSnippets"]), "agent"), ...extractedSubagents.agents]);
	const { builtinTools, extensionTools, mcpTools, rawBuiltinToolTokens, rawExtensionToolTokens, rawMcpToolTokens } = qcuToolDetails(pi);
	const { compactSummaries, rawCompactTokens, rawMessageTokens, stats } = qcuBuildMessageStats(ctx);
	const rawCompactSummaryTokens = rawCompactTokens > 0 ? rawCompactTokens : qcuTokenSum(compactSummaries);
	const rawContextFiles = qcuTokenSum(contextFiles);
	const rawSkills = qcuTokenSum(skills);
	const rawCustomAgents = Math.max(qcuTokenSum(customAgents), extractedSubagents.tokens);
	const rawSystemPromptTotal = qcuEstimateTokens(systemPrompt);
	const rawSystemPrompt = Math.max(0, rawSystemPromptTotal - rawContextFiles - rawSkills - rawCustomAgents);
	const categories = qcuScaleCategories([
		{ color: "muted", icon: "◉", key: "system", label: "System prompt", rawTokens: rawSystemPrompt },
		{ color: "warning", icon: "◉", key: "builtinTools", label: "Built-in tools", rawTokens: rawBuiltinToolTokens },
		{ color: "error", icon: "◉", key: "extensionTools", label: "Extension tools", rawTokens: rawExtensionToolTokens },
		{ color: "warning", icon: "◉", key: "mcpTools", label: "MCP tools", rawTokens: rawMcpToolTokens },
		{ color: "success", icon: "◉", key: "agents", label: "Custom agents", rawTokens: rawCustomAgents },
		{ color: "error", icon: "◉", key: "contextFiles", label: "Context / memory files", rawTokens: rawContextFiles },
		{ color: "success", icon: "◉", key: "skills", label: "Skills", rawTokens: rawSkills },
		{ color: "accent", icon: "◉", key: "messages", label: "Messages", rawTokens: rawMessageTokens },
		{ color: "muted", icon: "◉", key: "compact", label: "Compact buffer", rawTokens: rawCompactSummaryTokens },
	], tokens, safeContextWindow);
	const modelProvider = typeof model.provider === "string" ? model.provider : "unknown";
	const modelId = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : "unknown";
	const modelName = typeof model.name === "string" ? model.name : modelId;
	const thinking = typeof (pi as any).getThinkingLevel === "function" ? (pi as any).getThinkingLevel() : undefined;
	return {
		builtinTools,
		categories,
		compactSummaries,
		contextFiles,
		customAgents,
		extensionTools,
		freeTokens: safeContextWindow ? Math.max(0, safeContextWindow - tokens) : undefined,
		mcpTools,
		messageStats: stats,
		model: {
			contextWindow: safeContextWindow,
			id: modelId,
			label: modelName,
			provider: modelProvider,
			thinking: typeof thinking === "string" && thinking !== "off" ? thinking : undefined,
		},
		note: promptOptions ? undefined : "Context-file and skill breakdowns become more precise after the next agent turn.",
		skills,
		usage: {
			contextWindow: safeContextWindow,
			percent: Number.isFinite(percent) ? percent : safeContextWindow ? (tokens / safeContextWindow) * 100 : undefined,
			tokens,
		},
	};
}

function qcuLimitDetails(items: QolContextDetailItem[], limit: number): QolContextDetailItem[] {
	return items.slice(0, Math.max(0, limit));
}

function qcuBranch(theme: Theme, branch: "├" | "└" | "│"): string {
	if (branch === "│") return theme.fg("muted", "│  ");
	return theme.fg("muted", `${branch}─ `);
}

function qcuStem(theme: Theme, isLast: boolean): string {
	return isLast ? theme.fg("borderMuted", "   ") : qcuBranch(theme, "│");
}

function qcuRenderDetailSection(lines: string[], title: string, items: QolContextDetailItem[], theme: Theme, options: { empty?: string; limit?: number; showDescriptions?: boolean } = {}): void {
	if (items.length === 0) {
		if (options.empty) {
			lines.push("");
			lines.push(`${theme.fg("customMessageLabel", theme.bold(title))}`);
			lines.push(`${qcuBranch(theme, "└")}${theme.fg("dim", options.empty)}`);
		}
		return;
	}
	const visible = qcuLimitDetails(items, options.limit ?? 10);
	lines.push("");
	lines.push(`${theme.fg("customMessageLabel", theme.bold(title))}`);
	visible.forEach((item, index) => {
		const isLast = index === visible.length - 1 && visible.length === items.length;
		const branch = isLast ? "└" : "├";
		const group = item.group ? theme.fg("dim", ` ${item.group}`) : "";
		lines.push(`${qcuBranch(theme, branch)}${theme.fg("text", qcuOneLine(item.label, 72))}: ${theme.fg("accent", qcuFormatTokens(item.tokens))} tokens${group}`);
		if (options.showDescriptions && item.description) lines.push(`${qcuStem(theme, isLast)}${theme.fg("dim", qcuOneLine(item.description, 100))}`);
	});
	if (items.length > visible.length) lines.push(`${qcuBranch(theme, "└")}${theme.fg("dim", `… ${items.length - visible.length} more`)}`);
}

function renderQolContextUsageMessage(message: any, _options: any, theme: Theme): { render(width: number): string[]; invalidate(): void } {
	const details = message?.details as QolContextUsageMessageDetails | undefined;
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!details) return [theme.fg("warning", "Context usage details unavailable.")];
			const safeWidth = Math.max(48, width);
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", "› /context")}`);
			lines.push(`└ ${theme.fg("customMessageLabel", theme.bold("Context Usage"))}`);
			const gridCols = safeWidth >= 112 ? 28 : safeWidth >= 88 ? 22 : 16;
			const gridRows = safeWidth >= 88 ? 7 : 6;
			const totalBlocks = gridCols * gridRows;
			const contextWindow = details.usage.contextWindow;
			const gridDenominator = contextWindow ?? details.usage.tokens;
			const blockCategories: QolContextCategory[] = [];
			for (const category of details.categories) {
				if (!gridDenominator || category.tokens <= 0) continue;
				let count = Math.round((category.tokens / gridDenominator) * totalBlocks);
				if (count === 0 && category.tokens > 0) count = 1;
				for (let index = 0; index < count && blockCategories.length < totalBlocks; index += 1) blockCategories.push(category);
			}
			const gridLines: string[] = [];
			for (let row = 0; row < gridRows; row += 1) {
				let line = "";
				for (let col = 0; col < gridCols; col += 1) {
					const category = blockCategories[row * gridCols + col];
					line += category ? theme.fg(category.color as any, category.icon) : theme.fg("borderMuted", "□");
					if (col !== gridCols - 1) line += " ";
				}
				gridLines.push(line);
			}
			const modelBits = [`${details.model.provider}/${details.model.id}`];
			if (details.model.thinking) modelBits.push(`thinking ${details.model.thinking}`);
			const summaryLines = [
				`${theme.fg("text", theme.bold(details.model.label))}${contextWindow ? theme.fg("muted", ` (${qcuFormatTokens(contextWindow)} context)`) : ""}`,
				theme.fg("muted", modelBits.join(" · ")),
				`${theme.fg("accent", qcuFormatTokens(details.usage.tokens))}${contextWindow ? `/${qcuFormatTokens(contextWindow)}` : ""} tokens${details.usage.percent != null ? ` (${details.usage.percent.toFixed(1)}%)` : ""}`,
				"",
				theme.fg("muted", theme.italic("Estimated usage by category")),
				...details.categories.map((category) => `${theme.fg(category.color as any, category.icon)} ${theme.fg("text", `${category.label}:`)} ${qcuFormatTokens(category.tokens)} tokens ${theme.fg("muted", `(${qcuPercent(category.tokens, contextWindow)})`)}`),
			];
			if (details.freeTokens != null) summaryLines.push(`${theme.fg("borderMuted", "□")} ${theme.fg("text", "Free space:")} ${qcuFormatTokens(details.freeTokens)} ${theme.fg("muted", `(${qcuPercent(details.freeTokens, contextWindow)})`)}`);
			lines.push("");
			if (safeWidth >= 82) {
				const leftWidth = visibleWidth(gridLines[0] ?? "");
				const maxRows = Math.max(gridLines.length, summaryLines.length);
				for (let index = 0; index < maxRows; index += 1) {
					lines.push(`  ${qcuPadAnsi(gridLines[index] ?? "", leftWidth)}    ${summaryLines[index] ?? ""}`.trimEnd());
				}
			} else {
				lines.push(...gridLines.map((line) => `  ${line}`));
				lines.push("");
				lines.push(...summaryLines.map((line) => `  ${line}`));
			}
			if (details.note) lines.push("", theme.fg("dim", details.note));
			const messageStats = details.messageStats;
			lines.push("");
			lines.push(`${theme.fg("customMessageLabel", theme.bold("Conversation"))}`);
			lines.push(`${qcuBranch(theme, "├")}context messages: ${theme.fg("accent", String(messageStats.contextMessages))} ${theme.fg("dim", `(${messageStats.branchEntries} branch entries)`)}`);
			lines.push(`${qcuBranch(theme, "├")}user: ${messageStats.user} · assistant: ${messageStats.assistant} · tool results: ${messageStats.toolResult}`);
			lines.push(`${qcuBranch(theme, "└")}bash: ${messageStats.bash} · custom: ${messageStats.custom} · compact summaries: ${messageStats.compact}`);
			qcuRenderDetailSection(lines, "MCP tools", details.mcpTools, theme, { empty: undefined, limit: 12, showDescriptions: false });
			qcuRenderDetailSection(lines, "Built-in tools", details.builtinTools, theme, { limit: details.mcpTools.length > 0 ? 8 : 12, showDescriptions: false });
			qcuRenderDetailSection(lines, "Extension tools", details.extensionTools, theme, { limit: 12, showDescriptions: false });
			qcuRenderDetailSection(lines, "Custom agents · /agents", details.customAgents, theme, { limit: 12, showDescriptions: false });
			qcuRenderDetailSection(lines, "Context / memory files", details.contextFiles, theme, { limit: 12, showDescriptions: false });
			qcuRenderDetailSection(lines, "Skills · /skills", details.skills, theme, { empty: "No skill commands discovered.", limit: 14, showDescriptions: false });
			qcuRenderDetailSection(lines, "Compact buffer", details.compactSummaries, theme, { limit: 6, showDescriptions: false });
			return lines.map((line) => truncateToWidth(line, safeWidth, ""));
		},
	};
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") return (part as any).text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function lastAssistantTextFromAgentEnd(event: any, ctx: ExtensionContext): string {
	const eventMessages = Array.isArray(event?.messages) ? event.messages : [];
	for (let index = eventMessages.length - 1; index >= 0; index -= 1) {
		const message = eventMessages[index];
		if (message?.role === "assistant") return textFromContent(message.content);
	}
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as any;
		if (entry?.type === "message" && entry.message?.role === "assistant") return textFromContent(entry.message.content);
	}
	return "";
}

function needsDirection(text: string): boolean {
	return /\?\s*$|\b(let me know|tell me|which (one|option)|choose|confirm|approve|should i|would you like|do you want|need your input|awaiting|next step)\b/i.test(text);
}

function criticalInfo(text: string): string | undefined {
	const match = text.match(/\b(critical|urgent|warning|blocked|cannot proceed|security|vulnerab|secret|credential|rate limit|context (overflow|full)|manual action required)\b/i);
	if (!match) return undefined;
	const line = text.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(match[0].toLowerCase())) ?? text;
	return line.trim();
}

function taskStats(state: any): { completed: number; remaining: number; total: number } | undefined {
	const tasks = Array.isArray(state?.tasks) ? state.tasks : undefined;
	if (!tasks) return undefined;
	const total = tasks.length;
	const completed = tasks.filter((task: any) => task?.status === "completed").length;
	const remaining = tasks.filter((task: any) => task?.status === "pending" || task?.status === "in_progress").length;
	return { completed, remaining, total };
}

function getQuestionService(): QuestionServiceLike | undefined {
	const service = (globalThis as unknown as Record<PropertyKey, unknown>)[QUESTION_SERVICE_SYMBOL];
	if (!service || typeof service !== "object") return undefined;
	const candidate = service as Partial<QuestionServiceLike>;
	if (typeof candidate.subscribe === "function" && typeof candidate.listPending === "function") return candidate as QuestionServiceLike;
	return undefined;
}

function entryToHandoffMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return branch.map(entryToHandoffMessage).filter((message): message is AgentMessage => message !== undefined);

	const compaction = branch[compactionIndex];
	const firstKeptIndex = compaction?.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToHandoffMessage).filter((message): message is AgentMessage => message !== undefined);
}

async function runHandoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("handoff requires interactive mode", "error");
		return;
	}

	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const goal = args.trim();
	if (!goal) {
		ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
		return;
	}

	const messages = getHandoffMessages(ctx.sessionManager.getBranch());

	if (messages.length === 0) {
		ctx.ui.notify("No conversation to hand off", "error");
		return;
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const currentSessionFile = ctx.sessionManager.getSessionFile();

	const releaseModalLock = acquireVstackModalLock();
	let result: string | null = null;
	try {
	result = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
			}

			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") return null;
			return response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		};

		doGenerate()
			.then(done)
			.catch((error) => {
				console.error("Handoff generation failed:", error);
				done(null);
			});

		return loader;
	});
	} finally {
		releaseModalLock();
	}

	if (result === null) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const prompt = settingBoolean("handoffReviewPrompt", true, ctx.cwd) ? await ctx.ui.editor("Edit handoff prompt", result) : result;
	if (prompt === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const newSessionResult = await ctx.newSession({
		parentSession: currentSessionFile,
		withSession: async (replacementCtx: any) => {
			replacementCtx.ui.setEditorText(prompt);
			replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});

	if (newSessionResult.cancelled) {
		ctx.ui.notify("New session cancelled", "info");
	}
}

function statusMessage(ctx: ExtensionContext): string {
	const labels = attachmentLabels(currentEditorText(ctx), ctx.cwd);
	const searchShortcut = sessionSearchShortcut(ctx.cwd);
	return [
		"Pi QOL status",
		`Shift+Enter newline: ${settingBoolean("newlineOnShiftEnter", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Fallback newline key: ${newlineFallbackKey(ctx.cwd)}`,
		`Image chips: ${settingBoolean("showImageChips", true, ctx.cwd) ? "filled (placeholders and existing image paths)" : "off"}`,
		`Image placeholders/paths in draft: ${labels.length ? labels.join(", ") : "none"}`,
		`Rename command: ${settingBoolean("enableSessionNameCommand", true, ctx.cwd) ? "enabled (/rename)" : "disabled"}`,
		`Auto session rename: ${autoRenameEnabled(ctx.cwd) ? `enabled (${settingString("sessionAutoRename.model", DEFAULT_AUTO_RENAME_MODEL, ctx.cwd)})` : "disabled"}`,
		`Handoff command: ${settingBoolean("enableHandoffCommand", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Handoff prompt review: ${settingBoolean("handoffReviewPrompt", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Session search: ${settingBoolean("sessionSearch.enabled", true, ctx.cwd) ? `enabled (/search${searchShortcut ? `, ${searchShortcut}` : ""})` : "disabled"}`,
		`Custom compaction: ${settingBoolean("compaction.customEnabled", false, ctx.cwd) ? `enabled (${settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd)}, ${compactionProfile(ctx.cwd)})` : "disabled (Pi default)"}`,
		`Idle compaction: ${settingBoolean("compaction.idleEnabled", false, ctx.cwd) ? `enabled after ${Math.max(1, Math.floor(settingNumber("compaction.idleTimeoutSeconds", DEFAULT_IDLE_COMPACTION_SECONDS, ctx.cwd)))}s idle` : "disabled"}`,
		`Branch summary override: ${settingBoolean("compaction.branchSummaryEnabled", false, ctx.cwd) ? "enabled" : "disabled"}`,
		`Notifications: ${settingBoolean("notification.enabled", true, ctx.cwd) ? `enabled (bell=${settingBoolean("notification.bell", true, ctx.cwd)}, native=${settingBoolean("notification.native", true, ctx.cwd)}, tmuxClientTty=${settingBoolean("notification.tmuxNativeClientTty", true, ctx.cwd)}, tmuxMessage=${settingBoolean("notification.tmux", false, ctx.cwd)})` : "disabled"}`,
		`Permission gate: ${settingBoolean("permissionGate.enabled", false, ctx.cwd) ? `enabled (${permissionGateCommands(ctx.cwd).join(", ") || "none configured"}; preview ${boundedSettingNumber("permissionGate.previewLines", DEFAULT_PERMISSION_GATE_PREVIEW_LINES, 4, 40, ctx.cwd)} lines/${boundedSettingNumber("permissionGate.previewChars", DEFAULT_PERMISSION_GATE_PREVIEW_CHARS, 200, 5000, ctx.cwd)} chars)` : "disabled"}`,
		`Thinking timer: ${settingBoolean("thinkingTimer.enabled", true, ctx.cwd) ? "enabled" : "disabled"}`,
		"If Shift+Enter still submits, configure your terminal/tmux to send a distinct Shift+Enter sequence or use the fallback key.",
	].join("\n");
}


type QolSessionSortMode = "recent" | "relevance";

type QolSessionAction = "resume" | "copy" | "summarize" | "newSession" | "back";

const QOL_SESSION_ACTIONS: QolSessionAction[] = ["resume", "copy", "summarize", "newSession", "back"];
const QOL_SESSION_ACTION_LABELS: Record<QolSessionAction, string> = {
	resume: "↩ Resume",
	copy: "✎ Copy Prompt",
	summarize: "📋 Inject Summary",
	newSession: "✦ New + Context",
	back: "← Back",
};

interface QolSessionSearchSession {
	allMessagesText: string;
	created: Date;
	cwd: string;
	firstMessage: string;
	id: string;
	messageCount: number;
	modified: Date;
	name?: string;
	parentSessionPath?: string;
	path: string;
}

interface QolSessionSearchResult extends QolSessionSearchSession {
	rank: number;
	snippets: string[];
}

interface QolParsedSessionQuery {
	mode: "tokens" | "regex";
	tokens: Array<{ kind: "fuzzy" | "phrase"; value: string }>;
	regex?: RegExp;
	error?: string;
}

interface QolSessionSearchState {
	cursor: number;
	query: string;
	results: QolSessionSearchResult[];
	selected: number;
	total: number;
}

interface QolSessionUserMessage {
	index: number;
	text: string;
	timestamp?: number;
}

interface QolSessionMessagesState {
	messages: QolSessionUserMessage[];
	result: QolSessionSearchResult;
	selected: number;
}

interface QolSessionActionState {
	actionIndex: number;
	message: QolSessionUserMessage;
	result: QolSessionSearchResult;
}

interface QolSessionFocusState {
	cursor: number;
	message: QolSessionUserMessage;
	prompt: string;
	result: QolSessionSearchResult;
	type: "summarize" | "newSession";
}

interface QolSessionSearchPendingMessage {
	content: string;
	details: Record<string, unknown>;
}

interface QolSessionPaletteAction {
	type: "cancel" | "resume" | "copy" | "summarize" | "newSession";
	customPrompt?: string;
	message?: QolSessionUserMessage;
	result?: QolSessionSearchResult;
}

let qolSessionSearchCache: QolSessionSearchSession[] = [];
let qolSessionSearchLoadedAt = 0;
let qolSessionSearchLoading: Promise<QolSessionSearchSession[]> | undefined;
const qolSessionUserMessagesCache = new Map<string, QolSessionUserMessage[]>();

function getPendingSessionSearchMessage(): QolSessionSearchPendingMessage | undefined {
	return (globalThis as unknown as Record<PropertyKey, unknown>)[SESSION_SEARCH_PENDING_SYMBOL] as QolSessionSearchPendingMessage | undefined;
}

function setPendingSessionSearchMessage(message: QolSessionSearchPendingMessage | undefined): void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	if (message) host[SESSION_SEARCH_PENDING_SYMBOL] = message;
	else delete host[SESSION_SEARCH_PENDING_SYMBOL];
}

function coerceDate(value: unknown): Date {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	const date = new Date(typeof value === "string" || typeof value === "number" ? value : 0);
	return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function sessionInfoToSearchSession(info: any): QolSessionSearchSession | undefined {
	if (!info || typeof info.path !== "string") return undefined;
	return {
		allMessagesText: typeof info.allMessagesText === "string" ? info.allMessagesText : "",
		created: coerceDate(info.created),
		cwd: typeof info.cwd === "string" ? info.cwd : "",
		firstMessage: typeof info.firstMessage === "string" ? info.firstMessage : "(no messages)",
		id: typeof info.id === "string" ? info.id : basename(info.path),
		messageCount: Number.isFinite(Number(info.messageCount)) ? Number(info.messageCount) : 0,
		modified: coerceDate(info.modified),
		name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : undefined,
		parentSessionPath: typeof info.parentSessionPath === "string" ? info.parentSessionPath : undefined,
		path: info.path,
	};
}

function resolveSettingsRelativePath(value: string, settingsPath: string): string {
	const expanded = expandHome(value.trim());
	return isAbsolute(expanded) ? expanded : resolve(dirname(settingsPath), expanded);
}

function sessionSearchShortcut(cwd?: string): string | undefined {
	// Legacy escape hatch from the original Ctrl+F setting. If users disabled it,
	// keep shortcuts disabled even though the default shortcut is now conflict-free.
	if (!settingBoolean("sessionSearch.ctrlFShortcut", true, cwd)) return undefined;
	const shortcut = settingStringAllowEmpty("sessionSearch.shortcutKey", DEFAULT_SESSION_SEARCH_SHORTCUT, cwd).trim().toLowerCase();
	if (!shortcut || shortcut === "none" || shortcut === "off" || shortcut === "false") return undefined;
	return shortcut;
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

async function loadQolSessionSearchSessions(ctx: ExtensionContext, onProgress?: (loaded: number, total: number) => void): Promise<QolSessionSearchSession[]> {
	const customSessionDir = configuredSessionDir(ctx.cwd);
	const infos = customSessionDir
		? await SessionManager.list(ctx.cwd, customSessionDir, onProgress)
		: await SessionManager.listAll(onProgress);
	return infos.map(sessionInfoToSearchSession).filter((session): session is QolSessionSearchSession => session !== undefined);
}

async function refreshQolSessionSearchCache(ctx: ExtensionContext, options?: { force?: boolean; quiet?: boolean }): Promise<QolSessionSearchSession[]> {
	const ttlMs = Math.max(0, settingNumber("sessionSearch.cacheTtlSeconds", DEFAULT_SESSION_SEARCH_CACHE_TTL_SECONDS, ctx.cwd) * 1000);
	const fresh = qolSessionSearchCache.length > 0 && (ttlMs === 0 || Date.now() - qolSessionSearchLoadedAt < ttlMs);
	if (!options?.force && fresh) return qolSessionSearchCache;
	if (qolSessionSearchLoading) return qolSessionSearchLoading;

	if (!options?.quiet && ctx.hasUI) ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, "🔍 Loading sessions...");
	qolSessionSearchLoading = loadQolSessionSearchSessions(ctx, (loaded, total) => {
		if (!options?.quiet && ctx.hasUI) ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, `🔍 Loading sessions ${loaded}/${total}`);
	}).then((sessions) => {
		qolSessionSearchCache = sessions;
		qolSessionSearchLoadedAt = Date.now();
		qolSessionUserMessagesCache.clear();
		return sessions;
	}).finally(() => {
		qolSessionSearchLoading = undefined;
		if (!options?.quiet && ctx.hasUI) ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
	});
	return qolSessionSearchLoading;
}

function formatSessionSearchDate(date: Date): string {
	const now = Date.now();
	const diffMs = Math.max(0, now - date.getTime());
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function oneLine(text: string): string {
	return text
		.replace(ANSI_ESCAPE_RE, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

type AutoRenameFallbackMode = "none" | "truncate" | "words";

interface AutoRenameAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	label: string;
	model: any;
	source: string;
}

function autoRenameEnabled(cwd?: string): boolean {
	return settingBoolean("sessionAutoRename.enabled", true, cwd);
}

function autoRenameDebug(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI && settingBoolean("sessionAutoRename.debug", false, ctx.cwd)) ctx.ui.notify(`[auto-rename] ${message}`, level);
}

function autoRenameNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info", force = false): void {
	if (!ctx.hasUI) return;
	if (force || settingBoolean("sessionAutoRename.notify", false, ctx.cwd) || settingBoolean("sessionAutoRename.debug", false, ctx.cwd)) ctx.ui.notify(`[auto-rename] ${message}`, level);
}

function firstUserMessageText(branch: SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = textFromContent(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function conversationTranscriptText(branch: SessionEntry[], maxChars: number): string | undefined {
	const lines: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textFromContent(entry.message.content).trim();
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	const transcript = lines.join("\n\n").trim();
	return transcript ? truncateMiddle(transcript, maxChars) : undefined;
}

function truncateMiddle(text: string, maxChars: number): string {
	const max = Math.max(200, Math.floor(maxChars));
	if (text.length <= max) return text;
	const marker = "\n[...truncated...]\n";
	const budget = max - marker.length;
	if (budget <= 0) return text.slice(0, max);
	const headBudget = Math.ceil(budget * 0.6);
	const tailBudget = budget - headBudget;
	let head = text.slice(0, headBudget);
	const headSpace = head.lastIndexOf(" ");
	if (headSpace > headBudget * 0.6) head = head.slice(0, headSpace);
	let tail = text.slice(text.length - tailBudget);
	const tailSpace = tail.indexOf(" ");
	if (tailSpace >= 0 && tailSpace < tailBudget * 0.4) tail = tail.slice(tailSpace + 1);
	return `${head}${marker}${tail}`;
}

function clampAutoRenameName(name: string, maxChars: number): string {
	const max = Math.max(20, Math.floor(maxChars));
	let cleaned = oneLine(name).replace(/[.!?:;,]+$/g, "").trim();
	if (cleaned.length <= max) return cleaned;
	const truncated = cleaned.slice(0, max).trimEnd();
	const lastSpace = truncated.lastIndexOf(" ");
	cleaned = lastSpace > max * 0.45 ? truncated.slice(0, lastSpace) : truncated;
	return cleaned.replace(/[,;:\s]+$/g, "").trim();
}

function stripAutoRenameThinkTags(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<think>[\s\S]*/gi, "")
		.replace(/<thinking>[\s\S]*/gi, "")
		.trim();
}

function normalizeAutoRenameCandidate(line: string): string {
	return line
		.replace(/<[^>]+>/g, " ")
		.replace(/^\s*(?:final\s+)?(?:title|name|session\s+name)\s*[:\-]\s*/i, "")
		.replace(/^[\s\-*>#•]+/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function looksLikeAutoRenameReasoning(line: string): boolean {
	if (!line) return true;
	if (/\b(here'?s|i would|best title|candidate|option|reasoning|analysis|thinking)\b/i.test(line)) return true;
	if (/[{}<>|]/.test(line)) return true;
	const words = line.split(/\s+/).filter(Boolean);
	return words.length === 0 || words.length > 12;
}

function autoRenameResponseText(response: any): string {
	const blocks = Array.isArray(response?.content) ? response.content : [];
	const text = blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n")
		.trim();
	if (text) return text;
	return blocks
		.filter((block: any) => block?.type === "thinking" && typeof block.thinking === "string")
		.map((block: any) => block.thinking)
		.join("\n")
		.trim();
}

function sanitizeAutoRenameName(raw: string, maxChars: number): string | undefined {
	const stripped = stripAutoRenameThinkTags(raw);
	const lines = stripped
		.split(/\r?\n/)
		.map(normalizeAutoRenameCandidate)
		.filter(Boolean);
	let name = "";
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (!looksLikeAutoRenameReasoning(lines[index]!)) {
			name = lines[index]!;
			break;
		}
	}
	if (!name && lines.length > 0) name = [...lines].sort((a, b) => a.length - b.length)[0]!;
	name = clampAutoRenameName(name, maxChars);
	return name && !looksLikeAutoRenameReasoning(name) ? name : undefined;
}

function titleCaseWord(word: string): string {
	return word ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : word;
}

function autoRenameFallbackMode(cwd?: string): AutoRenameFallbackMode {
	const configured = settingString("sessionAutoRename.fallback", "words", cwd).toLowerCase();
	return configured === "none" || configured === "truncate" ? configured : "words";
}

function deterministicAutoRenameName(query: string, cwd?: string): string | undefined {
	const mode = autoRenameFallbackMode(cwd);
	if (mode === "none") return undefined;
	const maxChars = settingNumber("sessionAutoRename.maxNameChars", DEFAULT_AUTO_RENAME_NAME_CHARS, cwd);
	const cleaned = oneLine(query)
		.replace(/[`"'“”‘’]/g, "")
		.replace(/[^\w\s./-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	if (mode === "truncate") return clampAutoRenameName(cleaned, Math.min(maxChars, 50));
	const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6).map(titleCaseWord);
	return clampAutoRenameName(words.join(" "), maxChars);
}

function autoRenamePrompt(query: string, cwd?: string): string {
	const maxChars = Math.max(200, Math.floor(settingNumber("sessionAutoRename.maxInputChars", DEFAULT_AUTO_RENAME_INPUT_CHARS, cwd)));
	const message = truncateMiddle(query, maxChars);
	const configured = settingStringAllowEmpty("sessionAutoRename.prompt", "", cwd);
	const template = configured || DEFAULT_AUTO_RENAME_PROMPT;
	if (template.includes("{{message}}")) return template.split("{{message}}").join(message);
	return `${template.trim()}\n\nFirst user message:\n${message}`.trim();
}

function disabledModelSetting(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return !normalized || normalized === "none" || normalized === "off" || normalized === "disabled";
}

function autoRenameModelSettings(cwd?: string): string[] {
	const primary = settingString("sessionAutoRename.model", DEFAULT_AUTO_RENAME_MODEL, cwd);
	const fallback = settingStringAllowEmpty("sessionAutoRename.fallbackModel", DEFAULT_AUTO_RENAME_FALLBACK_MODEL, cwd);
	const candidates = [primary];
	if (primary === DEFAULT_AUTO_RENAME_MODEL) candidates.push("openai-codex/gpt-5.3-codex-spark");
	candidates.push(fallback);
	return candidates
		.map((value) => value.trim())
		.filter((value) => !disabledModelSetting(value))
		.filter((value, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
}

function headerRecord(headers: unknown): Record<string, string> | undefined {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
	const entries = Object.entries(headers as Record<string, unknown>)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function modelCost(model: any): number {
	const cost = model?.cost;
	return Number(cost?.input ?? 0) + Number(cost?.output ?? 0);
}

async function cheapestAvailableAutoRenameModel(ctx: ExtensionContext): Promise<AutoRenameAuth | undefined> {
	const registry = ctx.modelRegistry as any;
	const rawModels = typeof registry.getAvailable === "function" ? registry.getAvailable() : typeof registry.getAll === "function" ? registry.getAll() : [];
	const models = Array.isArray(rawModels) ? rawModels.filter((model) => model?.input?.includes?.("text") ?? true) : [];
	models.sort((a, b) => modelCost(a) - modelCost(b) || modelLabel(a).localeCompare(modelLabel(b)));
	for (const model of models) {
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const headers = headerRecord(auth.headers);
			if (auth.ok && (auth.apiKey || headers)) return { apiKey: auth.apiKey, headers, label: modelLabel(model), model, source: "cheapest" };
		} catch {
			// Try the next available model.
		}
	}
	return undefined;
}

async function resolveAutoRenameModel(ctx: ExtensionContext, configured: string): Promise<AutoRenameAuth | undefined> {
	if (configured.trim().toLowerCase() === "cheapest") return cheapestAvailableAutoRenameModel(ctx);
	const model = resolveConfiguredModel(ctx, configured);
	if (!model) {
		autoRenameDebug(ctx, `model not found: ${configured}`, "warning");
		return undefined;
	}
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		const headers = headerRecord(auth.headers);
		if (!auth.ok) {
			autoRenameDebug(ctx, `auth unavailable for ${modelLabel(model)}: ${auth.error}`, "warning");
			return undefined;
		}
		if (!auth.apiKey && !headers) {
			autoRenameDebug(ctx, `no auth for ${modelLabel(model)}; use /login or models.json`, "warning");
			return undefined;
		}
		return { apiKey: auth.apiKey, headers, label: modelLabel(model), model, source: configured };
	} catch (error) {
		autoRenameDebug(ctx, `auth failed for ${modelLabel(model)}: ${stringifyError(error)}`, "warning");
		return undefined;
	}
}

async function generateAutoRenameName(query: string, ctx: ExtensionContext, fullConversation = false): Promise<{ name?: string; source: string }> {
	const maxNameChars = Math.max(20, Math.floor(settingNumber("sessionAutoRename.maxNameChars", DEFAULT_AUTO_RENAME_NAME_CHARS, ctx.cwd)));
	const maxTokens = Math.max(16, Math.floor(settingNumber("sessionAutoRename.maxTokens", DEFAULT_AUTO_RENAME_MAX_TOKENS, ctx.cwd)));
	const prompt = fullConversation
		? `${AUTO_RENAME_SYSTEM_PROMPT}\n\nName this session using the conversation transcript below. Return only the title.\n\n${query}`
		: autoRenamePrompt(query, ctx.cwd);
	const message: Message = {
		content: [{ text: prompt, type: "text" }],
		role: "user",
		timestamp: Date.now(),
	};

	for (const configured of autoRenameModelSettings(ctx.cwd)) {
		const resolved = await resolveAutoRenameModel(ctx, configured);
		if (!resolved) continue;
		try {
			const controller = new AbortController();
			const timeoutMs = Math.max(1000, Math.floor(settingNumber("sessionAutoRename.timeoutMs", DEFAULT_AUTO_RENAME_TIMEOUT_MS, ctx.cwd)));
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			timeout.unref?.();
			try {
				const response = await complete(
					resolved.model,
					{ messages: [message], systemPrompt: AUTO_RENAME_SYSTEM_PROMPT },
					{ apiKey: resolved.apiKey, headers: resolved.headers, maxTokens, signal: controller.signal },
				);
				if (response.stopReason === "error") {
					autoRenameDebug(ctx, `${resolved.label} failed: ${response.errorMessage ?? "unknown error"}`, "warning");
					continue;
				}
				const name = sanitizeAutoRenameName(autoRenameResponseText(response), maxNameChars);
				if (name) return { name, source: resolved.label };
				autoRenameDebug(ctx, `${resolved.label} returned no usable title`, "warning");
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			autoRenameDebug(ctx, `${resolved.label} failed: ${stringifyError(error)}`, "warning");
		}
	}

	const deterministic = deterministicAutoRenameName(query, ctx.cwd);
	return deterministic ? { name: deterministic, source: `fallback:${autoRenameFallbackMode(ctx.cwd)}` } : { source: "none" };
}

function withAutoRenamePrefix(name: string, cwd?: string): string {
	const maxNameChars = Math.max(20, Math.floor(settingNumber("sessionAutoRename.maxNameChars", DEFAULT_AUTO_RENAME_NAME_CHARS, cwd)));
	const prefix = clampAutoRenameName(settingStringAllowEmpty("sessionAutoRename.prefix", "", cwd), 40);
	return clampAutoRenameName(prefix ? `${prefix}: ${name}` : name, maxNameChars);
}

function sessionDisplayName(session: QolSessionSearchSession): string {
	if (session.name) return oneLine(session.name) || "session";
	if (session.cwd) {
		const parts = oneLine(session.cwd).split(/[\\/]+/).filter(Boolean);
		if (parts.length >= 2) return parts.slice(-2).join("/");
		if (parts.length === 1) return parts[0]!;
	}
	return oneLine(basename(session.path) || "session") || "session";
}

function sessionResumeTitle(session: QolSessionSearchSession): string {
	// Match /resume's primary label: explicit session name, otherwise first user prompt.
	if (session.name) return oneLine(session.name) || sessionDisplayName(session);
	if (session.firstMessage && session.firstMessage !== "(no messages)") return oneLine(session.firstMessage) || sessionDisplayName(session);
	return sessionDisplayName(session);
}

function shortPathForUi(path: string): string {
	const cleaned = oneLine(path);
	const home = homedir();
	if (cleaned === home) return "~";
	if (cleaned.startsWith(`${home}/`)) return `~${cleaned.slice(home.length)}`;
	return cleaned;
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => {
		if (part?.type === "text" && typeof part.text === "string") return part.text;
		if (part?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join(" ");
}

function sessionUserMessages(sessionPath: string): QolSessionUserMessage[] {
	const cached = qolSessionUserMessagesCache.get(sessionPath);
	if (cached) return cached;
	const messages: QolSessionUserMessage[] = [];
	try {
		const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			const message = entry?.type === "message" ? entry.message : undefined;
			if (!message || message.role !== "user") continue;
			const text = oneLine(messageContentText(message.content));
			if (!text) continue;
			messages.push({
				index: messages.length + 1,
				text,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
			});
		}
	} catch {
		// Ignore unreadable sessions; callers fall back to SessionInfo.firstMessage.
	}
	qolSessionUserMessagesCache.set(sessionPath, messages);
	return messages;
}

function userMessagesForResult(result: QolSessionSearchResult): QolSessionUserMessage[] {
	const messages = sessionUserMessages(result.path);
	if (messages.length > 0) return messages;
	return [{ index: 1, text: oneLine(result.firstMessage || "No user messages") }];
}

function sessionUserPromptCount(session: QolSessionSearchSession): number {
	const count = sessionUserMessages(session.path).length;
	if (count > 0) return count;
	return session.firstMessage && session.firstMessage !== "(no messages)" ? 1 : 0;
}

function promptCountLabel(count: number): string {
	return `${count} prompt${count === 1 ? "" : "s"}`;
}

function lastUserMessageSnippet(session: QolSessionSearchSession): string {
	const messages = sessionUserMessages(session.path);
	return messages[messages.length - 1]?.text || oneLine(session.firstMessage || "No user messages");
}

function sessionSearchText(session: QolSessionSearchSession): string {
	return [session.id, session.name ?? "", session.cwd, session.path, session.firstMessage, session.allMessagesText].join("\n");
}

function normalizeSearchText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseSessionSearchQuery(query: string): QolParsedSessionQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [] };
	if (trimmed.startsWith("re:")) {
		const source = trimmed.slice(3).trim();
		if (!source) return { error: "Empty regex", mode: "regex", tokens: [] };
		try {
			return { mode: "regex", regex: new RegExp(source, "i"), tokens: [] };
		} catch (error) {
			return { error: stringifyError(error), mode: "regex", tokens: [] };
		}
	}

	const tokens: QolParsedSessionQuery["tokens"] = [];
	let buffer = "";
	let inQuote = false;
	let unclosed = false;
	const flush = (kind: "fuzzy" | "phrase") => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i]!;
		if (char === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}
		if (!inQuote && /\s/.test(char)) {
			flush("fuzzy");
			continue;
		}
		buffer += char;
	}
	if (inQuote) unclosed = true;
	if (unclosed) {
		return {
			mode: "tokens",
			tokens: trimmed.split(/\s+/).filter(Boolean).map((value) => ({ kind: "fuzzy", value })),
		};
	}
	flush(inQuote ? "phrase" : "fuzzy");
	return { mode: "tokens", tokens };
}

function simpleFuzzyScore(needle: string, haystack: string): number | undefined {
	const query = needle.toLowerCase();
	const text = haystack.toLowerCase();
	if (!query) return 0;
	const direct = text.indexOf(query);
	if (direct >= 0) return direct * 0.1;
	let pos = 0;
	let score = 0;
	for (const char of query) {
		const found = text.indexOf(char, pos);
		if (found < 0) return undefined;
		score += found - pos + 1;
		pos = found + 1;
	}
	return score + 1000;
}

function matchSessionSearch(session: QolSessionSearchSession, parsed: QolParsedSessionQuery): { matches: boolean; score: number } {
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

function escapeForRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionSnippetSource(session: QolSessionSearchSession): string {
	return (session.allMessagesText || session.firstMessage || "").replace(/\s+/g, " ").trim();
}

function snippetAround(text: string, start: number, length: number, width: number): string {
	const safeStart = Math.max(0, start - Math.floor(width / 3));
	const safeEnd = Math.min(text.length, start + length + Math.floor((width * 2) / 3));
	const prefix = safeStart > 0 ? "…" : "";
	const suffix = safeEnd < text.length ? "…" : "";
	return `${prefix}${text.slice(safeStart, safeEnd)}${suffix}`;
}

function buildSessionSnippets(session: QolSessionSearchSession, parsed: QolParsedSessionQuery, limit: number): string[] {
	const source = sessionSnippetSource(session);
	if (!source) return [];
	if (parsed.mode === "regex" && parsed.regex) {
		parsed.regex.lastIndex = 0;
		const match = parsed.regex.exec(source);
		return match ? [snippetAround(source, match.index, match[0].length, 220)] : [];
	}
	if (parsed.tokens.length === 0) return [source.slice(0, 220)];
	const snippets: string[] = [];
	const lower = source.toLowerCase();
	const seen = new Set<string>();
	for (const token of parsed.tokens) {
		const value = normalizeSearchText(token.value);
		if (!value) continue;
		const index = lower.indexOf(value.toLowerCase());
		if (index < 0) continue;
		const snippet = snippetAround(source, index, value.length, 220);
		const key = snippet.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			snippets.push(snippet);
		}
		if (snippets.length >= limit) break;
	}
	return snippets.length > 0 ? snippets : [source.slice(0, 220)];
}

function searchQolSessions(sessions: QolSessionSearchSession[], query: string, cwd: string): QolSessionSearchResult[] {
	const limit = Math.max(1, Math.floor(settingNumber("sessionSearch.resultLimit", DEFAULT_SESSION_SEARCH_LIMIT, cwd)));
	const snippetLimit = Math.max(1, Math.floor(settingNumber("sessionSearch.previewSnippets", DEFAULT_SESSION_SEARCH_PREVIEW_SNIPPETS, cwd)));
	const parsed = parseSessionSearchQuery(query);
	if (parsed.error) return [];
	if (!query.trim()) {
		return sessions
			.slice()
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, limit)
			.map((session) => ({ ...session, rank: 0, snippets: buildSessionSnippets(session, { mode: "tokens", tokens: [] }, 1) }));
	}
	const results: QolSessionSearchResult[] = [];
	for (const session of sessions) {
		const match = matchSessionSearch(session, parsed);
		if (!match.matches) continue;
		results.push({ ...session, rank: match.score, snippets: buildSessionSnippets(session, parsed, snippetLimit) });
	}
	const sortMode = settingString("sessionSearch.sortMode", "relevance", cwd) === "recent" ? "recent" : "relevance" as QolSessionSortMode;
	results.sort((a, b) => sortMode === "recent" ? b.modified.getTime() - a.modified.getTime() : a.rank - b.rank || b.modified.getTime() - a.modified.getTime());
	return results.slice(0, limit);
}

function styleSessionSnippet(snippet: string, query: string, theme: Theme): string {
	let styled = snippet;
	const parsed = parseSessionSearchQuery(query);
	if (parsed.mode === "tokens") {
		for (const token of parsed.tokens) {
			const value = token.value.trim();
			if (!value || value.length > 80) continue;
			try {
				styled = styled.replace(new RegExp(escapeForRegex(value), "gi"), (match) => theme.bold(theme.fg("warning", match)));
			} catch {
				// Ignore highlighting failures; search result remains readable.
			}
		}
	}
	return styled;
}

function boxParts(width: number, theme: Theme) {
	const safeWidth = Math.max(24, width);
	const inner = Math.max(10, safeWidth - 2);
	const border = (s: string) => theme.fg("borderAccent", s);
	const row = (content = "") => {
		// A single accidental newline in a session name/prompt can tear the box apart.
		// Preserve ANSI styling, but collapse hard line breaks before measuring.
		const safeContent = content.replace(/[\r\n\t]+/g, " ");
		const clipped = truncateToWidth(safeContent, inner - 1, "");
		const pad = Math.max(0, inner - visibleWidth(clipped) - 1);
		return `${border("┃")} ${clipped}${" ".repeat(pad)}${border("┃")}`;
	};
	const empty = () => `${border("┃")}${" ".repeat(inner)}${border("┃")}`;
	const divider = () => border(`┣${"━".repeat(inner)}┫`);
	const top = (title: string) => {
		const label = ` ${title} `;
		const labelWidth = visibleWidth(label);
		const remaining = Math.max(0, inner - labelWidth);
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return `${border(`┏${"━".repeat(left)}`)}${theme.fg("accent", label)}${border(`${"━".repeat(right)}┓`)}`;
	};
	const bottom = () => border(`┗${"━".repeat(inner)}┛`);
	return { bottom, divider, empty, inner, row, top };
}

function isPrintableInput(data: string): boolean {
	return data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b") && data !== "\x7f";
}

class QolSessionSearchComponent {
	private screen: "search" | "messages" | "actions" | "focus" = "search";
	private searchState: QolSessionSearchState;
	private messagesState: QolSessionMessagesState | undefined;
	private actionState: QolSessionActionState | undefined;
	private focusState: QolSessionFocusState | undefined;

	constructor(
		private readonly done: (action: QolSessionPaletteAction) => void,
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly sessions: QolSessionSearchSession[],
		private readonly cwd: string,
		initialQuery = "",
	) {
		const query = initialQuery.trim();
		this.searchState = {
			cursor: query.length,
			query,
			results: searchQolSessions(sessions, query, cwd),
			selected: 0,
			total: sessions.length,
		};
	}

	invalidate(): void {}

	render(width: number): string[] {
		const configured = Math.max(70, Math.floor(settingNumber("sessionSearch.overlayWidth", 104, this.cwd)));
		const renderWidth = Math.min(Math.max(48, width), configured);
		if (this.screen === "messages" && this.messagesState) return this.renderMessages(renderWidth, this.messagesState);
		if (this.screen === "actions" && this.actionState) return this.renderActions(renderWidth, this.actionState);
		if (this.screen === "focus" && this.focusState) return this.renderFocus(renderWidth, this.focusState);
		return this.renderSearch(renderWidth);
	}

	handleInput(data: string): void {
		if (this.screen === "messages") this.handleMessagesInput(data);
		else if (this.screen === "actions") this.handleActionInput(data);
		else if (this.screen === "focus") this.handleFocusInput(data);
		else this.handleSearchInput(data);
		this.tui.requestRender();
	}

	private clampSelection(): void {
		this.searchState.selected = Math.max(0, Math.min(this.searchState.selected, Math.max(0, this.searchState.results.length - 1)));
	}

	private updateQuery(query: string, cursor: number): void {
		this.searchState.query = query;
		this.searchState.cursor = Math.max(0, Math.min(cursor, query.length));
		this.searchState.results = searchQolSessions(this.sessions, query, this.cwd);
		this.searchState.selected = 0;
		this.clampSelection();
	}

	private selectedMessageIndex(messages: QolSessionUserMessage[], query: string): number {
		const trimmed = query.trim().toLowerCase();
		if (trimmed) {
			const firstToken = trimmed.replace(/^re:/, "").replace(/["']/g, "").split(/\s+/).find(Boolean);
			if (firstToken) {
				const found = messages.findIndex((message) => message.text.toLowerCase().includes(firstToken));
				if (found >= 0) return found;
			}
		}
		return Math.max(0, messages.length - 1);
	}

	private openMessages(result: QolSessionSearchResult): void {
		const messages = userMessagesForResult(result);
		this.messagesState = {
			messages,
			result,
			selected: this.selectedMessageIndex(messages, this.searchState.query),
		};
		this.screen = "messages";
	}

	private selectedFocusText(message: QolSessionUserMessage): string {
		return `Focus on user message #${message.index}: ${message.text}`;
	}

	private handleSearchInput(data: string): void {
		const state = this.searchState;
		if (matchesKey(data, "escape")) {
			this.done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const result = state.results[state.selected];
			if (!result) return;
			this.openMessages(result);
			return;
		}
		if (matchesKey(data, "up")) {
			state.selected = Math.max(0, state.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			state.selected = Math.min(state.results.length - 1, state.selected + 1);
			return;
		}
		if (matchesKey(data, "pageup")) {
			state.selected = Math.max(0, state.selected - 10);
			return;
		}
		if (matchesKey(data, "pagedown")) {
			state.selected = Math.min(state.results.length - 1, state.selected + 10);
			return;
		}
		if (matchesKey(data, "left")) {
			state.cursor = Math.max(0, state.cursor - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			state.cursor = Math.min(state.query.length, state.cursor + 1);
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			state.cursor = 0;
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			state.cursor = state.query.length;
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.updateQuery("", 0);
			return;
		}
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			const before = state.query.slice(0, state.cursor);
			const after = state.query.slice(state.cursor);
			let i = before.length;
			while (i > 0 && /\s/.test(before[i - 1]!)) i -= 1;
			while (i > 0 && !/\s/.test(before[i - 1]!)) i -= 1;
			this.updateQuery(`${before.slice(0, i)}${after}`, i);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (state.cursor > 0) this.updateQuery(`${state.query.slice(0, state.cursor - 1)}${state.query.slice(state.cursor)}`, state.cursor - 1);
			return;
		}
		if (matchesKey(data, "delete")) {
			if (state.cursor < state.query.length) this.updateQuery(`${state.query.slice(0, state.cursor)}${state.query.slice(state.cursor + 1)}`, state.cursor);
			return;
		}
		if (isPrintableInput(data)) this.updateQuery(`${state.query.slice(0, state.cursor)}${data}${state.query.slice(state.cursor)}`, state.cursor + data.length);
	}

	private handleMessagesInput(data: string): void {
		const state = this.messagesState;
		if (!state) return;
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			this.screen = "search";
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const message = state.messages[state.selected];
			if (!message) return;
			this.actionState = { actionIndex: 0, message, result: state.result };
			this.screen = "actions";
			return;
		}
		if (matchesKey(data, "up")) {
			state.selected = Math.max(0, state.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			state.selected = Math.min(state.messages.length - 1, state.selected + 1);
			return;
		}
		if (matchesKey(data, "pageup")) {
			state.selected = Math.max(0, state.selected - 10);
			return;
		}
		if (matchesKey(data, "pagedown")) {
			state.selected = Math.min(state.messages.length - 1, state.selected + 10);
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			state.selected = 0;
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			state.selected = Math.max(0, state.messages.length - 1);
		}
	}

	private handleActionInput(data: string): void {
		const state = this.actionState;
		if (!state) return;
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			this.screen = "messages";
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			state.actionIndex = (state.actionIndex + 1) % QOL_SESSION_ACTIONS.length;
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			state.actionIndex = (state.actionIndex - 1 + QOL_SESSION_ACTIONS.length) % QOL_SESSION_ACTIONS.length;
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const action = QOL_SESSION_ACTIONS[state.actionIndex];
			if (action === "back") {
				this.screen = "messages";
				return;
			}
			if (action === "resume" || action === "copy") {
				this.done({ message: state.message, result: state.result, type: action });
				return;
			}
			this.focusState = { cursor: 0, message: state.message, prompt: "", result: state.result, type: action };
			this.screen = "focus";
		}
	}

	private handleFocusInput(data: string): void {
		const state = this.focusState;
		if (!state) return;
		if (matchesKey(data, "escape")) {
			this.screen = "actions";
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.done({ customPrompt: state.prompt.trim() || this.selectedFocusText(state.message), message: state.message, result: state.result, type: state.type });
			return;
		}
		if (matchesKey(data, "left")) {
			state.cursor = Math.max(0, state.cursor - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			state.cursor = Math.min(state.prompt.length, state.cursor + 1);
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			state.cursor = 0;
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			state.cursor = state.prompt.length;
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			state.prompt = "";
			state.cursor = 0;
			return;
		}
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			const before = state.prompt.slice(0, state.cursor);
			const after = state.prompt.slice(state.cursor);
			let i = before.length;
			while (i > 0 && /\s/.test(before[i - 1]!)) i -= 1;
			while (i > 0 && !/\s/.test(before[i - 1]!)) i -= 1;
			state.prompt = `${before.slice(0, i)}${after}`;
			state.cursor = i;
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (state.cursor > 0) {
				state.prompt = `${state.prompt.slice(0, state.cursor - 1)}${state.prompt.slice(state.cursor)}`;
				state.cursor -= 1;
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			if (state.cursor < state.prompt.length) state.prompt = `${state.prompt.slice(0, state.cursor)}${state.prompt.slice(state.cursor + 1)}`;
			return;
		}
		if (isPrintableInput(data)) {
			state.prompt = `${state.prompt.slice(0, state.cursor)}${data}${state.prompt.slice(state.cursor)}`;
			state.cursor += data.length;
		}
	}

	private renderSearch(width: number): string[] {
		const { bottom, divider, empty, inner, row, top } = boxParts(width, this.theme);
		const state = this.searchState;
		const lines: string[] = [top("Session Search"), empty()];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const cursor = accent("│");
		const queryDisplay = state.query
			? `${state.query.slice(0, state.cursor)}${cursor}${state.query.slice(state.cursor)}`
			: `${cursor}${muted("type to search sessions...")}`;
		lines.push(row(`  ${dim("◎")} ${queryDisplay}`));
		lines.push(row(dim(`    ${state.total} sessions · re:<pattern> regex · "phrase" exact`)));
		lines.push(empty(), divider(), empty());
		if (state.results.length === 0) {
			lines.push(row(muted(state.query.trim() ? "  No sessions match your search" : "  No sessions found")), empty());
		} else {
			const maxVisible = Math.max(3, Math.floor(settingNumber("sessionSearch.maxVisible", 8, this.cwd)));
			const start = Math.max(0, Math.min(state.selected - Math.floor(maxVisible / 2), state.results.length - maxVisible));
			const end = Math.min(start + maxVisible, state.results.length);
			const rowBudget = Math.max(10, inner - 1); // box row reserves one leading pad column
			for (let i = start; i < end; i++) {
				const result = state.results[i]!;
				const selected = i === state.selected;
				const prefix = selected ? accent("▸") : dim("·");
				const title = sessionResumeTitle(result);
				const right = dim(`${promptCountLabel(sessionUserPromptCount(result))} · ${formatSessionSearchDate(result.modified)}`);
				const prefixText = ` ${prefix} `;
				const titleBudget = Math.max(12, rowBudget - visibleWidth(prefixText) - visibleWidth(right) - 1);
				const titleText = truncateToWidth(title, titleBudget, "…");
				const left = `${prefixText}${selected ? this.theme.bold(accent(titleText)) : this.theme.bold(titleText)}`;
				const gap = Math.max(1, rowBudget - visibleWidth(left) - visibleWidth(right));
				lines.push(row(`${left}${" ".repeat(gap)}${right}`));

				const folder = shortPathForUi(result.cwd || dirname(result.path));
				const project = sessionDisplayName(result);
				lines.push(row(`    ${muted(truncateToWidth(`${project} · ${folder}`, inner - 8, "…"))}`));

				const snippet = state.query.trim() ? (result.snippets[0] || lastUserMessageSnippet(result)) : lastUserMessageSnippet(result);
				const label = state.query.trim() ? "match" : "last";
				lines.push(row(`    ${dim(`${label}:`)} ${truncateToWidth(styleSessionSnippet(snippet, state.query, this.theme), inner - 12, "…")}`));
				if (i < end - 1) lines.push(row(dim(`  ${"─".repeat(Math.max(8, inner - 4))}`)));
			}
			if (state.results.length > maxVisible) lines.push(empty(), row(dim(`  ${state.selected + 1}/${state.results.length} ${state.query.trim() ? "matches" : "recent sessions"}`)));
		}
		lines.push(divider());
		lines.push(row(`${accent("↑↓")} ${dim("sessions")}  ${accent("enter")} ${dim("prompts")}  ${accent("ctrl+u")} ${dim("clear")}  ${accent("esc")} ${dim("close")}`));
		lines.push(bottom());
		return lines;
	}

	private renderMessages(width: number, state: QolSessionMessagesState): string[] {
		const { bottom, divider, empty, inner, row, top } = boxParts(width, this.theme);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const result = state.result;
		const lines: string[] = [top("Your Prompts"), empty()];
		const headerBudget = Math.max(10, inner - 1);
		const right = dim(`${promptCountLabel(state.messages.length)} · ${formatSessionSearchDate(result.modified)}`);
		const title = truncateToWidth(sessionResumeTitle(result), Math.max(12, headerBudget - visibleWidth(right) - 3), "…");
		const left = `  ${this.theme.bold(accent(title))}`;
		const gap = Math.max(1, headerBudget - visibleWidth(left) - visibleWidth(right));
		lines.push(row(`${left}${" ".repeat(gap)}${right}`));
		lines.push(row(`  ${muted(truncateToWidth(shortPathForUi(result.cwd || result.path), inner - 4, "…"))}`));
		lines.push(row(dim(`  ${state.messages.length} user prompt${state.messages.length === 1 ? "" : "s"} · choose one for actions/focus`)));
		lines.push(empty(), divider(), empty());

		const maxVisible = Math.max(6, Math.floor(settingNumber("sessionSearch.messageMaxVisible", 12, this.cwd)));
		const start = Math.max(0, Math.min(state.selected - Math.floor(maxVisible / 2), state.messages.length - maxVisible));
		const end = Math.min(start + maxVisible, state.messages.length);
		for (let i = start; i < end; i++) {
			const message = state.messages[i]!;
			const selected = i === state.selected;
			const prefix = selected ? accent("▸") : dim("·");
			const number = dim(`#${message.index}`.padStart(4));
			const textWidth = Math.max(12, inner - visibleWidth(prefix) - visibleWidth(number) - 8);
			const text = truncateToWidth(message.text, textWidth, "…");
			lines.push(row(` ${prefix} ${number} ${selected ? this.theme.bold(accent(text)) : text}`));
		}
		if (state.messages.length > maxVisible) lines.push(empty(), row(dim(`  ${state.selected + 1}/${state.messages.length} user prompts`)));
		lines.push(divider());
		lines.push(row(`${accent("↑↓")} ${dim("prompts")}  ${accent("enter")} ${dim("actions")}  ${accent("esc")} ${dim("sessions")}`));
		lines.push(bottom());
		return lines;
	}

	private renderActions(width: number, state: QolSessionActionState): string[] {
		const { bottom, divider, empty, inner, row, top } = boxParts(width, this.theme);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const lines: string[] = [top("Message Actions"), empty()];
		lines.push(row(`  ${this.theme.bold(accent(sessionResumeTitle(state.result)))}  ${dim(`#${state.message.index}`)}`));
		lines.push(row(`  ${muted(truncateToWidth(shortPathForUi(state.result.cwd || state.result.path), inner - 4, "…"))}`));
		lines.push(empty(), divider(), empty());
		lines.push(row(dim("  Selected prompt:")));
		const wrapped = wrapVisible(state.message.text, inner - 6, 4);
		for (const line of wrapped) lines.push(row(`  ${line}`));
		lines.push(empty());
		lines.push(row(dim("  Resume opens the full session. Summary actions use this prompt as focus.")));
		lines.push(empty(), divider());
		const actions = QOL_SESSION_ACTIONS.map((action, index) => {
			const label = QOL_SESSION_ACTION_LABELS[action];
			return index === state.actionIndex ? this.theme.bold(accent(`[${label}]`)) : dim(`[${label}]`);
		});
		lines.push(row(`  ${actions.join(" ")}`));
		lines.push(row(`${accent("tab")}/${accent("←→")} ${dim("cycle")}  ${accent("enter")} ${dim("choose")}  ${accent("esc")} ${dim("prompts")}`));
		lines.push(bottom());
		return lines;
	}

	private renderFocus(width: number, state: QolSessionFocusState): string[] {
		const { bottom, divider, empty, inner, row, top } = boxParts(width, this.theme);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const action = state.type === "newSession" ? "New + Context" : "Inject Summary";
		const lines: string[] = [top("Summary Focus"), empty()];
		lines.push(row(`  ${accent(sessionResumeTitle(state.result))}  ${dim(`→ ${action}`)}`));
		lines.push(row(`  ${muted(truncateToWidth(`Default focus: #${state.message.index} ${state.message.text}`, inner - 4, "…"))}`));
		lines.push(empty(), divider(), empty());
		const cursor = accent("│");
		const prefix = `  ${dim("✎")} `;
		const textWidth = Math.max(10, inner - visibleWidth(prefix) - 2);
		if (!state.prompt) {
			lines.push(row(`${prefix}${cursor}${muted("optional override; Enter uses selected prompt as focus...")}`));
		} else {
			const text = `${state.prompt.slice(0, state.cursor)}${cursor}${state.prompt.slice(state.cursor)}`;
			const wrapped = wrapVisible(text, textWidth, 5);
			for (let i = 0; i < wrapped.length; i++) lines.push(row(`${i === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${wrapped[i]}`));
		}
		lines.push(empty(), divider());
		lines.push(row(`${accent("enter")} ${dim("summarize")}  ${accent("esc")} ${dim("actions")}`));
		lines.push(bottom());
		return lines;
	}
}

function wrapVisible(text: string, width: number, maxLines: number): string[] {
	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length <= maxLines) return wrapped;
	const head = wrapped.slice(0, Math.max(0, maxLines - 1));
	const tail = wrapped.slice(Math.max(0, maxLines - 1)).join(" ");
	return [...head, truncateToWidth(tail, width, "…")];
}

function trimSessionSummaryInput(text: string, cwd: string): string {
	const maxChars = Math.max(20_000, Math.floor(settingNumber("sessionSearch.summaryInputMaxChars", DEFAULT_SESSION_SEARCH_SUMMARY_INPUT_CHARS, cwd)));
	if (text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * 0.35);
	const tailChars = maxChars - headChars;
	const omitted = text.length - maxChars;
	return `${text.slice(0, headChars)}\n\n[... ${omitted.toLocaleString()} character(s) omitted from the middle of this imported session ...]\n\n${text.slice(-tailChars)}`;
}

function messagesForSessionSummary(sessionPath: string): AgentMessage[] {
	try {
		const manager = SessionManager.open(sessionPath);
		const context = manager.buildSessionContext();
		if (Array.isArray(context.messages) && context.messages.length > 0) return context.messages as AgentMessage[];
	} catch {
		// Fall back to a direct JSONL parse below.
	}
	try {
		const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
		const messages: AgentMessage[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry?.type === "message" && entry.message) messages.push(entry.message);
		}
		return messages;
	} catch {
		return [];
	}
}

async function buildSessionSearchContextMessage(ctx: ExtensionContext, result: QolSessionSearchResult, customPrompt?: string): Promise<QolSessionSearchPendingMessage> {
	const messages = messagesForSessionSummary(result.path);
	const fallbackText = result.allMessagesText || result.firstMessage;
	const conversationText = messages.length > 0 ? serializeConversation(convertToLlm(messages)) : fallbackText;
	if (!conversationText.trim()) throw new Error("Selected session has no text content to summarize");
	const focus = customPrompt?.trim();
	const summary = await generateQolSummary(ctx, {
		conversationText: trimSessionSummaryInput(conversationText, ctx.cwd),
		maxTokens: Math.max(256, Math.floor(settingNumber("sessionSearch.summaryMaxTokens", DEFAULT_SESSION_SEARCH_SUMMARY_MAX_TOKENS, ctx.cwd))),
		model: settingString("sessionSearch.summaryModel", "current", ctx.cwd),
		customInstructions: [
			`Source session file: ${result.path}`,
			`Source project/cwd: ${result.cwd || sessionDisplayName(result)}`,
			focus ? `User focus: ${focus}` : "Focus on facts needed to continue or reference this previous session.",
		].join("\n"),
		purpose: "session-search",
		signal: ctx.signal,
	});
	const title = sessionDisplayName(result);
	const content = [
		`## Session Search Context: ${title}`,
		`**Date:** ${result.modified.toISOString()} | **File:** ${result.path}`,
		focus ? `**Focus:** ${focus}` : undefined,
		"",
		summary.summary,
	].filter((line): line is string => line !== undefined).join("\n");
	return {
		content,
		details: {
			file: result.path,
			focus,
			model: summary.model,
			project: result.cwd || title,
			source: "pi-qol-session-search",
			via: summary.via,
		},
	};
}

async function injectSessionSearchContext(pi: ExtensionAPI, ctx: ExtensionContext, result: QolSessionSearchResult, customPrompt?: string): Promise<void> {
	const title = sessionDisplayName(result);
	ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, `🔍 Summarizing ${title}...`);
	try {
		const message = await buildSessionSearchContextMessage(ctx, result, customPrompt);
		pi.sendMessage({ customType: SESSION_SEARCH_CONTEXT_TYPE, content: message.content, details: message.details, display: true }, { deliverAs: "followUp", triggerTurn: false });
		ctx.ui.notify(`Session context injected: ${title}`, "info");
	} finally {
		ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
	}
}

function asCommandContext(ctx: ExtensionContext): (ExtensionContext & Partial<ExtensionCommandContext>) {
	return ctx as ExtensionContext & Partial<ExtensionCommandContext>;
}

async function createNewSessionWithSearchContext(pi: ExtensionAPI, ctx: ExtensionContext, result: QolSessionSearchResult, customPrompt?: string): Promise<void> {
	const title = sessionDisplayName(result);
	ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, `🔍 Summarizing ${title}...`);
	try {
		const message = await buildSessionSearchContextMessage(ctx, result, customPrompt);
		const commandCtx = asCommandContext(ctx);
		if (typeof commandCtx.newSession === "function") {
			const parentSession = ctx.sessionManager.getSessionFile?.();
			const switchResult = await commandCtx.newSession({
				parentSession,
				withSession: async (replacementCtx: any) => {
					if (typeof replacementCtx.sendMessage === "function") {
						await replacementCtx.sendMessage({ customType: SESSION_SEARCH_CONTEXT_TYPE, content: message.content, details: message.details, display: true }, { triggerTurn: false });
					}
					replacementCtx.ui.notify(`New session has context from ${title}`, "info");
				},
			});
			if (switchResult.cancelled) ctx.ui.notify("New session cancelled", "info");
			return;
		}
		setPendingSessionSearchMessage(message);
		ctx.ui.setEditorText("/new");
		ctx.ui.notify(`${title} — press Enter to create a new session with this context`, "info");
	} finally {
		ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
	}
}

async function consumePendingSessionSearchContext(pi: ExtensionAPI, ctx: ExtensionContext, reason: unknown): Promise<void> {
	if (reason !== "new") return;
	const pending = getPendingSessionSearchMessage();
	if (!pending) return;
	setPendingSessionSearchMessage(undefined);
	pi.sendMessage({ customType: SESSION_SEARCH_CONTEXT_TYPE, content: pending.content, details: pending.details, display: true }, { triggerTurn: false });
	if (ctx.hasUI) ctx.ui.notify("Imported session-search context.", "info");
}

async function openQolSessionSearch(pi: ExtensionAPI, ctx: ExtensionContext, initialQuery = ""): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Session search requires interactive UI", "warning");
		return;
	}
	const sessions = await refreshQolSessionSearchCache(ctx);
	const releaseModalLock = acquireVstackModalLock();
	let action: QolSessionPaletteAction | undefined;
	try {
		action = await ctx.ui.custom<QolSessionPaletteAction>((tui, theme, _keybindings, done) =>
			new QolSessionSearchComponent(done, tui, theme, sessions, ctx.cwd, initialQuery), {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: Math.max(70, Math.floor(settingNumber("sessionSearch.overlayWidth", 104, ctx.cwd))),
				maxHeight: "90%",
			},
		});
	} finally {
		releaseModalLock();
	}
	if (!action || action.type === "cancel" || !action.result) return;
	if (action.type === "resume") {
		const commandCtx = asCommandContext(ctx);
		if (typeof commandCtx.switchSession === "function") {
			try {
				const result = await commandCtx.switchSession(action.result.path);
				if (!result.cancelled) ctx.ui.notify(`Resumed ${sessionDisplayName(action.result)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Resume failed: ${stringifyError(error)}`, "error");
			}
			return;
		}
		ctx.ui.setEditorText(`/resume ${quoteSessionSearchArg(action.result.path)}`);
		ctx.ui.notify(`${sessionDisplayName(action.result)} — press Enter to resume`, "info");
		return;
	}
	if (action.type === "copy") {
		const text = action.message?.text || action.result.firstMessage;
		ctx.ui.setEditorText(text);
		ctx.ui.notify("Copied selected prompt into the editor", "info");
		return;
	}
	if (action.type === "summarize") {
		try {
			await injectSessionSearchContext(pi, ctx, action.result, action.customPrompt);
		} catch (error) {
			ctx.ui.notify(`Session summary failed: ${stringifyError(error)}`, "error");
			ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
		}
		return;
	}
	if (action.type === "newSession") {
		try {
			await createNewSessionWithSearchContext(pi, ctx, action.result, action.customPrompt);
		} catch (error) {
			ctx.ui.notify(`New session context failed: ${stringifyError(error)}`, "error");
			ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
		}
	}
}

function quoteSessionSearchArg(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderSessionSearchContextMessage(message: any, options: any, theme: Theme): Text {
	const raw = typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.map((part: any) => part?.type === "text" ? part.text ?? "" : "").join("")
			: "";
	const title = raw.match(/^## Session Search Context:\s*(.+)$/m)?.[1]?.trim() || "session";
	const date = raw.match(/\*\*Date:\*\*\s*([^|\n]+)/)?.[1]?.trim() || "";
	const header = `${theme.fg("accent", "🔍 ")}${theme.fg("customMessageLabel", theme.bold("Session context: "))}${theme.fg("accent", title)}${date ? theme.fg("muted", ` (${date})`) : ""}`;
	if (!options?.expanded) return new Text(header, 0, 0);
	const body = raw.slice(raw.indexOf("\n") + 1).trim();
	return new Text(body ? `${header}\n\n${theme.fg("muted", body)}` : header, 0, 0);
}

export default function qol(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	installThinkingTimerPatch();
	const thinkingTimerStore: ThinkingTimerStore = {
		enabled: false,
		starts: new Map(),
		durations: new Map(),
		labels: new Map(),
	};
	(globalThis as unknown as Record<PropertyKey, unknown>)[THINKING_TIMER_STORE_SYMBOL] = thinkingTimerStore;

	let editorPollTimer: ReturnType<typeof setInterval> | undefined;
	let idleCompactionTimer: ReturnType<typeof setTimeout> | undefined;
	let questionSubscribeTimer: ReturnType<typeof setInterval> | undefined;
	let sessionSearchWarmupTimer: ReturnType<typeof setTimeout> | undefined;
	let thinkingTimerTicker: ReturnType<typeof setInterval> | undefined;
	let questionUnsubscribe: (() => void) | undefined;
	let lastPolledDraft = "";
	let lastTaskStats: { completed: number; remaining: number; total: number } | undefined;
	let autoRenameAttempted = false;
	let autoRenameInProgress = false;
	let autoRenameGeneration = 0;
	let latestSystemPromptOptions: unknown;

	const resetAutoRename = () => {
		autoRenameAttempted = false;
		autoRenameInProgress = false;
		autoRenameGeneration += 1;
	};

	const attemptAutoRename = async (ctx: ExtensionContext, options: { force?: boolean; fullConversation?: boolean; notify?: boolean } = {}) => {
		const force = options.force === true;
		if (!force && !autoRenameEnabled(ctx.cwd)) return;
		if (autoRenameInProgress) return;
		if (!force && (autoRenameAttempted || pi.getSessionName())) return;
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		const maxInputChars = Math.max(200, Math.floor(settingNumber("sessionAutoRename.maxInputChars", DEFAULT_AUTO_RENAME_INPUT_CHARS, ctx.cwd)));
		const sourceText = options.fullConversation ? conversationTranscriptText(branch, maxInputChars) : firstUserMessageText(branch);
		if (!sourceText) {
			if (force) autoRenameNotify(ctx, "No user message found to name this session.", "warning", true);
			return;
		}
		const generation = autoRenameGeneration;
		if (!force) autoRenameAttempted = true;
		autoRenameInProgress = true;
		try {
			const result = await generateAutoRenameName(sourceText, ctx, options.fullConversation === true);
			if (generation !== autoRenameGeneration) return;
			if (!result.name) {
				autoRenameNotify(ctx, "No session name generated.", "warning", options.notify === true || force);
				return;
			}
			if (!force && pi.getSessionName()) return;
			const name = withAutoRenamePrefix(result.name, ctx.cwd);
			if (!name) return;
			pi.setSessionName(name);
			autoRenameNotify(ctx, `Session named: ${name} (${result.source})`, "info", options.notify === true || force);
		} finally {
			if (generation === autoRenameGeneration) autoRenameInProgress = false;
		}
	};

	const stopThinkingTimerTicker = () => {
		if (thinkingTimerTicker) clearInterval(thinkingTimerTicker);
		thinkingTimerTicker = undefined;
	};

	const tickThinkingTimer = () => {
		if (!thinkingTimerStore.enabled || thinkingTimerStore.starts.size === 0) {
			stopThinkingTimerTicker();
			return;
		}
		for (const [key, start] of thinkingTimerStore.starts.entries()) {
			const label = thinkingTimerStore.labels.get(key);
			if (label) label.setText(thinkingTimerLabel(thinkingTimerStore.theme, Date.now() - start));
		}
	};

	const startThinkingTimerTicker = () => {
		if (thinkingTimerTicker) return;
		thinkingTimerTicker = setInterval(tickThinkingTimer, 100);
		thinkingTimerTicker.unref?.();
	};

	const resetThinkingTimer = (ctx?: ExtensionContext) => {
		stopThinkingTimerTicker();
		thinkingTimerStore.starts.clear();
		thinkingTimerStore.durations.clear();
		thinkingTimerStore.labels.clear();
		thinkingTimerStore.theme = ctx?.ui.theme;
		thinkingTimerStore.enabled = !!ctx?.hasUI && settingBoolean("thinkingTimer.enabled", true, ctx?.cwd);
	};

	const updateThinkingTimerEnabled = (ctx: ExtensionContext): boolean => {
		thinkingTimerStore.theme = ctx.ui.theme;
		const enabled = ctx.hasUI && settingBoolean("thinkingTimer.enabled", true, ctx.cwd);
		if (thinkingTimerStore.enabled && !enabled) resetThinkingTimer(ctx);
		thinkingTimerStore.enabled = enabled;
		return enabled;
	};

	const finalizeThinkingBlock = (key: string, endTimeMs = Date.now()) => {
		const start = thinkingTimerStore.starts.get(key);
		if (start === undefined) return;
		const duration = Math.max(0, endTimeMs - start);
		thinkingTimerStore.starts.delete(key);
		thinkingTimerStore.durations.set(key, duration);
		const label = thinkingTimerStore.labels.get(key);
		if (label) label.setText(thinkingTimerLabel(thinkingTimerStore.theme, duration));
		if (thinkingTimerStore.starts.size === 0) stopThinkingTimerTicker();
	};

	const clearIdleCompactionTimer = () => {
		if (idleCompactionTimer) clearTimeout(idleCompactionTimer);
		idleCompactionTimer = undefined;
	};

	const scheduleIdleCompaction = (ctx: ExtensionContext) => {
		clearIdleCompactionTimer();
		if (!settingBoolean("compaction.idleEnabled", false, ctx.cwd)) return;
		const reason = compactionTriggerReason(ctx);
		if (!reason) return;
		const delayMs = Math.max(1, Math.floor(settingNumber("compaction.idleTimeoutSeconds", DEFAULT_IDLE_COMPACTION_SECONDS, ctx.cwd))) * 1000;
		idleCompactionTimer = setTimeout(() => {
			idleCompactionTimer = undefined;
			if (!ctx.isIdle?.()) return;
			const latestReason = compactionTriggerReason(ctx);
			if (!latestReason) return;
			compactionNotify(ctx, `QOL idle compaction starting: ${latestReason}`, "info");
			ctx.compact?.({
				customInstructions: `QOL idle compaction triggered after inactivity because ${latestReason}. Preserve current task state, decisions, files, blockers, and next steps.`,
				onComplete: () => compactionNotify(ctx, "QOL idle compaction completed.", "info"),
				onError: (error: Error) => compactionNotify(ctx, `QOL idle compaction failed: ${stringifyError(error)}`, "error"),
			});
		}, delayMs);
		idleCompactionTimer.unref?.();
	};

	const clearQuestionSubscribeTimer = () => {
		if (questionSubscribeTimer) clearInterval(questionSubscribeTimer);
		questionSubscribeTimer = undefined;
	};

	const subscribeToQuestions = (ctx: ExtensionContext): boolean => {
		if (questionUnsubscribe) return true;
		const service = getQuestionService();
		if (!service) return false;
		questionUnsubscribe = service.subscribe((event: any) => {
			if (event?.action !== "opened") return;
			notifyQuestionOpened(ctx, { requestId: event.requestId, request: event.request, source: event.source }, "question");
		});
		return true;
	};

	const startQuestionSubscription = (ctx: ExtensionContext) => {
		if (subscribeToQuestions(ctx) || questionSubscribeTimer) return;
		let attempts = 0;
		questionSubscribeTimer = setInterval(() => {
			attempts += 1;
			if (subscribeToQuestions(ctx) || attempts >= 40) clearQuestionSubscribeTimer();
		}, 250);
		questionSubscribeTimer.unref?.();
	};

	let pendingTaskCompleteNotification: string | undefined;
	const maybeNotifyTaskCompletion = (_ctx: ExtensionContext, state: any) => {
		const stats = taskStats(state);
		if (!stats) return;
		const previous = lastTaskStats;
		lastTaskStats = stats;
		if (stats.total === 0 || stats.remaining !== 0 || stats.completed !== stats.total) {
			pendingTaskCompleteNotification = undefined;
			return;
		}
		if (previous && previous.total === stats.total && previous.remaining === 0 && previous.completed === stats.completed) return;
		if (previous && previous.remaining <= 0) return;
		pendingTaskCompleteNotification = `Task list complete: ${stats.completed}/${stats.total} done.`;
	};

	let currentCtx: ExtensionContext | undefined;
	const notificationService: QolNotificationService = {
		notifyQuestionOpened(ctx, event) {
			notifyQuestionOpened(ctx ?? currentCtx, event, "question");
			return true;
		},
	};
	(globalThis as unknown as Record<PropertyKey, unknown>)[QOL_NOTIFICATION_SERVICE_SYMBOL] = notificationService;

	pi.events.on(QUESTION_OPENED_EVENT, (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const event = data as QuestionOpenedEventLike;
		notifyQuestionOpened(currentCtx, event, "question");
	});

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		latestSystemPromptOptions = undefined;
		resetAutoRename();
		resetThinkingTimer(ctx);
		void consumePendingSessionSearchContext(pi, ctx, event.reason);
		installAutocompleteHintStyling(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new QolEditor(tui, theme, keybindings, ctx));
		if (editorPollTimer) clearInterval(editorPollTimer);
		lastPolledDraft = "";
		if (ctx.hasUI) {
			editorPollTimer = setInterval(() => {
				try {
					const draft = currentEditorText(ctx);
					if (draft === lastPolledDraft) return;
					lastPolledDraft = draft;
					if (collapseEditorImagePaths(ctx)) lastPolledDraft = currentEditorText(ctx);
				} catch {
					// Best-effort visual helper only.
				}
			}, 250);
			editorPollTimer.unref?.();
		}
		const fallback = newlineFallbackKey(ctx.cwd);
		if (ctx.hasUI && fallback !== "none") {
			ctx.ui.notify(`QOL multiline input active. Shift+Enter inserts newline when your terminal reports it; fallback: ${fallback}.`, "info");
		}
		startQuestionSubscription(ctx);
		void attemptAutoRename(ctx);
		if (settingBoolean("sessionSearch.enabled", true, ctx.cwd)) {
			if (sessionSearchWarmupTimer) clearTimeout(sessionSearchWarmupTimer);
			sessionSearchWarmupTimer = setTimeout(() => {
				sessionSearchWarmupTimer = undefined;
				void refreshQolSessionSearchCache(ctx, { quiet: true }).catch(() => undefined);
			}, 500);
			sessionSearchWarmupTimer.unref?.();
		}
	});

	pi.on("before_agent_start", (event: any) => {
		latestSystemPromptOptions = event?.systemPromptOptions;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetAutoRename();
		if (editorPollTimer) clearInterval(editorPollTimer);
		editorPollTimer = undefined;
		clearIdleCompactionTimer();
		clearQuestionSubscribeTimer();
		if (sessionSearchWarmupTimer) clearTimeout(sessionSearchWarmupTimer);
		sessionSearchWarmupTimer = undefined;
		resetThinkingTimer(undefined);
		clearTmuxWindowMark();
		questionUnsubscribe?.();
		questionUnsubscribe = undefined;
		currentCtx = undefined;
		const host = globalThis as unknown as Record<PropertyKey, unknown>;
		if (host[QOL_NOTIFICATION_SERVICE_SYMBOL] === notificationService) delete host[QOL_NOTIFICATION_SERVICE_SYMBOL];
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
		ctx.ui.setEditorComponent(undefined);
	});

	pi.on("agent_start", () => {
		clearIdleCompactionTimer();
		clearTmuxWindowMark();
	});
	pi.on("message_update", (event, ctx) => {
		if (!updateThinkingTimerEnabled(ctx)) return;
		const streamEvent = event.assistantMessageEvent as any;
		if (!streamEvent || typeof streamEvent.type !== "string") return;
		if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
			const partial = streamEvent.partial;
			if (!partial || typeof partial.timestamp !== "number" || typeof streamEvent.contentIndex !== "number") return;
			const key = thinkingTimerKey(partial.timestamp, streamEvent.contentIndex);
			if (!thinkingTimerStore.starts.has(key) && !thinkingTimerStore.durations.has(key)) thinkingTimerStore.starts.set(key, Date.now());
			startThinkingTimerTicker();
			tickThinkingTimer();
			return;
		}
		if (streamEvent.type === "thinking_end") {
			const partial = streamEvent.partial;
			if (!partial || typeof partial.timestamp !== "number" || typeof streamEvent.contentIndex !== "number") return;
			finalizeThinkingBlock(thinkingTimerKey(partial.timestamp, streamEvent.contentIndex));
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (!updateThinkingTimerEnabled(ctx)) return;
		const message = event.message as any;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (let i = 0; i < message.content.length; i++) {
			if (message.content[i]?.type !== "thinking") continue;
			finalizeThinkingBlock(thinkingTimerKey(message.timestamp, i));
		}
	});
	pi.on("agent_end", (event, ctx) => {
		scheduleIdleCompaction(ctx);
		void attemptAutoRename(ctx);
		const text = lastAssistantTextFromAgentEnd(event, ctx);
		const critical = criticalInfo(text);
		if (critical) {
			pendingTaskCompleteNotification = undefined;
			sendQolNotification(ctx, "critical", `Critical: ${critical}`, "error", `critical:${critical.slice(0, 80)}`);
			return;
		}
		if (pendingTaskCompleteNotification) {
			const body = pendingTaskCompleteNotification;
			pendingTaskCompleteNotification = undefined;
			sendQolNotification(ctx, "task-complete", body, "info", "task-complete");
			return;
		}
		if (ctx.hasPendingMessages?.()) return;
		if (needsDirection(text)) {
			sendQolNotification(ctx, "direction", "Pi is awaiting your direction.", "warning", "direction");
			return;
		}
		sendQolNotification(ctx, "ready", settingString("notification.readyMessage", "Ready for input", ctx.cwd), "info", "ready");
	});
	pi.on("session_before_compact", (event, ctx) => handleQolCompaction(event, ctx));
	pi.on("session_before_tree", (event, ctx) => handleQolBranchSummary(event, ctx));
	pi.on("tool_call", async (event: any, ctx) => {
		if (event?.toolName === "question") {
			notifyQuestionOpened(ctx, { requestId: event.input?.id ?? event.toolCallId, request: event.input, source: "tool_call" }, "question");
			return undefined;
		}
		if (!settingBoolean("permissionGate.enabled", false, ctx.cwd)) return undefined;
		if (event?.toolName !== "bash") return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return undefined;
		const matched = permissionGateMatch(command, ctx.cwd);
		if (!matched) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `Command matched permission gate (${matched}) and no UI is available for confirmation` };
		const choice = await ctx.ui.select(permissionGatePrompt(matched, command, ctx.cwd), ["Allow once", "Block"]);
		if (choice !== "Allow once") return { block: true, reason: `Blocked by QOL permission gate (${matched})` };
		return undefined;
	});
	pi.on("tool_result", (event: any, ctx) => {
		if (event?.toolName === "tasks_write") maybeNotifyTaskCompletion(ctx, event.details?.state);
	});

	pi.on("input", async (event) => {
		clearTmuxWindowMark();
		if (event.source === "extension") return { action: "continue" };
		const paths = aliasedImagePaths(event.text ?? "");
		if (paths.length === 0) return { action: "continue" };
		const images = paths.map(imageContentForPath).filter(Boolean);
		if (images.length === 0) return { action: "continue" };
		return { action: "transform", images: [...(event.images ?? []), ...images], text: event.text };
	});

	if (settingBoolean("enableSessionNameCommand", true)) {
		pi.registerCommand("rename", {
			description: "Current session friendly-name editor.",
			handler: async (args, ctx) => {
				const name = args.trim();
				if (name) {
					pi.setSessionName(name);
					ctx.ui.notify(`Session named: ${name}`, "info");
					return;
				}

				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			},
		});
	}

	if (settingBoolean("enableHandoffCommand", true)) {
		pi.registerCommand("handoff", {
			description: "Focused context handoff to a new session.",
			handler: async (args, ctx) => runHandoff(args, ctx),
		});
	}

	if (settingBoolean("enableContextCommand", true)) {
		pi.registerMessageRenderer(CONTEXT_USAGE_MESSAGE_TYPE, renderQolContextUsageMessage);
		pi.registerCommand("context", {
			description: "Show context-window usage and estimated category breakdowns inline.",
			handler: async (_args, ctx) => {
				const details = buildQolContextUsageDetails(pi, ctx, latestSystemPromptOptions);
				if (!details) {
					ctx.ui.notify("Context usage info is not available yet.", "warning");
					return;
				}
				pi.sendMessage({ customType: CONTEXT_USAGE_MESSAGE_TYPE, content: "Context usage snapshot", details, display: true }, { deliverAs: "followUp", triggerTurn: false });
			},
		});
	}

	if (settingBoolean("sessionSearch.enabled", true)) {
		pi.registerMessageRenderer(SESSION_SEARCH_CONTEXT_TYPE, renderSessionSearchContextMessage);

		const handleSearchCommand = async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed === "refresh") {
				try {
					const sessions = await refreshQolSessionSearchCache(ctx, { force: true });
					ctx.ui.notify(`Session search refreshed: ${sessions.length} session(s)`, "info");
				} catch (error) {
					ctx.ui.notify(`Session search refresh failed: ${stringifyError(error)}`, "error");
				}
				return;
			}
			await openQolSessionSearch(pi, ctx, trimmed);
		};

		pi.registerCommand("search", {
			description: "Previous-session search and context import.",
			getArgumentCompletions: getSessionSearchArgumentCompletions,
			handler: handleSearchCommand,
		});
		const shortcut = sessionSearchShortcut();
		if (shortcut) {
			pi.registerShortcut(shortcut, {
				description: "Search previous sessions",
				handler: async (ctx) => openQolSessionSearch(pi, ctx as ExtensionContext),
			});
		}
	}

	pi.registerCommand("qol", {
		description: "QOL helpers and settings.",
		getArgumentCompletions: getQolArgumentCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.search(/\s/);
			const sub = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase() || "status";
			const rest = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
			const restLower = rest.toLowerCase();
			if (sub === "status") {
				ctx.ui.notify(statusMessage(ctx), "info");
				return;
			}
			if (sub === "rename") {
				if (!restLower) {
					await attemptAutoRename(ctx, { force: true, notify: true });
					return;
				}
				if (restLower === "full") {
					await attemptAutoRename(ctx, { force: true, fullConversation: true, notify: true });
					return;
				}
				ctx.ui.notify("Unknown /qol rename mode. Try /qol rename or /qol rename full.", "warning");
				return;
			}
			if (sub === "notify-test") {
				sendQolNotification(ctx, "test", "QOL notification test", "info", `test:${Date.now()}`);
				ctx.ui.notify("Sent QOL notification test.", "info");
				return;
			}
			ctx.ui.notify("Unknown /qol action. Try /qol status, /qol rename, /qol rename full, or /qol notify-test.", "warning");
		},
	});
}
