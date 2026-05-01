import { complete, type Message } from "@mariozechner/pi-ai";
import { AssistantMessageComponent, BorderedLoader, convertToLlm, CustomEditor, serializeConversation, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager, type SessionEntry, type SessionMessageEntry, type Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-qol.installed");
const STATUS_KEY = "qol-attachments";
const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const IMAGE_PATH_PATTERN = /(^|[\s(\[{<"'`])(@?(?:~|\.\.?|\/)[^\s)\]}>"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))(?=$|[\s)\]}>"'`,.;:!?])/gi;
const IMAGE_ALIAS_SYMBOL = Symbol.for("vstack.pi-qol.image-path-aliases");
const QUESTION_SERVICE_SYMBOL = Symbol.for("vstack.pi-questions.service");
const QOL_NOTIFICATION_SERVICE_SYMBOL = Symbol.for("vstack.pi-qol.notification-service");
const THINKING_TIMER_STORE_SYMBOL = Symbol.for("vstack.pi-qol.thinking-timer.store");
const THINKING_TIMER_PATCH_SYMBOL = Symbol.for("vstack.pi-qol.thinking-timer.patch");
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

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
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
	return `\x1b[7m${text}${RESET}`;
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
		const fallback = settingString("newlineFallbackKey", "ctrl+j", this.ctx.cwd);
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
type QolSummaryPurpose = "compaction" | "branch-summary";

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
	const purposeText = options.purpose === "branch-summary" ? "the branch being left during /tree navigation" : "the conversation span being compacted";
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

function resolveCompactionModel(ctx: ExtensionContext): any | undefined {
	const configured = settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd);
	if (!configured || configured === "current") return ctx.model;
	const withoutThinking = configured.replace(/:(off|minimal|low|medium|high|xhigh)$/i, "");
	const slash = withoutThinking.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(withoutThinking.slice(0, slash), withoutThinking.slice(slash + 1));
	const providers = [ctx.model?.provider, "google", "openai", "anthropic"].filter((value): value is string => typeof value === "string");
	for (const provider of providers) {
		const model = ctx.modelRegistry.find(provider, withoutThinking);
		if (model) return model;
	}
	return undefined;
}

function modelLabel(model: any): string {
	return model ? `${model.provider}/${model.id}` : "unknown model";
}

async function generateQolSummary(ctx: ExtensionContext, options: {
	conversationText: string;
	customInstructions?: string;
	previousSummary?: string;
	purpose: QolSummaryPurpose;
	signal?: AbortSignal;
}): Promise<{ model: string; summary: string; via: "model" | "remote" }> {
	const maxTokens = Math.max(256, Math.floor(settingNumber("compaction.maxTokens", DEFAULT_COMPACTION_MAX_TOKENS, ctx.cwd)));
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

	const model = resolveCompactionModel(ctx);
	if (!model) throw new Error(`Compaction model not found: ${settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd)}`);
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
	const match = text.match(/\b(critical|urgent|warning|blocked|cannot proceed|failed|failure|error|security|vulnerab|secret|credential|permission denied|rate limit|context (overflow|full)|manual action required)\b/i);
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

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry: SessionEntry): entry is SessionMessageEntry => entry.type === "message")
		.map((entry: SessionMessageEntry) => entry.message);

	if (messages.length === 0) {
		ctx.ui.notify("No conversation to hand off", "error");
		return;
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const currentSessionFile = ctx.sessionManager.getSessionFile();

	const result = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
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
	return [
		"Pi QOL status",
		`Shift+Enter newline: ${settingBoolean("newlineOnShiftEnter", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Fallback newline key: ${settingString("newlineFallbackKey", "ctrl+j", ctx.cwd)}`,
		`Image chips: ${settingBoolean("showImageChips", true, ctx.cwd) ? "filled (placeholders and existing image paths)" : "off"}`,
		`Image placeholders/paths in draft: ${labels.length ? labels.join(", ") : "none"}`,
		`Session-name command: ${settingBoolean("enableSessionNameCommand", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Handoff command: ${settingBoolean("enableHandoffCommand", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Handoff prompt review: ${settingBoolean("handoffReviewPrompt", true, ctx.cwd) ? "enabled" : "disabled"}`,
		`Custom compaction: ${settingBoolean("compaction.customEnabled", false, ctx.cwd) ? `enabled (${settingString("compaction.model", DEFAULT_COMPACTION_MODEL, ctx.cwd)}, ${compactionProfile(ctx.cwd)})` : "disabled (Pi default)"}`,
		`Idle compaction: ${settingBoolean("compaction.idleEnabled", false, ctx.cwd) ? `enabled after ${Math.max(1, Math.floor(settingNumber("compaction.idleTimeoutSeconds", DEFAULT_IDLE_COMPACTION_SECONDS, ctx.cwd)))}s idle` : "disabled"}`,
		`Branch summary override: ${settingBoolean("compaction.branchSummaryEnabled", false, ctx.cwd) ? "enabled" : "disabled"}`,
		`Notifications: ${settingBoolean("notification.enabled", true, ctx.cwd) ? `enabled (bell=${settingBoolean("notification.bell", true, ctx.cwd)}, native=${settingBoolean("notification.native", true, ctx.cwd)}, tmuxClientTty=${settingBoolean("notification.tmuxNativeClientTty", true, ctx.cwd)}, tmuxMessage=${settingBoolean("notification.tmux", false, ctx.cwd)})` : "disabled"}`,
		`Permission gate: ${settingBoolean("permissionGate.enabled", true, ctx.cwd) ? `enabled (${permissionGateCommands(ctx.cwd).join(", ") || "none configured"})` : "disabled"}`,
		`Thinking timer: ${settingBoolean("thinkingTimer.enabled", true, ctx.cwd) ? "enabled" : "disabled"}`,
		"If Shift+Enter still submits, configure your terminal/tmux to send a distinct Shift+Enter sequence or use the fallback key.",
	].join("\n");
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
	let thinkingTimerTicker: ReturnType<typeof setInterval> | undefined;
	let questionUnsubscribe: (() => void) | undefined;
	let lastPolledDraft = "";
	let lastTaskStats: { completed: number; remaining: number; total: number } | undefined;

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

	const maybeNotifyTaskCompletion = (ctx: ExtensionContext, state: any) => {
		const stats = taskStats(state);
		if (!stats) return;
		const previous = lastTaskStats;
		lastTaskStats = stats;
		if (stats.total === 0 || stats.remaining !== 0 || stats.completed !== stats.total) return;
		if (previous && previous.total === stats.total && previous.remaining === 0 && previous.completed === stats.completed) return;
		if (previous && previous.remaining <= 0) return;
		sendQolNotification(ctx, "task-complete", `Task list complete: ${stats.completed}/${stats.total} done.`, "info", "task-complete");
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

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		resetThinkingTimer(ctx);
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
		const fallback = settingString("newlineFallbackKey", "ctrl+j", ctx.cwd);
		if (ctx.hasUI && fallback !== "none") {
			ctx.ui.notify(`QOL multiline input active. Shift+Enter inserts newline when your terminal reports it; fallback: ${fallback}.`, "info");
		}
		startQuestionSubscription(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (editorPollTimer) clearInterval(editorPollTimer);
		editorPollTimer = undefined;
		clearIdleCompactionTimer();
		clearQuestionSubscribeTimer();
		resetThinkingTimer(undefined);
		clearTmuxWindowMark();
		questionUnsubscribe?.();
		questionUnsubscribe = undefined;
		currentCtx = undefined;
		const host = globalThis as unknown as Record<PropertyKey, unknown>;
		if (host[QOL_NOTIFICATION_SERVICE_SYMBOL] === notificationService) delete host[QOL_NOTIFICATION_SERVICE_SYMBOL];
		ctx.ui.setStatus(STATUS_KEY, undefined);
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
		if (ctx.hasPendingMessages?.()) return;
		const text = lastAssistantTextFromAgentEnd(event, ctx);
		const critical = criticalInfo(text);
		if (critical) {
			sendQolNotification(ctx, "critical", `Critical: ${critical}`, "error", `critical:${critical.slice(0, 80)}`);
			return;
		}
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
		if (!settingBoolean("permissionGate.enabled", true, ctx.cwd)) return undefined;
		if (event?.toolName !== "bash") return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return undefined;
		const matched = permissionGateMatch(command, ctx.cwd);
		if (!matched) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `Command matched permission gate (${matched}) and no UI is available for confirmation` };
		const choice = await ctx.ui.select(`⚠️ Permission gate matched: ${matched}\n\n${command}\n\nAllow this bash command?`, ["Allow once", "Block"]);
		if (choice !== "Allow once") return { block: true, reason: `Blocked by QOL permission gate (${matched})` };
		return undefined;
	});
	pi.on("tool_result", (event: any, ctx) => {
		if (event?.isError) {
			sendQolNotification(ctx, "critical", `Tool ${event.toolName ?? "unknown"} failed.`, "error", `tool-error:${event.toolName ?? "unknown"}`);
		}
		if (event?.toolName === "todo_write") maybeNotifyTaskCompletion(ctx, event.details?.state);
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
		pi.registerCommand("session-name", {
			description: "Set or show session name (usage: /session-name [new name])",
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
			description: "Transfer context to a new focused session (usage: /handoff <goal>)",
			handler: async (args, ctx) => runHandoff(args, ctx),
		});
	}

	pi.registerCommand("qol", {
		description: "QOL status, notification, and attachment helpers: /qol status, /qol notify-test, /qol attachments, /qol reset.",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase() || "status";
			if (sub === "status") {
				ctx.ui.notify(statusMessage(ctx), "info");
				return;
			}
			if (sub === "attachments") {
				const labels = attachmentLabels(currentEditorText(ctx), ctx.cwd);
				ctx.ui.notify(labels.length ? labels.join("\n") : "No image placeholders or existing image paths in the current draft.", "info");
				return;
			}
			if (sub === "collapse") {
				ctx.ui.notify(collapseEditorImagePaths(ctx) ? "Collapsed image paths in the editor." : "No existing image paths found in the editor.", "info");
				return;
			}
			if (sub === "notify-test") {
				sendQolNotification(ctx, "test", "QOL notification test", "info", `test:${Date.now()}`);
				ctx.ui.notify("Sent QOL notification test.", "info");
				return;
			}
			if (sub === "reset") {
				clearTmuxWindowMark();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Cleared QOL attachment status. Pi-owned pending images are unchanged.", "info");
				return;
			}
			ctx.ui.notify("Unknown /qol action. Try /qol status, /qol notify-test, /qol attachments, /qol collapse, or /qol reset.", "warning");
		},
	});
}
