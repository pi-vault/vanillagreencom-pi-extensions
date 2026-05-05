import { CompactionSummaryMessageComponent, getLanguageFromPath, getMarkdownTheme, highlightCode, keyText, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Loader, Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-tool-renderer.installed");
const USER_MESSAGE_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.user-message-patch");
const USER_MESSAGE_BOX_STATE_SYMBOL = Symbol.for("vstack.pi-tool-renderer.user-message-box-state");
const ASSISTANT_MESSAGE_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.assistant-message-patch");
const CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.custom-message-spacing-patch");
const TOOL_EXECUTION_RENDERER_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.tool-execution-renderer-patch.v2");
const TOOL_CHROME_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.tool-chrome-patch");
const COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.compaction-summary-renderer-patch");
const SKILL_INVOCATION_RENDERER_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.skill-invocation-renderer-patch");
const MARKDOWN_CODE_BLOCK_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.markdown-code-block-patch");
const WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL = Symbol.for("vstack.pi-tool-renderer.working-loader-alignment-patch");

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_FG_RESET = "\x1b[39m";

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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-tool-renderer"];
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
	return typeof value === "string" ? value : fallback;
}

function settingEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, cwd?: string): T {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function ansiRed(text: string): string {
	return `${ANSI_RED}${text}${ANSI_FG_RESET}`;
}

function ansiGreen(text: string): string {
	return `${ANSI_GREEN}${text}${ANSI_FG_RESET}`;
}

function fgParts(theme: any, token: string): { open: string; close: string } {
	const marker = "\uE000";
	try {
		const styled = theme.fg(token, marker);
		const index = styled.indexOf(marker);
		if (index < 0) return { open: "", close: "" };
		return { open: styled.slice(0, index), close: styled.slice(index + marker.length) };
	} catch {
		return { open: "", close: "" };
	}
}

function applyBaseTextFg(line: string, theme: any): string {
	let normalized = line;
	for (const token of ["userMessageText", "text"]) {
		const { open } = fgParts(theme, token);
		if (open) normalized = normalized.split(open).join(ANSI_FG_RESET);
	}
	return `${ANSI_FG_RESET}${normalized.replace(/\x1b\[(?:0|39)m/g, (reset) => `${reset}${ANSI_FG_RESET}`)}${ANSI_FG_RESET}`;
}

function renderUserMessageBorder(lines: string[], width: number, theme: any): string[] {
	if (lines.length === 0 || width < 4) return lines;
	const innerWidth = Math.max(1, width - 2);
	const border = (text: string) => ansiGreen(text);
	const marker = (text: string) => ansiRed(text);
	const topBorder = () => {
		if (innerWidth < 5) return border("━".repeat(innerWidth));
		const left = "━ ";
		const right = ` ${"━".repeat(Math.max(0, innerWidth - visibleWidth(left) - 2))}`;
		return `${border(left)}${marker("π")}${border(right)}`;
	};
	const fitLine = (line: string) => {
		const clipped = truncateToWidth(line, innerWidth, "");
		return applyBaseTextFg(clipped, theme) + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	};

	return [
		`${border("┏")}${topBorder()}${border("┓")}`,
		...lines.map((line) => `${border("┃")}${fitLine(line)}${border("┃")}`),
		`${border("┗")}${border("━".repeat(innerWidth))}${border("┛")}`,
	];
}

function appendUserMessageBreak(lines: string[], width: number, cwd?: string): string[] {
	if (lines.length === 0 || !settingBoolean("userMessageTrailingBlankLine", true, cwd)) return lines;
	return [...lines, " ".repeat(Math.max(0, width))];
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

function textContent(result: any): string {
	const part = result?.content?.find?.((candidate: any) => candidate?.type === "text" && typeof candidate.text === "string");
	return part?.text ?? "";
}

function clipLine(line: string, cwd?: string): string {
	const max = Math.max(40, Math.floor(settingNumber("maxLineWidth", 1000, cwd)));
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function preview(text: string, count: number, direction: "head" | "tail", cwd?: string): string {
	const lines = text.split(/\r?\n/);
	const selected = direction === "head" ? lines.slice(0, count) : lines.slice(-count);
	return selected.map((line) => clipLine(line, cwd)).join("\n");
}

function commandExit(text: string): number | null {
	const match = text.match(/exit code:\s*(\d+)/i) ?? text.match(/exit\s+(\d+)/i);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

function diffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

function truncatedMarker(text: string): boolean {
	return /^\s*\[(?:Output|Full output|Read output|Search output|Bash output)[^\n\]]*truncated|^\s*\[[^\n\]]*Full output saved to:/im.test(text);
}

function resultTruncated(result: any): boolean {
	const details = result?.details;
	if (typeof details?.truncation?.truncated === "boolean") return details.truncation.truncated;
	if (typeof details?.truncated === "boolean") return details.truncated;
	return truncatedMarker(textContent(result));
}

function makeText(text: string): Text {
	return new Text(text, 0, 0);
}

function makeEmpty() {
	return {
		invalidate() {},
		render(): string[] {
			return [];
		},
	};
}

const FALLBACK_THEME = {
	bg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `\x1b[1m${text}\x1b[22m`;
	},
	fg(_token: string, text: string) {
		return text;
	},
};

function componentHasVisibleLines(component: unknown): boolean {
	try {
		const render = (component as any)?.render;
		return typeof render === "function" && render.call(component, 120).length > 0;
	} catch {
		return false;
	}
}

interface UserMessagePatchState {
	activeCtx?: ExtensionContext;
	originalRender: (width: number) => string[];
}

function installUserMessageRenderer(pi: ExtensionAPI, UserMessageComponent: any): void {
	const prototype = UserMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function") return;

	let state = prototype[USER_MESSAGE_PATCH_SYMBOL] as UserMessagePatchState | undefined;
	if (!state) {
		state = {
			originalRender: prototype.render as (width: number) => string[],
		};
		prototype[USER_MESSAGE_PATCH_SYMBOL] = state;
		prototype.render = function compactUserMessageRender(this: any, width: number): string[] {
			const box = this?.contentBox;
			const ctx = state?.activeCtx;
			const cwd = ctx?.cwd ?? process.cwd();
			if (box && ctx?.hasUI) {
				const compact = settingBoolean("compactUserMessages", true, cwd);
				const paddingY = compact ? 0 : 1;
				const boxState = compact ? `${paddingY}:border:ansi-green:text:pi-red:left` : `${paddingY}:background:userMessageBg`;

				if (box[USER_MESSAGE_BOX_STATE_SYMBOL] !== boxState) {
					box.paddingY = paddingY;
					if (compact) {
						box.setBgFn?.(undefined);
					} else {
						box.setBgFn?.((content: string) => {
							const theme = state?.activeCtx?.ui?.theme;
							if (!theme?.bg) return content;
							try {
								return theme.bg("userMessageBg", content);
							} catch {
								return theme.bg("userMessageBg", content);
							}
						});
					}
					box.invalidateCache?.();
					box[USER_MESSAGE_BOX_STATE_SYMBOL] = boxState;
				}

				if (compact && width >= 4) {
					const theme = ctx.ui?.theme ?? FALLBACK_THEME;
					const lines = state!.originalRender.call(this, Math.max(1, width - 2));
					return appendUserMessageBreak(renderUserMessageBorder(lines, width, theme), width, cwd);
				}
			}

			return appendUserMessageBreak(state!.originalRender.call(this, width), width, cwd);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[USER_MESSAGE_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			delete prototype[USER_MESSAGE_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface AssistantMessagePatchState {
	activeCtx?: ExtensionContext;
	originalRender: (width: number) => string[];
	originalUpdateContent: (message: any) => void;
}

function alignAssistantContent(component: any): void {
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		if (child instanceof Markdown || child instanceof Text) {
			child.paddingX = 0;
			child.invalidate?.();
		}
	}
}

function installAssistantMessageRenderer(pi: ExtensionAPI, AssistantMessageComponent: any): void {
	const prototype = AssistantMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function" || typeof prototype.updateContent !== "function") return;

	let state = prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] as AssistantMessagePatchState | undefined;
	if (!state) {
		state = {
			originalRender: prototype.render as (width: number) => string[],
			originalUpdateContent: prototype.updateContent as (message: any) => void,
		};
		prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] = state;
		prototype.render = function spacedAssistantRender(this: any, width: number): string[] {
			const rendered = state!.originalRender.call(this, width);
			if (!Array.isArray(rendered) || rendered.length === 0 || this?.hasToolCalls) return rendered;
			const end = trimTrailingBlankLines(rendered);
			if (end.length === 0) return rendered;
			return [...end, " ".repeat(Math.max(0, width))];
		};
		prototype.updateContent = function alignedAssistantUpdateContent(this: any, message: any): void {
			state!.originalUpdateContent.call(this, message);
			const cwd = state?.activeCtx?.cwd ?? process.cwd();
			if (settingBoolean("alignAssistantMessages", true, cwd)) alignAssistantContent(this);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			prototype.updateContent = state!.originalUpdateContent as unknown;
			delete prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface CompactionSummaryPatchState {
	activeCtx?: ExtensionContext;
	originalUpdateDisplay: () => void;
}

function installCompactionSummaryRenderer(pi: ExtensionAPI, Component: any): void {
	const prototype = Component?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.updateDisplay !== "function") return;

	let state = prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] as CompactionSummaryPatchState | undefined;
	if (!state) {
		state = {
			originalUpdateDisplay: prototype.updateDisplay as () => void,
		};
		prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] = state;
		prototype.updateDisplay = function compactCompactionSummaryDisplay(this: any): void {
			const ctx = state?.activeCtx;
			const cwd = ctx?.cwd ?? process.cwd();
			if (!settingBoolean("compactCompactionMessages", true, cwd)) {
				state!.originalUpdateDisplay.call(this);
				return;
			}

			const theme = ctx?.ui?.theme ?? FALLBACK_THEME;
			const message = this?.message ?? {};
			const tokensBefore = Number.isFinite(Number(message.tokensBefore)) ? Number(message.tokensBefore) : 0;
			const tokenStr = tokensBefore.toLocaleString();
			const expanded = Boolean(this?.expanded);
			const summary = typeof message.summary === "string" && message.summary.trim() ? message.summary.trim() : "No summary was recorded.";

			this.paddingX = 0;
			this.paddingY = 0;
			this.setBgFn?.(undefined);
			this.clear?.();

			const hint = expanded ? "" : theme.fg("dim", " · Ctrl+O to expand");
			this.addChild?.(new Text(`${stackPrefix(theme)}${toolLabel(theme, "Compacted ")}${theme.fg("success", `${tokenStr} tokens`)}${hint}`, 0, 0));

			if (expanded) {
				this.addChild?.(new Text(`${treeConnector(theme, "└", cwd)}${theme.fg("muted", "Summary")}`, 0, 0));
				this.addChild?.(new Markdown(summary, 0, 0, this?.markdownTheme ?? getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}));
			}
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] === state) {
			prototype.updateDisplay = state!.originalUpdateDisplay as unknown;
			delete prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface SkillInvocationPatchState {
	activeCtx?: ExtensionContext;
	originalUpdateDisplay: () => void;
}

interface CustomMessageSpacingPatchState {
	originalRender: (width: number) => string[];
}

function installCustomMessageSpacingPatch(pi: ExtensionAPI, CustomMessageComponent: any): void {
	const prototype = CustomMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function") return;

	let state = prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] as CustomMessageSpacingPatchState | undefined;
	if (!state) {
		state = { originalRender: prototype.render as (width: number) => string[] };
		prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] = state;
		prototype.render = function compactRuledCustomMessageRender(this: any, width: number): string[] {
			const rendered = state!.originalRender.call(this, width);
			if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
			return trimOuterBlankLinesAroundRules(rendered);
		};
	}

	pi.on("session_shutdown", () => {
		if (prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			delete prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL];
		}
	});
}

function installSkillInvocationRenderer(pi: ExtensionAPI, Component: any): void {
	const prototype = Component?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.updateDisplay !== "function") return;

	let state = prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] as SkillInvocationPatchState | undefined;
	if (!state) {
		state = {
			originalUpdateDisplay: prototype.updateDisplay as () => void,
		};
		prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] = state;
		prototype.updateDisplay = function compactSkillInvocationDisplay(this: any): void {
			const ctx = state?.activeCtx;
			const cwd = ctx?.cwd ?? process.cwd();
			if (!settingBoolean("compactSkillMessages", true, cwd)) {
				state!.originalUpdateDisplay.call(this);
				return;
			}

			const th = ctx?.ui?.theme ?? FALLBACK_THEME;
			const skillBlock = this?.skillBlock ?? {};
			const name = typeof skillBlock.name === "string" && skillBlock.name.trim() ? skillBlock.name.trim() : "skill";
			const content = typeof skillBlock.content === "string" ? skillBlock.content : "";
			const expanded = Boolean(this?.expanded);

			this.paddingX = 0;
			this.paddingY = 0;
			this.setBgFn?.(undefined);
			this.clear?.();

			const hint = expanded ? "" : th.fg("dim", ` · ${keyText("app.tools.expand")} expand`);
			this.addChild?.(new Text(`${stackPrefix(th)}${toolLabel(th, "Skill ")}${th.fg("accent", name)}${hint}`, 0, 0));

			if (expanded) {
				this.addChild?.(new Text(`${treeConnector(th, "└", cwd)}${th.fg("muted", "Content")}`, 0, 0));
				this.addChild?.(new Markdown(`**${name}**\n\n${content}`, 0, 0, this?.markdownTheme ?? getMarkdownTheme(), {
					color: (text: string) => th.fg("customMessageText", text),
				}));
			}
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] === state) {
			prototype.updateDisplay = state!.originalUpdateDisplay as unknown;
			delete prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface MarkdownCodeBlockPatchState {
	activeCtx?: ExtensionContext;
	originalRenderToken: (token: any, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
}

function ansiPartsFromStyled(styled: string): { open: string; close: string } {
	const marker = "\uE000";
	const markerIndex = styled.indexOf(marker);
	if (markerIndex < 0) return { open: "", close: "" };
	return { open: styled.slice(0, markerIndex), close: styled.slice(markerIndex + marker.length) };
}

function codeBlockBgParts(ctx?: ExtensionContext): { open: string; close: string } {
	const marker = "\uE000";
	try {
		const theme = ctx?.hasUI ? ctx.ui.theme : undefined;
		if (theme?.bg) return ansiPartsFromStyled(theme.bg("customMessageBg", marker));
	} catch {
		// Fall through to a neutral dark background.
	}
	return { open: "\x1b[48;5;236m", close: "\x1b[49m" };
}

function applyCodeBlockBg(line: string, ctx?: ExtensionContext): string {
	const { open, close } = codeBlockBgParts(ctx);
	if (!open) return line;
	const reapplied = line.replace(/\x1b\[(?:0|49)m/g, (reset) => `${reset}${open}`);
	return `${open}${reapplied}${close}`;
}

function padAnsiLine(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function renderStyledCodeBlock(token: any, width: number, markdownTheme: any, ctx?: ExtensionContext): string[] {
	const contentWidth = Math.max(1, width);
	const rawLang = typeof token?.lang === "string" ? token.lang.trim() : "";
	const lang = rawLang.split(/\s+/)[0] || undefined;
	const code = typeof token?.text === "string" ? token.text : "";

	if (contentWidth < 8) {
		return code.split("\n").map((line) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	}

	const blockIndent = "  ";
	const panelWidth = Math.max(1, contentWidth - visibleWidth(blockIndent));

	let highlightedLines: string[];
	try {
		highlightedLines = markdownTheme?.highlightCode ? markdownTheme.highlightCode(code, lang) : code.split("\n").map((line: string) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	} catch {
		highlightedLines = code.split("\n").map((line: string) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	}

	const strip = markdownTheme?.codeBlockBorder ? markdownTheme.codeBlockBorder("▌") : "▌";
	const stripWidth = Math.max(1, visibleWidth(strip));
	const bodyWidth = Math.max(1, panelWidth - stripWidth);
	const codeWidth = Math.max(1, bodyWidth - 2);
	const lines: string[] = [];
	const blankBody = applyCodeBlockBg(" ".repeat(bodyWidth), ctx);
	lines.push(`${blockIndent}${strip}${blankBody}`);
	for (const highlightedLine of highlightedLines) {
		const wrapped = wrapTextWithAnsi(highlightedLine, codeWidth);
		const segments = wrapped.length > 0 ? wrapped : [""];
		for (const segment of segments) {
			const paddedCode = padAnsiLine(segment, codeWidth);
			lines.push(`${blockIndent}${strip}${applyCodeBlockBg(` ${paddedCode} `, ctx)}`);
		}
	}
	lines.push(`${blockIndent}${strip}${blankBody}`);
	return lines;
}

function installMarkdownCodeBlockRenderer(pi: ExtensionAPI): void {
	const prototype = Markdown?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.renderToken !== "function") return;

	let state = prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] as MarkdownCodeBlockPatchState | undefined;
	if (!state) {
		state = {
			originalRenderToken: prototype.renderToken as MarkdownCodeBlockPatchState["originalRenderToken"],
		};
		prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] = state;
		prototype.renderToken = function styledCodeBlockRenderToken(this: any, token: any, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
			if (token?.type === "code" && settingBoolean("styledCodeBlocks", true, state?.activeCtx?.cwd)) {
				const codeLines = renderStyledCodeBlock(token, width, this?.theme, state?.activeCtx);
				if (nextTokenType && nextTokenType !== "space") return [...codeLines, ""];
				return codeLines;
			}
			return state!.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] === state) {
			prototype.renderToken = state!.originalRenderToken as unknown;
			delete prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

class TruncatedLines {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly lines: string[];

	constructor(text: string) {
		this.lines = text ? text.split(/\r?\n/) : [];
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const targetWidth = Math.max(1, width);
		const lines = this.lines.map((line) => truncateToWidth(line, targetWidth));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

function makeTruncatedLines(text: string): TruncatedLines {
	return new TruncatedLines(text);
}

function stackToolCalls(cwd?: string): boolean {
	return settingBoolean("stackToolCalls", false, cwd);
}

type StackChildDisplay = "rows" | "headline" | "anchor-list";

function stackChildDisplay(cwd?: string): StackChildDisplay {
	const value = readVstackConfig(cwd).stackChildDisplay;
	if (value === "rows" || value === "headline" || value === "anchor-list") return value;
	return settingBoolean("hideStackChildRows", false, cwd) ? "headline" : "rows";
}

function stackShell(cwd?: string): { renderShell?: "self" } {
	return stackToolCalls(cwd) ? { renderShell: "self" } : {};
}

type ReadOutputMode = "hidden" | "summary" | "preview";
type SearchOutputMode = "hidden" | "count" | "preview";
type BashOutputMode = "hidden" | "summary" | "opencode" | "preview";
type McpOutputMode = "hidden" | "summary" | "preview";

function readOutputMode(cwd?: string): ReadOutputMode {
	return settingEnum("readOutputMode", ["hidden", "summary", "preview"] as const, "preview", cwd);
}

function searchOutputMode(cwd?: string): SearchOutputMode {
	return settingEnum("searchOutputMode", ["hidden", "count", "preview"] as const, "preview", cwd);
}

function bashOutputMode(cwd?: string): BashOutputMode {
	return settingEnum("bashOutputMode", ["hidden", "summary", "opencode", "preview"] as const, "opencode", cwd);
}

function mcpOutputMode(cwd?: string): McpOutputMode {
	return settingEnum("mcpOutputMode", ["hidden", "summary", "preview"] as const, "preview", cwd);
}

function stackPrefix(theme: any): string {
	return theme.fg("accent", "● ");
}

function toolRule(theme: any, text: string): string {
	try {
		return theme.fg("muted", text);
	} catch {
		return text;
	}
}

function borderMuted(theme: any, text: string): string {
	try {
		return theme.fg("borderMuted", text);
	} catch {
		return toolRule(theme, text);
	}
}

type TreeBranch = "├" | "└" | "│";

function treeStyle(cwd?: string): "unicode" | "ascii" {
	return settingEnum("treeStyle", ["unicode", "ascii"] as const, "unicode", cwd);
}

function treeGlyph(branch: TreeBranch, cwd?: string): string {
	if (treeStyle(cwd) === "ascii") {
		if (branch === "│") return "|  ";
		return branch === "└" ? "`-- " : "|-- ";
	}
	if (branch === "│") return "  │ ";
	return `  ${branch}─ `;
}

function treeConnector(theme: any, branch: TreeBranch = "├", cwd?: string): string {
	return toolRule(theme, treeGlyph(branch, cwd));
}

function treeStem(theme: any, branch: TreeBranch, cwd?: string): string {
	if (branch === "└") return theme.fg("muted", treeStyle(cwd) === "ascii" ? "    " : "     ");
	return treeConnector(theme, "│", cwd);
}

function toolLabel(theme: any, label: string): string {
	return theme.fg("text", theme.bold(label));
}

function readCallText(args: any, theme: any): string {
	const range = args?.offset || args?.limit ? `:${args.offset ?? 1}${args.limit ? `-${Number(args.offset ?? 1) + Number(args.limit) - 1}` : ""}` : "";
	return `${toolLabel(theme, "Read ")}${theme.fg("accent", `${args?.path ?? ""}${range}`)}`;
}

function bashCallText(args: any, theme: any, cwd?: string): string {
	const max = Math.max(20, Math.floor(settingNumber("commandPreviewChars", 96, cwd)));
	const rawCommand = typeof args?.command === "string" ? args.command : "";
	const command = rawCommand.length > max ? `${rawCommand.slice(0, max - 1)}…` : rawCommand;
	const commandLines = command.split(/\r?\n/);
	const [firstLine = "", ...continuationLines] = commandLines;
	const styledFirstLine = theme.fg("accent", firstLine);
	const styledContinuation = continuationLines.map((line) => theme.fg("accent", line)).join("\n");
	return `${toolLabel(theme, "Bash $ ")}${styledFirstLine}${styledContinuation ? `\n${styledContinuation}` : ""}`;
}

function isGitDiffCommand(command: unknown): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	const normalized = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
	// Match common shell forms such as `git diff`, `git --no-pager diff`,
	// `git -C repo diff`, `env GIT_PAGER=cat git diff`, and chained commands.
	return /(?:^|[;&|()]\s*)(?:(?:env\s+(?:-\S+\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)|(?:command\s+))*git(?:\s+(?!--?diff\b)(?:-[A-Za-z]\S*|--\S+)(?:\s+(?!diff(?:\s|$))\S+)*)*\s+diff(?:\s|$)/.test(normalized);
}

function readOnlyCallText(toolName: string, args: any, theme: any, cwd?: string): string {
	const query = args?.pattern ?? args?.glob ?? args?.path ?? args?.query ?? "";
	return `${toolLabel(theme, `${toolName} `)}${theme.fg("accent", clipLine(String(query), cwd))}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_PRESENT_RE = /\x1b\[[0-9;]*m/;
const DIFF_SPLIT_MIN_WIDTH = 132;
const DIFF_SPLIT_MIN_CODE_WIDTH = 24;
const DIFF_SPLIT_MAX_WRAP_LINES = 8;
const DIFF_SPLIT_MAX_WRAP_RATIO = 0.55;
const DIFF_LCS_CELL_LIMIT = 250_000;
const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_INPUT_BYTES = 700 * 1024;
const DIFF_HIGHLIGHT_MAX_CHARS = 180_000;
const DIFF_ADD_BG_TOKEN = "toolSuccessBg";
const DIFF_DEL_BG_TOKEN = "toolErrorBg";
const DIFF_WORD_BG_TOKEN = "selectedBg";
const WORD_DIFF_CELL_LIMIT = 32_000;
const WORD_DIFF_MIN_SIMILARITY = 0.2;

type DiffKind = "ctx" | "add" | "del" | "sep";
interface StructuredDiffLine {
	content: string;
	hunk?: number;
	newNum: number | null;
	oldNum: number | null;
	type: DiffKind;
}
interface StructuredDiff {
	additions: number;
	chars: number;
	hunks?: number;
	lines: StructuredDiffLine[];
	path?: string;
	removals: number;
}

interface BlinkEntry {
	invalidate: () => void;
}

const blinkEntries = new Map<unknown, BlinkEntry>();
let blinkTimer: ReturnType<typeof setInterval> | undefined;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function isBlankRenderLine(line: string | undefined): boolean {
	return stripAnsi(line ?? "").trim().length === 0;
}

function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length - 1;
	while (end >= 0 && isBlankRenderLine(lines[end])) end--;
	return end < 0 ? [] : lines.slice(0, end + 1);
}

function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankRenderLine(lines[start])) start++;
	let end = lines.length - 1;
	while (end >= start && isBlankRenderLine(lines[end])) end--;
	return start > end ? [] : lines.slice(start, end + 1);
}

function isHorizontalRuleLine(line: string | undefined): boolean {
	const stripped = stripAnsi(line ?? "").trim();
	return stripped.length > 0 && /^[─━-]+$/.test(stripped);
}

function trimOuterBlankLinesAroundRules(lines: string[]): string[] {
	const trimmed = trimOuterBlankLines(lines);
	if (trimmed.length < 3) return lines;
	return isHorizontalRuleLine(trimmed[0]) && isHorizontalRuleLine(trimmed[trimmed.length - 1]) ? trimmed : lines;
}

function visibleLength(text: string): number {
	return visibleWidth(text);
}

function diffDisplayContent(content: string): string {
	return content.replace(/\t/g, "  ");
}

function hasAnsi(text: string): boolean {
	return ANSI_PRESENT_RE.test(text);
}

function languageForPath(path?: string): string | undefined {
	if (!path) return undefined;
	try {
		return getLanguageFromPath(path) as string | undefined;
	} catch {
		return undefined;
	}
}

function highlightDiffContent(content: string, path: string | undefined, theme: any, cwd?: string): string {
	const display = diffDisplayContent(content);
	if (!display || !settingBoolean("shikiDiffs", true, cwd)) return display;
	if (display.length > 5000) return display;
	const language = languageForPath(path);
	if (!language) return display;
	try {
		const highlighted = highlightCode(display, language);
		const lines = Array.isArray(highlighted) ? highlighted : String(highlighted).replace(/\r\n/g, "\n").split("\n");
		return lines[0] ?? display;
	} catch {
		return display;
	}
}

function padVisible(text: string, width: number): string {
	const missing = width - visibleLength(text);
	return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

function terminalWidth(): number {
	const raw = Number(process.stdout.columns || (process.stderr as any).columns || process.env.COLUMNS || 120);
	return Math.max(60, raw);
}

function truncateAnsi(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "");
}

interface WordToken {
	end: number;
	start: number;
	text: string;
}

interface WordDiffRanges {
	newRanges: Array<[number, number]>;
	oldRanges: Array<[number, number]>;
	similarity: number;
}

function wordTokens(text: string): WordToken[] {
	const tokens: WordToken[] = [];
	const re = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) tokens.push({ end: re.lastIndex, start: match.index, text: match[0] });
	return tokens;
}

function changedRanges(tokens: WordToken[], common: boolean[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let start: number | null = null;
	let end = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!common[i] && token.text.trim().length > 0) {
			if (start === null) start = token.start;
			end = token.end;
		} else if (start !== null) {
			ranges.push([start, end]);
			start = null;
		}
	}
	if (start !== null) ranges.push([start, end]);
	return ranges;
}

function wordDiffRanges(oldText: string, newText: string): WordDiffRanges {
	const oldTokens = wordTokens(oldText);
	const newTokens = wordTokens(newText);
	if (oldTokens.length === 0 && newTokens.length === 0) return { newRanges: [], oldRanges: [], similarity: 1 };
	if (oldTokens.length * newTokens.length > WORD_DIFF_CELL_LIMIT) return { newRanges: [], oldRanges: [], similarity: 0 };
	const width = newTokens.length + 1;
	const table = new Uint16Array((oldTokens.length + 1) * (newTokens.length + 1));
	for (let i = oldTokens.length - 1; i >= 0; i--) {
		for (let j = newTokens.length - 1; j >= 0; j--) {
			table[i * width + j] = oldTokens[i]!.text === newTokens[j]!.text
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const oldCommon = new Array(oldTokens.length).fill(false);
	const newCommon = new Array(newTokens.length).fill(false);
	let i = 0;
	let j = 0;
	let commonChars = 0;
	while (i < oldTokens.length && j < newTokens.length) {
		if (oldTokens[i]!.text === newTokens[j]!.text) {
			oldCommon[i] = true;
			newCommon[j] = true;
			commonChars += oldTokens[i]!.text.length;
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	const maxChars = Math.max(oldText.length, newText.length, 1);
	return {
		newRanges: changedRanges(newTokens, newCommon),
		oldRanges: changedRanges(oldTokens, oldCommon),
		similarity: commonChars / maxChars,
	};
}

function styleRanges(text: string, ranges: Array<[number, number]>, baseStyle: (value: string) => string, highlightStyle: (value: string) => string): string {
	if (ranges.length === 0 || hasAnsi(text)) return baseStyle(text);
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	let out = "";
	let offset = 0;
	for (const [start, end] of sorted) {
		if (end <= offset || start >= text.length) continue;
		const safeStart = Math.max(offset, start);
		const safeEnd = Math.min(text.length, end);
		if (safeStart > offset) out += baseStyle(text.slice(offset, safeStart));
		out += highlightStyle(text.slice(safeStart, safeEnd));
		offset = safeEnd;
	}
	if (offset < text.length) out += baseStyle(text.slice(offset));
	return out;
}

function updateActiveAnsiStyle(code: string): string {
	const match = code.match(/^\x1b\[([0-9;]*)m$/);
	if (!match) return "";
	const params = match[1] ? match[1].split(";").map((value) => Number.parseInt(value || "0", 10)) : [0];
	if (params.some((value) => value === 0 || value === 39)) return "";
	return code;
}

function diffBackgroundEnabled(cwd?: string): boolean {
	return settingBoolean("diffBackgrounds", true, cwd);
}

function maybeBg(theme: any, token: string, text: string, enabled: boolean): string {
	return enabled ? theme.bg(token, text) : text;
}

function styleAnsiVisibleRanges(
	text: string,
	ranges: Array<[number, number]>,
	theme: any,
	fgToken: string,
	baseBgToken: string,
	highlightBgToken: string,
	useBackground = false,
): string {
	if (!hasAnsi(text)) {
		const base = (value: string) => maybeBg(theme, baseBgToken, theme.fg(fgToken, value), useBackground);
		const highlight = (value: string) => maybeBg(theme, highlightBgToken, theme.fg(fgToken, value), useBackground);
		return styleRanges(text, ranges, base, highlight);
	}

	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	let rangeIndex = 0;
	let visibleIndex = 0;
	let activeStyle = "";
	let out = "";
	const ansiRe = /\x1b\[[0-9;]*m/g;

	function inHighlightRange(index: number): boolean {
		while (rangeIndex < sorted.length && index >= sorted[rangeIndex]![1]) rangeIndex++;
		const range = sorted[rangeIndex];
		return Boolean(range && index >= range[0] && index < range[1]);
	}

	function emitChunk(chunk: string, highlighted: boolean): void {
		if (!chunk) return;
		const bgToken = highlighted ? highlightBgToken : baseBgToken;
		const content = activeStyle ? chunk : theme.fg(fgToken, chunk);
		out += maybeBg(theme, bgToken, content, useBackground);
		if (activeStyle) out += activeStyle;
	}

	function emitPlain(plain: string): void {
		let chunk = "";
		let highlighted: boolean | undefined;
		for (let index = 0; index < plain.length; index++) {
			const nextHighlighted = inHighlightRange(visibleIndex);
			if (highlighted !== undefined && nextHighlighted !== highlighted) {
				emitChunk(chunk, highlighted);
				chunk = "";
			}
			highlighted = nextHighlighted;
			chunk += plain[index]!;
			visibleIndex++;
		}
		if (highlighted !== undefined) emitChunk(chunk, highlighted);
	}

	let offset = 0;
	let match: RegExpExecArray | null;
	while ((match = ansiRe.exec(text))) {
		emitPlain(text.slice(offset, match.index));
		out += match[0];
		activeStyle = updateActiveAnsiStyle(match[0]);
		offset = match.index + match[0].length;
	}
	emitPlain(text.slice(offset));
	return out;
}

function blinkKey(context: any): unknown {
	return context?.toolCallId ?? context?.id ?? context;
}

function startBlinkTimer(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(() => {
		for (const entry of blinkEntries.values()) {
			try {
				entry.invalidate();
			} catch {
				// Rendering invalidation is best-effort only.
			}
		}
		if (blinkEntries.size === 0 && blinkTimer) {
			clearInterval(blinkTimer);
			blinkTimer = undefined;
		}
	}, 450);
	blinkTimer.unref?.();
}

function trackBlink(context: any): void {
	const key = blinkKey(context);
	if (!key || typeof context?.invalidate !== "function") return;
	blinkEntries.set(key, { invalidate: () => context.invalidate() });
	startBlinkTimer();
}

function clearBlink(context: any): void {
	const key = blinkKey(context);
	if (key) blinkEntries.delete(key);
	if (blinkEntries.size === 0 && blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = undefined;
	}
}

function blinkingPrefix(theme: any, context: any): string {
	trackBlink(context);
	const on = Math.floor(Date.now() / 450) % 2 === 0;
	return theme.fg(on ? "success" : "muted", on ? "● " : "○ ");
}

function renderPendingCall(call: string, theme: any, context: any, cwd?: string): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (!context?.executionStarted || !context?.isPartial || stackToolCalls(context?.cwd ?? cwd)) return makeEmpty();
	return makeTruncatedLines(`${blinkingPrefix(theme, context)}${call}`);
}

function renderPendingDetail(text: string, theme: any): TruncatedLines {
	return makeTruncatedLines(`${treeConnector(theme, "└")}${theme.fg("warning", text)}`);
}

const NF_DIR = "";
const NF_FILE = "";
const ICON_BY_NAME: Record<string, string> = {
	"dockerfile": "",
	"license": "",
	"makefile": "",
	"package.json": "",
	"readme.md": "󰂺",
	"tsconfig.json": "",
};
const ICON_BY_EXT: Record<string, string> = {
	bash: "",
	c: "",
	cpp: "",
	css: "",
	gif: "",
	go: "",
	graphql: "󰡷",
	html: "",
	java: "",
	jpg: "",
	jpeg: "",
	js: "",
	json: "",
	jsx: "",
	lock: "",
	lua: "",
	md: "󰍔",
	png: "",
	py: "",
	rb: "",
	rs: "",
	scss: "",
	sh: "",
	sql: "",
	svg: "󰜡",
	svelte: "",
	toml: "",
	ts: "",
	tsx: "",
	vue: "",
	xml: "󰗀",
	yaml: "",
	yml: "",
	zsh: "",
};

function nerdIcon(pathText: string, isDirectory = false, theme?: any): string {
	if (isDirectory) return theme?.fg ? theme.fg("accent", NF_DIR) : NF_DIR;
	const clean = stripAnsi(pathText).trim().replace(/\/$/, "");
	const name = basename(clean).toLowerCase();
	const icon = ICON_BY_NAME[name] ?? ICON_BY_EXT[extname(name).replace(/^\./, "").toLowerCase()] ?? NF_FILE;
	const token = icon === NF_FILE ? "muted" : "accent";
	return theme?.fg ? theme.fg(token, icon) : icon;
}

function renderPathListPreview(output: string, toolName: "find" | "ls", theme: any, expanded: boolean, cwd?: string): string {
	const rawItems = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (rawItems.length === 0) return theme.fg("muted", toolName === "ls" ? "empty directory" : "no files found");
	const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, cwd)));
	const shown = rawItems.slice(0, expanded ? limit : Math.min(limit, 12));
	const lines = shown.map((item, index) => {
		const clean = stripAnsi(item).trim();
		const isDir = clean.endsWith("/");
		const branch = index === shown.length - 1 && shown.length === rawItems.length ? "└" : "├";
		const icon = nerdIcon(clean, isDir, theme);
		const label = isDir ? theme.fg("accent", theme.bold(clean)) : theme.fg("dim", clean);
		return `${treeConnector(theme, branch as "├" | "└", cwd)}${icon} ${label}`;
	});
	const remaining = rawItems.length - shown.length;
	if (remaining > 0) {
		const noun = toolName === "ls" ? (remaining === 1 ? "entry" : "entries") : `file${remaining === 1 ? "" : "s"}`;
		lines.push(`${treeConnector(theme, "└", cwd)}${theme.fg("muted", `… ${remaining} more ${noun}`)}`);
	}
	return lines.join("\n");
}

function splitContentLines(text: string): string[] {
	if (!text) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function diffOps(oldLines: string[], newLines: string[]): Array<{ text: string; type: "ctx" | "add" | "del" }> {
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}
	const ops: Array<{ text: string; type: "ctx" | "add" | "del" }> = [];
	for (let i = 0; i < start; i++) ops.push({ text: oldLines[i] ?? "", type: "ctx" });
	const oldMid = oldLines.slice(start, oldEnd + 1);
	const newMid = newLines.slice(start, newEnd + 1);
	if (oldMid.length * newMid.length > DIFF_LCS_CELL_LIMIT) {
		for (const text of oldMid) ops.push({ text, type: "del" });
		for (const text of newMid) ops.push({ text, type: "add" });
	} else {
		const m = oldMid.length;
		const n = newMid.length;
		const width = n + 1;
		const table = new Uint32Array((m + 1) * (n + 1));
		for (let i = m - 1; i >= 0; i--) {
			for (let j = n - 1; j >= 0; j--) {
				table[i * width + j] = oldMid[i] === newMid[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (oldMid[i] === newMid[j]) {
				ops.push({ text: oldMid[i] ?? "", type: "ctx" });
				i++;
				j++;
			} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
				ops.push({ text: oldMid[i] ?? "", type: "del" });
				i++;
			} else {
				ops.push({ text: newMid[j] ?? "", type: "add" });
				j++;
			}
		}
		while (i < m) ops.push({ text: oldMid[i++] ?? "", type: "del" });
		while (j < n) ops.push({ text: newMid[j++] ?? "", type: "add" });
	}
	for (let i = oldEnd + 1; i < oldLines.length; i++) ops.push({ text: oldLines[i] ?? "", type: "ctx" });
	return ops;
}

function hiddenDiffLine(count: number): StructuredDiffLine {
	return {
		content: count > 0 ? `… ${count} unchanged line${count === 1 ? "" : "s"} …` : "…",
		newNum: null,
		oldNum: null,
		type: "sep",
	};
}

function assignHunkNumbers(lines: StructuredDiffLine[]): { hunks: number; lines: StructuredDiffLine[] } {
	let hunk = 0;
	let inHunk = false;
	const numbered = lines.map((line) => {
		if (line.type === "sep") {
			inHunk = false;
			return { ...line, hunk: undefined };
		}
		if (line.type === "add" || line.type === "del") {
			if (!inHunk) {
				hunk++;
				inHunk = true;
			}
			return { ...line, hunk };
		}
		return inHunk ? { ...line, hunk } : line;
	});
	return { hunks: hunk, lines: numbered };
}

function countStructuredHunks(lines: StructuredDiffLine[]): number {
	const assigned = assignHunkNumbers(lines);
	return assigned.hunks;
}

function hiddenHunksAfter(allRows: StructuredDiffLine[], shownRows: StructuredDiffLine[]): number {
	const shown = new Set(shownRows.map((line) => line.hunk).filter((hunk): hunk is number => typeof hunk === "number"));
	const hidden = new Set(allRows.slice(shownRows.length).map((line) => line.hunk).filter((hunk): hunk is number => typeof hunk === "number"));
	let count = 0;
	for (const hunk of hidden) if (!shown.has(hunk)) count++;
	return count;
}

function compactStructuredDiffLines(lines: StructuredDiffLine[], contextLines = DIFF_CONTEXT_LINES): StructuredDiffLine[] {
	const changed = lines
		.map((line, index) => (line.type === "add" || line.type === "del" ? index : -1))
		.filter((index) => index >= 0);
	if (changed.length === 0) return lines;

	const ranges: Array<{ end: number; start: number }> = [];
	for (const index of changed) {
		const start = Math.max(0, index - contextLines);
		const end = Math.min(lines.length - 1, index + contextLines);
		const previous = ranges[ranges.length - 1];
		if (!previous || start > previous.end + 1) ranges.push({ start, end });
		else previous.end = Math.max(previous.end, end);
	}

	const compacted: StructuredDiffLine[] = [];
	let previousEnd = -1;
	for (const range of ranges) {
		const hidden = range.start - previousEnd - 1;
		if (hidden > 0) compacted.push(hiddenDiffLine(hidden));
		compacted.push(...lines.slice(range.start, range.end + 1));
		previousEnd = range.end;
	}
	const trailingHidden = lines.length - previousEnd - 1;
	if (trailingHidden > 0) compacted.push(hiddenDiffLine(trailingHidden));
	return compacted;
}

function buildStructuredDiff(oldText: string, newText: string): StructuredDiff {
	const ops = diffOps(splitContentLines(oldText), splitContentLines(newText));
	let oldNum = 1;
	let newNum = 1;
	let additions = 0;
	let removals = 0;
	const lines: StructuredDiffLine[] = [];
	for (const op of ops) {
		if (op.type === "ctx") {
			lines.push({ content: op.text, newNum, oldNum, type: "ctx" });
			oldNum++;
			newNum++;
		} else if (op.type === "del") {
			lines.push({ content: op.text, newNum: null, oldNum, type: "del" });
			oldNum++;
			removals++;
		} else {
			lines.push({ content: op.text, newNum, oldNum: null, type: "add" });
			newNum++;
			additions++;
		}
	}
	const numbered = assignHunkNumbers(compactStructuredDiffLines(lines));
	return { additions, chars: oldText.length + newText.length, hunks: numbered.hunks, lines: numbered.lines, removals };
}

function diffStatBar(additions: number, removals: number, theme: any): string {
	const total = additions + removals;
	if (total <= 0) return "";
	const slots = Math.max(6, Math.min(18, Math.ceil(total / 3)));
	let addSlots = Math.round((additions / total) * slots);
	if (additions > 0 && addSlots === 0) addSlots = 1;
	if (removals > 0 && addSlots === slots) addSlots = slots - 1;
	const delSlots = slots - addSlots;
	return `${theme.fg("dim", "[")}${theme.fg("toolDiffAdded", "━".repeat(addSlots))}${theme.fg("toolDiffRemoved", "━".repeat(delSlots))}${theme.fg("dim", "]")}`;
}

function diffSummary(diff: StructuredDiff, theme: any, cwd?: string): string {
	const parts: string[] = [];
	if (diff.additions > 0) parts.push(theme.fg("success", `+${diff.additions}`));
	if (diff.removals > 0) parts.push(theme.fg("error", `-${diff.removals}`));
	if (parts.length === 0) return theme.fg("muted", "no changes");
	const bar = diffStatBar(diff.additions, diff.removals, theme);
	const hunks = diff.hunks ?? countStructuredHunks(diff.lines);
	let summary = `${parts.join(" ")}${bar ? ` ${bar}` : ""}`;
	if (settingBoolean("showDiffHunkMeta", true, cwd) && hunks > 0) summary += theme.fg("dim", ` · ${hunks} hunk${hunks === 1 ? "" : "s"}`);
	return summary;
}

function colorDiffText(line: StructuredDiffLine, text: string, theme: any, ranges: Array<[number, number]> = [], cwd?: string): string {
	if (line.type === "sep") return theme.fg("dim", text);
	if (line.type === "ctx") return hasAnsi(text) ? text : theme.fg("toolDiffContext", text);

	const fgToken = line.type === "add" ? "toolDiffAdded" : "toolDiffRemoved";
	const bgToken = line.type === "add" ? DIFF_ADD_BG_TOKEN : DIFF_DEL_BG_TOKEN;
	return styleAnsiVisibleRanges(text, ranges, theme, fgToken, bgToken, DIFF_WORD_BG_TOKEN, diffBackgroundEnabled(cwd));
}

function formatNum(value: number | null, width: number): string {
	return value === null ? " ".repeat(width) : `${" ".repeat(Math.max(0, width - String(value).length))}${value}`;
}

function lineWordRanges(line: StructuredDiffLine, mate: StructuredDiffLine | null, cwd?: string): Array<[number, number]> {
	if (!mate || !settingBoolean("wordDiffHighlights", true, cwd)) return [];
	if (!((line.type === "del" && mate.type === "add") || (line.type === "add" && mate.type === "del"))) return [];
	const oldText = diffDisplayContent(line.type === "del" ? line.content : mate.content);
	const newText = diffDisplayContent(line.type === "add" ? line.content : mate.content);
	const ranges = wordDiffRanges(oldText, newText);
	if (ranges.similarity < WORD_DIFF_MIN_SIMILARITY) return [];
	return line.type === "del" ? ranges.oldRanges : ranges.newRanges;
}

function highlightedLineBody(line: StructuredDiffLine, theme: any, path: string | undefined, cwd?: string): string {
	if (line.type === "sep") return line.content || " ";
	return highlightDiffContent(line.content, path, theme, cwd) || " ";
}

function renderUnifiedLine(
	line: StructuredDiffLine,
	width: number,
	numWidth: number,
	theme: any,
	path: string | undefined,
	cwd: string | undefined,
	ranges: Array<[number, number]> = [],
): string {
	const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	const signToken = line.type === "add" ? "toolDiffAdded" : line.type === "del" ? "toolDiffRemoved" : "toolDiffContext";
	const gutter = `${theme.fg("muted", `${formatNum(line.oldNum, numWidth)} ${formatNum(line.newNum, numWidth)}`)} ${theme.fg(signToken, sign)} `;
	const contentWidth = Math.max(10, width - visibleLength(gutter));
	return `${gutter}${truncateAnsi(colorDiffText(line, highlightedLineBody(line, theme, path, cwd), theme, ranges, cwd), contentWidth)}`;
}

function renderUnifiedDiff(diff: StructuredDiff, rows: StructuredDiffLine[], width: number, theme: any, path?: string, cwd?: string): string[] {
	const tableWidth = Math.max(40, width);
	const maxNum = Math.max(1, ...diff.lines.map((line) => Math.max(line.oldNum ?? 0, line.newNum ?? 0)));
	const numWidth = Math.max(2, String(maxNum).length);
	const leftBorder = borderMuted(theme, "│");
	const rightBorder = borderMuted(theme, "│");
	const cellWidth = Math.max(1, tableWidth - visibleLength(leftBorder) - visibleLength(rightBorder));
	const contentWidth = Math.max(1, cellWidth - 2);
	const ruleSegment = borderMuted(theme, "─".repeat(Math.max(1, cellWidth)));
	const out: string[] = [`${borderMuted(theme, "┌")}${ruleSegment}${borderMuted(theme, "┐")}`];
	const pushLine = (line: string) => out.push(`${leftBorder} ${padVisible(line, contentWidth)} ${rightBorder}`);
	let index = 0;
	while (index < rows.length) {
		const line = rows[index]!;
		if (line.type === "ctx" || line.type === "sep") {
			pushLine(renderUnifiedLine(line, contentWidth, numWidth, theme, path ?? diff.path, cwd));
			index++;
			continue;
		}
		const dels: StructuredDiffLine[] = [];
		const adds: StructuredDiffLine[] = [];
		while (index < rows.length && rows[index]!.type === "del") dels.push(rows[index++]!);
		while (index < rows.length && rows[index]!.type === "add") adds.push(rows[index++]!);
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i++) {
			const del = dels[i];
			const add = adds[i];
			if (del) pushLine(renderUnifiedLine(del, contentWidth, numWidth, theme, path ?? diff.path, cwd, lineWordRanges(del, add ?? null, cwd)));
			if (add) pushLine(renderUnifiedLine(add, contentWidth, numWidth, theme, path ?? diff.path, cwd, lineWordRanges(add, del ?? null, cwd)));
		}
	}
	out.push(`${borderMuted(theme, "└")}${ruleSegment}${borderMuted(theme, "┘")}`);
	return out;
}

function pairDiffRows(rows: StructuredDiffLine[]): Array<{ left: StructuredDiffLine | null; right: StructuredDiffLine | null }> {
	const paired: Array<{ left: StructuredDiffLine | null; right: StructuredDiffLine | null }> = [];
	let index = 0;
	while (index < rows.length) {
		const line = rows[index]!;
		if (line.type === "ctx" || line.type === "sep") {
			paired.push({ left: line, right: line });
			index++;
			continue;
		}
		const dels: StructuredDiffLine[] = [];
		const adds: StructuredDiffLine[] = [];
		while (index < rows.length && rows[index]!.type === "del") dels.push(rows[index++]!);
		while (index < rows.length && rows[index]!.type === "add") adds.push(rows[index++]!);
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i++) paired.push({ left: dels[i] ?? null, right: adds[i] ?? null });
	}
	return paired;
}

function renderDiffHalf(
	line: StructuredDiffLine | null,
	side: "old" | "new",
	width: number,
	numWidth: number,
	theme: any,
	path: string | undefined,
	cwd: string | undefined,
	ranges: Array<[number, number]> = [],
): string {
	if (!line) return " ".repeat(width);
	const num = side === "old" ? line.oldNum : line.newNum;
	const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	const body = highlightedLineBody(line, theme, path, cwd);
	const prefix = `${formatNum(num, numWidth)} ${sign} `;
	const raw = `${prefix}${body}`;
	const shiftedRanges = ranges.map(([start, end]): [number, number] => [start + prefix.length, end + prefix.length]);
	return padVisible(truncateAnsi(colorDiffText(line, raw, theme, shiftedRanges, cwd), width), width);
}

function shouldUseSplitDiff(diff: StructuredDiff, rows: StructuredDiffLine[], width: number): boolean {
	if (width < DIFF_SPLIT_MIN_WIDTH) return false;
	const maxNum = Math.max(1, ...diff.lines.map((line) => Math.max(line.oldNum ?? 0, line.newNum ?? 0)));
	const numWidth = Math.max(2, String(maxNum).length);
	const innerWidth = Math.max(2, width - 3); // left border + center divider + right border
	const half = Math.max(24, Math.floor(innerWidth / 2));
	const codeWidth = half - 2 - numWidth - 3; // inner cell padding + number/sign prefix
	if (codeWidth < DIFF_SPLIT_MIN_CODE_WIDTH) return false;
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of rows) {
		if (line.type === "sep") continue;
		contentLines++;
		if (visibleLength(diffDisplayContent(line.content)) > codeWidth) wrapCandidates++;
	}
	if (contentLines === 0) return true;
	if (wrapCandidates >= DIFF_SPLIT_MAX_WRAP_LINES) return false;
	return wrapCandidates / contentLines < DIFF_SPLIT_MAX_WRAP_RATIO;
}

function renderDiffCell(
	line: StructuredDiffLine | null,
	side: "old" | "new",
	cellWidth: number,
	numWidth: number,
	theme: any,
	path: string | undefined,
	cwd: string | undefined,
	ranges: Array<[number, number]> = [],
): string {
	const contentWidth = Math.max(1, cellWidth - 2);
	return ` ${renderDiffHalf(line, side, contentWidth, numWidth, theme, path, cwd, ranges)} `;
}

function renderSplitDiff(diff: StructuredDiff, rows: StructuredDiffLine[], width: number, theme: any, path?: string, cwd?: string): string[] {
	const tableWidth = Math.max(DIFF_SPLIT_MIN_WIDTH, width);
	const maxNum = Math.max(1, ...diff.lines.map((line) => Math.max(line.oldNum ?? 0, line.newNum ?? 0)));
	const numWidth = Math.max(2, String(maxNum).length);
	const leftBorder = borderMuted(theme, "│");
	const divider = borderMuted(theme, "│");
	const rightBorder = borderMuted(theme, "│");
	const innerWidth = Math.max(2, tableWidth - visibleLength(leftBorder) - visibleLength(divider) - visibleLength(rightBorder));
	const leftCellWidth = Math.max(1, Math.floor(innerWidth / 2));
	const rightCellWidth = Math.max(1, innerWidth - leftCellWidth);
	const ruleSegment = (width: number) => borderMuted(theme, "─".repeat(Math.max(1, width)));
	const topRule = `${borderMuted(theme, "┌")}${ruleSegment(leftCellWidth)}${borderMuted(theme, "┬")}${ruleSegment(rightCellWidth)}${borderMuted(theme, "┐")}`;
	const bottomRule = `${borderMuted(theme, "└")}${ruleSegment(leftCellWidth)}${borderMuted(theme, "┴")}${ruleSegment(rightCellWidth)}${borderMuted(theme, "┘")}`;
	const out = [topRule];
	for (const pair of pairDiffRows(rows)) {
		const leftRanges = pair.left && pair.right ? lineWordRanges(pair.left, pair.right, cwd) : [];
		const rightRanges = pair.left && pair.right ? lineWordRanges(pair.right, pair.left, cwd) : [];
		out.push(`${leftBorder}${renderDiffCell(pair.left, "old", leftCellWidth, numWidth, theme, path ?? diff.path, cwd, leftRanges)}${divider}${renderDiffCell(pair.right, "new", rightCellWidth, numWidth, theme, path ?? diff.path, cwd, rightRanges)}${rightBorder}`);
	}
	out.push(bottomRule);
	return out;
}

function configuredDiffRowLimit(expanded: boolean, cwd?: string): number | null {
	const fallbackLimit = expanded ? 4000 : 24;
	const configuredLimit = Math.floor(settingNumber(expanded ? "diffExpandedLines" : "diffPreviewLines", fallbackLimit, cwd));
	return expanded && configuredLimit <= 0 ? null : Math.max(4, configuredLimit);
}

function collapsedDiffHint(remainingLines: number, hiddenHunks: number, expanded: boolean, shown: number, total: number, width = terminalWidth()): string {
	const candidates = expanded
		? [
			`… ${remainingLines} more diff lines${hiddenHunks > 0 ? ` · ${hiddenHunks} more hunks` : ""} · UI cap ${shown}/${total}`,
			`… ${remainingLines} more lines${hiddenHunks > 0 ? ` · ${hiddenHunks} hunks` : ""}`,
			`… +${remainingLines}${hiddenHunks > 0 ? ` · +${hiddenHunks}h` : ""}`,
			"…",
		]
		: [
			`… ${remainingLines} more diff lines${hiddenHunks > 0 ? ` · ${hiddenHunks} more hunks` : ""} · Ctrl+O to expand`,
			`… ${remainingLines} more lines${hiddenHunks > 0 ? ` · ${hiddenHunks} hunks` : ""}`,
			`… +${remainingLines}${hiddenHunks > 0 ? ` · +${hiddenHunks}h` : ""}`,
			"…",
		];
	for (const candidate of candidates) if (visibleWidth(candidate) <= width) return candidate;
	return "…";
}

function renderStructuredDiff(diff: StructuredDiff, theme: any, expanded: boolean, cwd?: string, rowLimit?: number | null, path?: string, widthOffset = 0): string {
	if (diff.additions === 0 && diff.removals === 0) return theme.fg("muted", "no changes");
	const width = Math.max(40, terminalWidth() - Math.max(0, widthOffset));
	const configuredLimit = rowLimit === undefined ? configuredDiffRowLimit(expanded, cwd) : rowLimit;
	const maxRows = configuredLimit === null ? diff.lines.length : Math.max(1, configuredLimit);
	const rows = diff.lines.slice(0, maxRows);
	const useSplit = settingBoolean("splitDiffs", true, cwd) && shouldUseSplitDiff(diff, rows, width);
	const rendered = useSplit ? renderSplitDiff(diff, rows, width, theme, path ?? diff.path, cwd) : renderUnifiedDiff(diff, rows, width, theme, path ?? diff.path, cwd);
	const remaining = diff.lines.length - rows.length;
	if (remaining > 0) rendered.push(theme.fg("dim", collapsedDiffHint(remaining, hiddenHunksAfter(diff.lines, rows), expanded, rows.length, diff.lines.length, width)));
	return rendered.join("\n");
}

interface UnifiedDiffFile {
	diff: StructuredDiff;
	path: string;
}

interface UnifiedDiffBuilder {
	additions: number;
	chars: number;
	hunkCount: number;
	lines: StructuredDiffLine[];
	newHunkEnd: number | null;
	newPath?: string;
	oldHunkEnd: number | null;
	oldPath?: string;
	path: string;
	removals: number;
	sawHunk: boolean;
}

function splitGitHeaderPaths(rest: string): string[] {
	const paths: string[] = [];
	const tokenRe = /"((?:\\.|[^"])*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(rest))) {
		const raw = match[1] ?? match[2] ?? "";
		if (!raw) continue;
		if (match[1] !== undefined) {
			try {
				paths.push(JSON.parse(`"${raw}"`));
			} catch {
				paths.push(raw.replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
			}
		} else {
			paths.push(raw);
		}
	}
	return paths;
}

function cleanDiffPath(raw: string): string {
	let path = raw.trim();
	if (!path || path === "/dev/null") return path;
	if ((path.startsWith("a/") || path.startsWith("b/")) && path.length > 2) path = path.slice(2);
	return path;
}

function diffPathFromHeader(line: string): string {
	const value = line.replace(/^(?:---|\+\+\+)\s+/, "").trim().split(/\t/)[0] ?? "";
	return cleanDiffPath(value);
}

function displayUnifiedDiffPath(path: string, oldPath?: string, newPath?: string): string {
	const preferred = newPath && newPath !== "/dev/null" ? newPath : oldPath && oldPath !== "/dev/null" ? oldPath : path;
	return preferred || "diff";
}

function parseHunkHeader(line: string): { newCount: number; newStart: number; oldCount: number; oldStart: number } | null {
	const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
	if (!match) return null;
	return {
		oldStart: Number.parseInt(match[1]!, 10),
		oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
		newStart: Number.parseInt(match[3]!, 10),
		newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
	};
}

function parseUnifiedDiffOutput(output: string): UnifiedDiffFile[] | null {
	const lines = stripAnsi(output).replace(/\r\n/g, "\n").split("\n");
	const files: UnifiedDiffFile[] = [];
	let current = null as UnifiedDiffBuilder | null;

	function start(path = "diff") {
		finish();
		current = { additions: 0, chars: 0, hunkCount: 0, lines: [], newHunkEnd: null, oldHunkEnd: null, path, removals: 0, sawHunk: false };
	}

	function finish() {
		if (!current) return;
		if (current.sawHunk && (current.additions > 0 || current.removals > 0)) {
			files.push({
				diff: { additions: current.additions, chars: current.chars || output.length, hunks: current.hunkCount || countStructuredHunks(current.lines), lines: current.lines, path: displayUnifiedDiffPath(current.path, current.oldPath, current.newPath), removals: current.removals },
				path: displayUnifiedDiffPath(current.path, current.oldPath, current.newPath),
			});
		}
		current = null;
	}

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.startsWith("diff --git ")) {
			const paths = splitGitHeaderPaths(line.slice("diff --git ".length)).map(cleanDiffPath);
			start(paths[1] || paths[0] || "diff");
			index++;
			continue;
		}
		if (!current && line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ")) start(diffPathFromHeader(lines[index + 1] ?? line));
		if (current && line.startsWith("--- ")) {
			current.oldPath = diffPathFromHeader(line);
			index++;
			continue;
		}
		if (current && line.startsWith("+++ ")) {
			current.newPath = diffPathFromHeader(line);
			current.path = displayUnifiedDiffPath(current.path, current.oldPath, current.newPath);
			index++;
			continue;
		}
		const hunk = current ? parseHunkHeader(line) : null;
		if (!current || !hunk) {
			index++;
			continue;
		}

		if (current.sawHunk && current.oldHunkEnd !== null && current.newHunkEnd !== null) {
			const hidden = Math.max(hunk.oldStart - current.oldHunkEnd - 1, hunk.newStart - current.newHunkEnd - 1);
			if (hidden > 0) current.lines.push(hiddenDiffLine(hidden));
		}
		current.sawHunk = true;
		current.hunkCount++;
		const hunkNumber = current.hunkCount;
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		let oldConsumed = 0;
		let newConsumed = 0;
		index++;
		while (index < lines.length && (oldConsumed < hunk.oldCount || newConsumed < hunk.newCount)) {
			const raw = lines[index] ?? "";
			if (raw.startsWith("\\ No newline at end of file")) {
				index++;
				continue;
			}
			const marker = raw[0];
			const content = raw.slice(1);
			if (marker === " ") {
				current.lines.push({ content, hunk: hunkNumber, newNum: newLine, oldNum: oldLine, type: "ctx" });
				oldLine++;
				newLine++;
				oldConsumed++;
				newConsumed++;
			} else if (marker === "-") {
				current.lines.push({ content, hunk: hunkNumber, newNum: null, oldNum: oldLine, type: "del" });
				oldLine++;
				oldConsumed++;
				current.removals++;
			} else if (marker === "+") {
				current.lines.push({ content, hunk: hunkNumber, newNum: newLine, oldNum: null, type: "add" });
				newLine++;
				newConsumed++;
				current.additions++;
			} else {
				break;
			}
			current.chars += content.length;
			index++;
		}
		current.oldHunkEnd = oldLine - 1;
		current.newHunkEnd = newLine - 1;
	}
	finish();
	return files.length > 0 ? files : null;
}

function bashDiffRenderingEnabled(cwd?: string): boolean {
	return settingBoolean("renderBashDiffs", false, cwd);
}

function shouldRenderBashDiffsForCommand(args: any, cwd?: string): boolean {
	return isGitDiffCommand(args?.command) ? settingBoolean("renderGitDiffCommandDiffs", false, cwd) : bashDiffRenderingEnabled(cwd);
}

function outputContainsUnifiedDiff(output: string): boolean {
	return Boolean(parseUnifiedDiffOutput(output)?.length);
}

function suppressReadOnlyBashDiffOutput(args: any, output: string, cwd?: string): boolean {
	return !shouldRenderBashDiffsForCommand(args, cwd) && outputContainsUnifiedDiff(output);
}

function renderBashDiffOutput(output: string, theme: any, expanded: boolean, cwd?: string, enabled = bashDiffRenderingEnabled(cwd)): string | null {
	if (!enabled) return null;
	const files = parseUnifiedDiffOutput(output);
	if (!files?.length) return null;
	const totalAdditions = files.reduce((sum, file) => sum + file.diff.additions, 0);
	const totalRemovals = files.reduce((sum, file) => sum + file.diff.removals, 0);
	const totalLines = files.reduce((sum, file) => sum + file.diff.lines.length, 0);
	const totalHunks = files.reduce((sum, file) => sum + (file.diff.hunks ?? countStructuredHunks(file.diff.lines)), 0);
	let remainingRows = configuredDiffRowLimit(expanded, cwd);
	const singleFile = files.length === 1;
	const rendered: string[] = [
		singleFile
			? `${toolLabel(theme, "Diff ")}${theme.fg("accent", files[0]!.path)} ${diffSummary(files[0]!.diff, theme, cwd)}`
			: `${toolLabel(theme, "Diff ")}${theme.fg("muted", `${files.length} files`)} ${diffSummary({ additions: totalAdditions, chars: output.length, hunks: totalHunks, lines: [], removals: totalRemovals }, theme, cwd)}`,
	];
	let renderedFiles = 0;
	for (const file of files) {
		if (remainingRows !== null && remainingRows <= 0) break;
		// For multi-file diffs, keep per-file summaries under the aggregate header
		// with a blank separator before each file so file boundaries are obvious.
		// For one-file diffs, the top line already has path/stat/hunk metadata, so
		// avoid repeating the same summary directly above the table.
		if (!singleFile) rendered.push("", `${theme.fg("accent", file.path)} ${diffSummary(file.diff, theme, cwd)}`);
		const fileLimit = remainingRows === null ? null : remainingRows;
		const diffText = renderStructuredDiff(file.diff, theme, expanded, cwd, fileLimit, file.path);
		// Keep the actual split/unified table flush with the Bash diff block. Prefixing
		// every table row with a tree stem made git diff tables look oddly indented
		// and could overflow by the stem width on wide terminals.
		rendered.push(...diffText.split(/\r?\n/));
		renderedFiles++;
		if (remainingRows !== null) remainingRows -= Math.min(file.diff.lines.length, fileLimit ?? file.diff.lines.length);
	}
	const hiddenFiles = files.length - renderedFiles;
	if (hiddenFiles > 0) rendered.push(theme.fg("muted", `… ${hiddenFiles} more file diff${hiddenFiles === 1 ? "" : "s"}${expanded ? ` · UI cap ${Math.max(0, renderedFiles)}/${files.length}` : " · Ctrl+O to expand"}`));
	else if (remainingRows !== null && totalLines > configuredDiffRowLimit(expanded, cwd)!) {
		rendered.push(theme.fg("muted", expanded ? "diff UI cap reached" : "Ctrl+O to expand"));
	}
	return rendered.join("\n");
}

function readTextForDiff(pathValue: unknown, cwd: string): string | undefined {
	if (typeof pathValue !== "string" || !pathValue.trim()) return undefined;
	const target = resolve(cwd, pathValue);
	try {
		if (!existsSync(target)) return undefined;
		const text = readFileSync(target, "utf8");
		return Buffer.byteLength(text, "utf8") <= MAX_DIFF_INPUT_BYTES ? text : undefined;
	} catch {
		return undefined;
	}
}

function attachDiffDetails(result: any, before: string | undefined, after: string | undefined, path?: string): any {
	if (before === undefined && after === undefined) return result;
	const oldText = before ?? "";
	const newText = after ?? "";
	if (oldText === newText) return result;
	const diff = { ...buildStructuredDiff(oldText, newText), path };
	const extra = { vstackDiff: diff, vstackDiffWasNewFile: before === undefined };
	result.details = result?.details && typeof result.details === "object" ? { ...result.details, ...extra } : extra;
	return result;
}

function editOperationsFromArgs(args: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(args?.edits)) {
		return args.edits
			.map((edit: any) => ({
				oldText: typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText: typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit: { oldText: string; newText: string }) => edit.oldText.length > 0 && edit.oldText !== edit.newText);
	}
	const oldText = typeof args?.oldText === "string" ? args.oldText : typeof args?.old_text === "string" ? args.old_text : "";
	const newText = typeof args?.newText === "string" ? args.newText : typeof args?.new_text === "string" ? args.new_text : "";
	return oldText.length > 0 && oldText !== newText ? [{ oldText, newText }] : [];
}

function summarizeDiffs(diffs: StructuredDiff[]): StructuredDiff {
	return {
		additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
		chars: diffs.reduce((sum, diff) => sum + diff.chars, 0),
		hunks: diffs.reduce((sum, diff) => sum + (diff.hunks ?? countStructuredHunks(diff.lines)), 0),
		lines: diffs.flatMap((diff, index) => index === 0 ? diff.lines : [hiddenDiffLine(0), ...diff.lines]),
		removals: diffs.reduce((sum, diff) => sum + diff.removals, 0),
	};
}

function renderMutationCallPreview(kind: "Edit" | "Write" | "Create", targetPath: string, diffs: StructuredDiff[], theme: any, context: any, cwd: string): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (context?.executionStarted && !context?.isPartial) return makeEmpty();
	if (!settingBoolean("mutationCallPreview", true, cwd) || diffs.length === 0) return makeEmpty();
	const total = summarizeDiffs(diffs);
	const prefix = context?.executionStarted && context?.isPartial ? blinkingPrefix(theme, context) : stackPrefix(theme);
	let text = `${prefix}${toolLabel(theme, `${kind} `)}${theme.fg("accent", targetPath)}${theme.fg("dim", " · preview · ")}${diffSummary(total, theme, cwd)}`;
	const maxShown = context?.expanded ? diffs.length : Math.min(1, diffs.length);
	const perDiffLimit = Math.max(4, Math.floor(settingNumber("mutationCallPreviewLines", 16, cwd) / Math.max(1, maxShown)));
	for (let index = 0; index < maxShown; index++) {
		const diff = diffs[index]!;
		if (diffs.length > 1) text += `\n${treeConnector(theme, "├", cwd)}${theme.fg("muted", `edit ${index + 1}/${diffs.length}`)} ${diffSummary(diff, theme, cwd)}`;
		const stem = treeConnector(theme, "│", cwd);
		const rendered = renderStructuredDiff(diff, theme, Boolean(context?.expanded), cwd, perDiffLimit, targetPath, visibleWidth(stem));
		text += `\n${rendered.split(/\r?\n/).map((line) => `${stem}${line}`).join("\n")}`;
	}
	const hidden = diffs.length - maxShown;
	if (hidden > 0) text += `\n${treeConnector(theme, "└", cwd)}${theme.fg("muted", `… ${hidden} more edit block${hidden === 1 ? "" : "s"} · Ctrl+O to expand`)}`;
	return makeTruncatedLines(text);
}

function existingSmallTextOrUndefined(targetPath: string, cwd: string): string | undefined {
	return readTextForDiff(targetPath, cwd);
}

type StackableToolName = "read" | "bash" | "grep" | "find" | "ls";
type StackItemStatus = "running" | "done" | "error";

interface StackItem {
	args: any;
	batchId: string;
	id: string;
	isError: boolean;
	resultText: string;
	status: StackItemStatus;
	toolName: StackableToolName;
	truncated: boolean;
}

interface StackBatch {
	anchorId: string;
	id: string;
	items: string[];
	updatedAt: number;
}

const STACKABLE_TOOLS = new Set<string>(["read", "bash", "grep", "find", "ls"]);
const stackItems = new Map<string, StackItem>();
const stackBatches = new Map<string, StackBatch>();
const stackInvalidators = new Map<string, () => void>();
let currentStackBatch: StackBatch | null = null;
let stackBatchCounter = 0;

function isStackableToolName(toolName: unknown): toolName is StackableToolName {
	return typeof toolName === "string" && STACKABLE_TOOLS.has(toolName);
}

function notifyStackBatch(batchId: string): void {
	const batch = stackBatches.get(batchId);
	if (!batch) return;
	for (const id of batch.items) stackInvalidators.get(id)?.();
}

function createStackBatch(firstId: string): StackBatch {
	const batch: StackBatch = { anchorId: firstId, id: `stack-${++stackBatchCounter}`, items: [], updatedAt: Date.now() };
	stackBatches.set(batch.id, batch);
	currentStackBatch = batch;
	return batch;
}

function ensureStackItem(toolName: StackableToolName, id: string, args: any): StackItem {
	const existing = stackItems.get(id);
	if (existing) {
		existing.args = args ?? existing.args;
		return existing;
	}
	const batch = currentStackBatch ?? createStackBatch(id);
	if (!batch.items.includes(id)) batch.items.push(id);
	const item: StackItem = { args, batchId: batch.id, id, isError: false, resultText: "", status: "running", toolName, truncated: false };
	stackItems.set(id, item);
	batch.updatedAt = Date.now();
	notifyStackBatch(batch.id);
	return item;
}

function contextToolCallId(context: any, toolName: string, args: any): string {
	return String(context?.toolCallId ?? context?.id ?? `${toolName}:${JSON.stringify(args ?? {})}`);
}

function stackItemCallText(item: StackItem, theme: any, cwd?: string): string {
	if (item.toolName === "read") return readCallText(item.args, theme);
	if (item.toolName === "bash") return bashCallText(item.args, theme, cwd);
	return readOnlyCallText(item.toolName, item.args, theme, cwd);
}

function stackItemSummary(item: StackItem, theme: any): string {
	if (item.status === "running") return theme.fg("warning", "running");
	if (item.isError) return theme.fg("error", "failed");
	if (item.toolName === "read") {
		const count = lineCount(item.resultText);
		let text = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
		if (item.truncated) text += theme.fg("warning", " · truncated");
		return text;
	}
	if (item.toolName === "bash") {
		const exit = commandExit(item.resultText);
		const count = lineCount(item.resultText);
		const exitLabel = exit === null ? "exit 0" : `exit ${exit}`;
		let text = exit !== null && exit !== 0 ? theme.fg("error", exitLabel) : theme.fg("success", exitLabel);
		text += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
		if (item.truncated) text += theme.fg("warning", " · truncated");
		return text;
	}
	const count = item.resultText.trim() ? lineCount(item.resultText) : 0;
	let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
	if (item.truncated) text += theme.fg("warning", " · truncated");
	return text;
}

function stackItemPreview(item: StackItem, theme: any, expanded: boolean, cwd?: string): string {
	if (!item.resultText || item.status === "running") return "";
	if (item.toolName === "find" || item.toolName === "ls") return renderPathListPreview(item.resultText, item.toolName, theme, expanded, cwd);
	if (item.toolName === "bash") {
		const renderDiffs = shouldRenderBashDiffsForCommand(item.args, cwd);
		if (!renderDiffs && suppressReadOnlyBashDiffOutput(item.args, item.resultText, cwd)) return "";
		return renderBashDiffOutput(item.resultText, theme, expanded, cwd, renderDiffs) ?? preview(item.resultText, Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, cwd))), "tail", cwd);
	}
	if (item.toolName === "read") return preview(item.resultText, Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, cwd))), "head", cwd);
	return preview(item.resultText, Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, cwd))), "head", cwd);
}

function renderStackItemText(item: StackItem, theme: any, expanded: boolean, cwd?: string, branch = "├"): string {
	const typedBranch = branch as TreeBranch;
	const stem = treeStem(theme, typedBranch, cwd);
	let text = `${treeConnector(theme, typedBranch, cwd)}${stackItemCallText(item, theme, cwd)}${theme.fg("dim", " · ")}${stackItemSummary(item, theme)}`;
	if (expanded) {
		const previewText = stackItemPreview(item, theme, expanded, cwd);
		if (previewText) {
			const lines = previewText.split(/\r?\n/).map((line) => `${stem}${theme.fg("dim", line)}`);
			text += `\n${lines.join("\n")}`;
		}
	}
	return text;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

function joinPhrases(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function stackBatchHeadline(batch: StackBatch, theme: any, expanded: boolean, childDisplay: StackChildDisplay): string {
	const items = batch.items.map((id) => stackItems.get(id)).filter(Boolean) as StackItem[];
	const running = items.some((item) => item.status === "running");
	const done = items.filter((item) => item.status !== "running").length;
	const reads = items.filter((item) => item.toolName === "read").length;
	const shells = items.filter((item) => item.toolName === "bash").length;
	const searches = items.filter((item) => item.toolName === "grep" || item.toolName === "find" || item.toolName === "ls").length;
	const phrases: string[] = [];
	if (reads > 0) phrases.push(`${running ? "reading" : "read"} ${plural(reads, "file")}`);
	if (shells > 0) phrases.push(`${running ? "running" : "ran"} ${plural(shells, "shell command")}`);
	if (searches > 0) phrases.push(`${running ? "searching/listing" : "searched/listed"} ${plural(searches, "time")}`);
	const lead = joinPhrases(phrases) || (running ? "running tools" : "ran tools");
	const sentence = lead.charAt(0).toUpperCase() + lead.slice(1);
	const progress = running ? theme.fg("warning", ` · ${done}/${items.length} done`) : theme.fg("success", " · done");
	const expandHint = childDisplay === "headline" && !expanded && items.length > 0 ? theme.fg("dim", " · Ctrl+O to expand") : "";
	return `${stackPrefix(theme)}${sentence}${running ? "…" : ""}${progress}${expandHint}`;
}

function renderStackBatch(batch: StackBatch, theme: any, expanded: boolean, cwd?: string, childDisplay: StackChildDisplay = "rows"): TruncatedLines {
	let text = stackBatchHeadline(batch, theme, expanded, childDisplay);
	if (childDisplay === "anchor-list" || (childDisplay === "headline" && expanded)) {
		const items = batch.items.map((id) => stackItems.get(id)).filter(Boolean) as StackItem[];
		items.forEach((item, index) => {
			text += `\n${renderStackItemText(item, theme, expanded, cwd, index === items.length - 1 ? "└" : "├")}`;
		});
	}
	return makeTruncatedLines(text);
}

function renderStackedToolResult(toolName: StackableToolName, result: any, isPartial: boolean, expanded: boolean, theme: any, context: any, cwd: string) {
	const id = contextToolCallId(context, toolName, context?.args);
	const item = ensureStackItem(toolName, id, context?.args ?? {});
	if (context?.invalidate) stackInvalidators.set(id, context.invalidate);
	if (!isPartial) {
		item.status = context?.isError ? "error" : "done";
		item.isError = Boolean(context?.isError);
		item.resultText = textContent(result);
		item.truncated = resultTruncated(result);
		stackBatches.get(item.batchId)!.updatedAt = Date.now();
	}
	const batch = stackBatches.get(item.batchId);
	if (!batch) return makeEmpty();
	const effectiveCwd = context?.cwd ?? cwd;
	const childDisplay = stackChildDisplay(effectiveCwd);
	if (batch.anchorId === id) return renderStackBatch(batch, theme, expanded, effectiveCwd, childDisplay);
	if (childDisplay !== "rows") return makeEmpty();
	const items = batch.items.map((itemId) => stackItems.get(itemId)).filter(Boolean) as StackItem[];
	const index = Math.max(0, items.findIndex((candidate) => candidate.id === id));
	return makeTruncatedLines(renderStackItemText(item, theme, false, effectiveCwd, index === items.length - 1 ? "└" : "├"));
}

function registerStackEvents(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		currentStackBatch = null;
	});
	pi.on("tool_execution_start", (event: any) => {
		if (isStackableToolName(event.toolName)) {
			ensureStackItem(event.toolName, String(event.toolCallId), event.args ?? event.input ?? {});
			return;
		}
		currentStackBatch = null;
	});
	pi.on("tool_execution_end", (event: any) => {
		const item = stackItems.get(String(event.toolCallId));
		if (!item) return;
		item.status = event.isError ? "error" : "done";
		item.isError = Boolean(event.isError);
		item.resultText = textContent(event.result);
		item.truncated = resultTruncated(event.result);
		notifyStackBatch(item.batchId);
	});
	pi.on("agent_end", () => {
		currentStackBatch = null;
	});
}

type BuiltInToolName = StackableToolName | "edit" | "write";
type BuiltInToolSet = Partial<Record<BuiltInToolName, any>>;

type BatchToolCall = { args: Record<string, any>; tool: StackableToolName };

interface BatchToolItem {
	args: Record<string, any>;
	details?: unknown;
	index: number;
	isError: boolean;
	resultText: string;
	toolName: StackableToolName;
	truncated: boolean;
}

interface BatchToolDetails {
	items: BatchToolItem[];
	failed: number;
	succeeded: number;
	total: number;
}

const builtInToolCache = new Map<string, BuiltInToolSet>();

function normalizedCwd(cwd?: string): string {
	return resolve(cwd || process.cwd());
}

function createBuiltInToolSet(agent: any, cwd: string): BuiltInToolSet {
	return {
		read: agent.createReadTool?.(cwd),
		bash: agent.createBashTool?.(cwd),
		edit: agent.createEditTool?.(cwd),
		write: agent.createWriteTool?.(cwd),
		grep: agent.createGrepTool?.(cwd),
		find: agent.createFindTool?.(cwd),
		ls: agent.createLsTool?.(cwd),
	};
}

function getBuiltInTool(agent: any, cwd: string, toolName: BuiltInToolName): any {
	const key = normalizedCwd(cwd);
	let tools = builtInToolCache.get(key);
	if (!tools) {
		tools = createBuiltInToolSet(agent, key);
		builtInToolCache.set(key, tools);
	}
	return tools[toolName];
}

function contextCwd(context: any, fallback: string): string {
	return context?.cwd ?? fallback;
}

const ToolBatchParams = {
	type: "object",
	additionalProperties: false,
	properties: {
		calls: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: true,
				description: "One tool call. Prefer { tool, args }, but flat fields such as { tool: 'read', path: 'README.md' } are also accepted.",
				properties: {
					tool: { type: "string", enum: ["read", "grep", "find", "ls", "bash"], description: "Tool to run inside the batch." },
					args: { type: "object", additionalProperties: true, description: "Arguments for the selected tool. Optional; flat sibling fields are folded into args." },
				},
				required: ["tool"],
			},
		},
		concurrency: { type: "number", description: "Maximum calls to run at once. Defaults to all calls, capped by settings." },
	},
	required: ["calls"],
} as const;

function normalizeBatchCalls(value: unknown): BatchToolCall[] {
	if (!Array.isArray(value)) return [];
	const calls: BatchToolCall[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const tool = (raw as any).tool;
		if (!isStackableToolName(tool)) continue;
		const flatArgs: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
			if (key !== "tool" && key !== "args") flatArgs[key] = val;
		}
		const nestedArgs = (raw as any).args && typeof (raw as any).args === "object" && !Array.isArray((raw as any).args) ? (raw as any).args : {};
		calls.push({ args: { ...flatArgs, ...nestedArgs }, tool });
	}
	return calls;
}

async function mapBatchWithConcurrency<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let next = 0;
	const workers = new Array(Math.max(1, Math.min(concurrency, items.length || 1))).fill(null).map(async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function batchStackItem(item: BatchToolItem): StackItem {
	return {
		args: item.args,
		batchId: "tool-batch",
		id: `tool-batch:${item.index}`,
		isError: item.isError,
		resultText: item.resultText,
		status: item.isError ? "error" : "done",
		toolName: item.toolName,
		truncated: item.truncated,
	};
}

function renderToolBatchText(items: BatchToolItem[], theme: any, expanded: boolean, cwd?: string): string {
	const failed = items.filter((item) => item.isError).length;
	const succeeded = items.length - failed;
	const header =
		stackPrefix(theme) +
		toolLabel(theme, `Batch ${succeeded}/${items.length}`) +
		theme.fg(failed > 0 ? "warning" : "success", failed > 0 ? ` · ${failed} failed` : " · succeeded") +
		(expanded ? "" : theme.fg("dim", " · Ctrl+O to inspect"));
	const lines = [header];
	items.forEach((item, index) => {
		const stackItem = batchStackItem(item);
		lines.push(renderStackItemText(stackItem, theme, expanded, cwd, index === items.length - 1 ? "└" : "├"));
	});
	return lines.join("\n");
}

function toolBatchOutput(items: BatchToolItem[]): string {
	const failed = items.filter((item) => item.isError).length;
	const lines = [`Batch: ${items.length - failed}/${items.length} succeeded`];
	for (const item of items) {
		const label = `${item.index + 1}. ${item.toolName}`;
		lines.push("", `## ${label}`, item.isError ? "Status: failed" : "Status: completed", item.resultText || "(no output)");
	}
	return lines.join("\n");
}

function renderToolBatchCallText(args: any, theme: any, cwd?: string): string {
	const calls = normalizeBatchCalls(args?.calls);
	const lines = [stackPrefix(theme) + toolLabel(theme, `Batch ${calls.length || 0} tool${calls.length === 1 ? "" : "s"} launching`)];
	calls.slice(0, 12).forEach((call, index) => {
		const item: StackItem = { args: call.args, batchId: "call", id: String(index), isError: false, resultText: "", status: "running", toolName: call.tool, truncated: false };
		lines.push(`${treeConnector(theme, index === calls.length - 1 ? "└" : "├", cwd)}${stackItemCallText(item, theme, cwd)}`);
	});
	if (calls.length > 12) lines.push(`${treeConnector(theme, "└", cwd)}${theme.fg("muted", `… +${calls.length - 12} more`)}`);
	return lines.join("\n");
}

function registerToolBatch(pi: ExtensionAPI, agent: any, cwd: string): void {
	pi.registerTool({
		renderShell: "self",
		name: "tool_batch",
		label: "Tool Batch",
		description:
			"Run multiple independent read/grep/find/ls/bash calls as one composite tool with a single stacked renderer. Prefer this over separate parallel read/search/list/diagnostic bash calls. Use bash only for diagnostic commands whose side effects and ordering do not matter.",
		promptSnippet: "Batch 2+ independent read/search/list/diagnostic bash calls into one compact result.",
		promptGuidelines: [
			"Prefer tool_batch instead of separate parallel read, grep, find, ls, or diagnostic bash calls whenever the calls are independent.",
			"Use individual read/grep/find/ls/bash calls when there is only one call, when calls depend on previous results, when bash mutates state, when streaming/live output matters, or when the user explicitly wants separate tool entries.",
			"Do not use tool_batch for edit/write or for bash commands that mutate files, depend on ordering, need streaming output, or should be inspected as separate commands.",
		],
		parameters: ToolBatchParams as never,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const calls = normalizeBatchCalls(params?.calls);
			const maxCalls = Math.max(1, Math.floor(settingNumber("batchMaxCalls", 8, effectiveCwd)));
			if (calls.length === 0) return { content: [{ type: "text", text: "No valid calls provided." }], details: { failed: 0, items: [], succeeded: 0, total: 0 } };
			if (calls.length > maxCalls) {
				return {
					content: [{ type: "text", text: `Too many calls (${calls.length}). Max is ${maxCalls}.` }],
					details: { failed: calls.length, items: [], succeeded: 0, total: calls.length },
					isError: true,
				};
			}
			const concurrency = Math.max(1, Math.min(calls.length, Math.floor(Number(params?.concurrency) || calls.length), maxCalls));
			const items = await mapBatchWithConcurrency(calls, concurrency, async (call, index): Promise<BatchToolItem> => {
				try {
					const original = getBuiltInTool(agent, effectiveCwd, call.tool);
					if (!original?.execute) throw new Error(`Built-in tool unavailable: ${call.tool}`);
					const result = await original.execute(`${toolCallId}:${index}`, call.args, signal, undefined);
					return {
						args: call.args,
						details: result?.details,
						index,
						isError: Boolean(result?.isError),
						resultText: textContent(result),
						toolName: call.tool,
						truncated: resultTruncated(result),
					};
				} catch (error) {
					return {
						args: call.args,
						index,
						isError: true,
						resultText: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
						toolName: call.tool,
						truncated: false,
					};
				}
			});
			const failed = items.filter((item) => item.isError).length;
			const details: BatchToolDetails = { failed, items, succeeded: items.length - failed, total: items.length };
			return { content: [{ type: "text", text: toolBatchOutput(items) }], details, isError: failed > 0 };
		},
		renderCall() {
			return makeEmpty();
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			if (isPartial) return makeTruncatedLines(renderToolBatchCallText(context?.args, theme, context?.cwd ?? cwd));
			const details = result.details as BatchToolDetails | undefined;
			if (!details?.items) return makeTruncatedLines(textContent(result) || "(no output)");
			return makeTruncatedLines(renderToolBatchText(details.items, theme, expanded, context?.cwd ?? cwd));
		},
	});
}

const CORE_TOOL_RENDERERS = new Set(["read", "bash", "grep", "find", "ls", "edit", "write", "tool_batch", "tasks_write", "bg_task", "bg_status", "question", "subagent"]);
const OPENAI_STYLE_TOOL_NAMES = new Set([
	"webfetch",
	"web_fetch",
	"web_search",
	"fetch_content",
	"get_search_content",
	"code_search",
	"context_tag",
	"context_log",
	"context_checkout",
	"annotate",
	"Skill",
	"EnterPlanMode",
	"ExitPlanMode",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
]);

type ToolChromeMode = "off" | "transparent" | "outlines";

function toolChromeMode(cwd?: string): ToolChromeMode {
	return settingEnum("toolChrome", ["off", "transparent", "outlines"] as const, "outlines", cwd);
}

function isMcpToolName(name: string): boolean {
	return name === "mcp" || name.startsWith("mcp__") || name.startsWith("mcp_") || /(^|[_-])mcp([_-]|$)/i.test(name);
}

function shouldUseGenericRenderer(name: string): boolean {
	if (!name || CORE_TOOL_RENDERERS.has(name) || name === "apply_patch") return false;
	if (isMcpToolName(name)) return true;
	if (OPENAI_STYLE_TOOL_NAMES.has(name)) return true;
	return /^Task[A-Z]/.test(name);
}

function isUnknownToolComponent(component: any): boolean {
	return component?.toolDefinition === undefined && component?.builtInToolDefinition === undefined;
}

function shouldUseUnknownToolRenderer(component: any, name: string): boolean {
	return Boolean(name) && settingBoolean("genericToolRenderers", true) && isUnknownToolComponent(component);
}

function componentDefinesRenderer(component: any, slot: "renderCall" | "renderResult"): boolean {
	for (const key of ["tool", "toolDefinition", "definition", "toolDef", "toolConfig"]) {
		const candidate = component?.[key];
		if (candidate && typeof candidate[slot] === "function") return true;
	}
	return false;
}

function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function oneLine(value: string, max = 72): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}

function stringArg(args: any, ...keys: string[]): string {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function stringArrayArg(args: any, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = args?.[key];
		if (!Array.isArray(value)) continue;
		const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (strings.length > 0) return strings;
	}
	return [];
}

function genericStatusPrefix(context: any, theme: any): string {
	if (!context?.executionStarted || context?.isPartial) return blinkingPrefix(theme, context);
	clearBlink(context);
	return theme.fg(context?.isError ? "error" : "success", "● ");
}

function patchTextFromArgs(args: any): string {
	return stringArg(args, "patch", "patchText", "patch_text", "input");
}

function extractApplyPatchFiles(patchText: string): string[] {
	const files = new Set<string>();
	for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		const file = match[1]?.trim();
		if (file) files.add(file);
	}
	return [...files];
}

function parsePatchBodyLine(rawLine: string): { content: string; marker: "+" | "-" | " " } {
	const marker = rawLine[0];
	if (marker === "+" || marker === "-" || marker === " ") return { content: rawLine.slice(1), marker };
	return { content: rawLine, marker: " " };
}

function parseApplyPatchUpdateDiff(lines: string[]): StructuredDiff {
	const diffLines: StructuredDiffLine[] = [];
	let additions = 0;
	let removals = 0;
	let chars = 0;
	let oldLine: number | null = null;
	let newLine: number | null = null;
	let hunk = 0;
	let inHunk = false;
	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue;
		const header = rawLine.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
		if (rawLine.startsWith("@@")) {
			if (diffLines.length > 0 && diffLines[diffLines.length - 1]?.type !== "sep") diffLines.push(hiddenDiffLine(0));
			oldLine = header ? Number.parseInt(header[1]!, 10) : (oldLine ?? 1);
			newLine = header ? Number.parseInt(header[2]!, 10) : (newLine ?? 1);
			hunk++;
			inHunk = true;
			continue;
		}
		if (rawLine === "\\ No newline at end of file") continue;
		if (!inHunk) {
			hunk++;
			oldLine = oldLine ?? 1;
			newLine = newLine ?? 1;
			inHunk = true;
		}
		const { content, marker } = parsePatchBodyLine(rawLine);
		chars += content.length;
		if (marker === "+") {
			diffLines.push({ content, hunk, newNum: newLine, oldNum: null, type: "add" });
			additions++;
			if (newLine !== null) newLine++;
		} else if (marker === "-") {
			diffLines.push({ content, hunk, newNum: null, oldNum: oldLine, type: "del" });
			removals++;
			if (oldLine !== null) oldLine++;
		} else {
			diffLines.push({ content, hunk, newNum: newLine, oldNum: oldLine, type: "ctx" });
			if (oldLine !== null) oldLine++;
			if (newLine !== null) newLine++;
		}
	}
	const numbered = assignHunkNumbers(diffLines);
	return { additions, chars, hunks: Math.max(hunk, numbered.hunks), lines: numbered.lines, removals };
}

interface ApplyPatchChange {
	diff: StructuredDiff;
	displayPath: string;
	kind: "add" | "update" | "delete";
	line: number;
	moveTo?: string;
	path: string;
}

function firstChangedLine(diff: StructuredDiff): number {
	for (const line of diff.lines) {
		if (line.type === "add" && line.newNum !== null) return line.newNum;
		if (line.type === "del" && line.oldNum !== null) return line.oldNum;
	}
	return 0;
}

function parseApplyPatchPreview(patchText: string): ApplyPatchChange[] {
	const lines = patchText.replace(/\r\n/g, "\n").split("\n");
	const changes: ApplyPatchChange[] = [];
	const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
	let index = 0;
	while (index < lines.length) {
		const header = lines[index]?.match(fileHeader);
		if (!header) {
			index++;
			continue;
		}
		const kind = header[1]!.toLowerCase() as ApplyPatchChange["kind"];
		const path = header[2]!.trim();
		index++;
		let moveTo: string | undefined;
		const body: string[] = [];
		while (index < lines.length && !fileHeader.test(lines[index] ?? "") && !/^\*\*\* End Patch$/.test(lines[index] ?? "")) {
			const line = lines[index] ?? "";
			if (line.startsWith("*** Move to: ")) moveTo = line.slice("*** Move to: ".length).trim();
			else body.push(line);
			index++;
		}
		const diff = kind === "add"
			? buildStructuredDiff("", body.map((line) => line.startsWith("+") ? line.slice(1) : line).join("\n"))
			: kind === "delete"
				? buildStructuredDiff(body.map((line) => line.startsWith("-") ? line.slice(1) : line).join("\n"), "")
				: parseApplyPatchUpdateDiff(body);
		diff.path = moveTo || path;
		changes.push({ diff, displayPath: moveTo ? `${path} → ${moveTo}` : path, kind, line: firstChangedLine(diff), moveTo, path });
	}
	return changes;
}

function summarizeApplyPatchChanges(changes: ApplyPatchChange[]): StructuredDiff {
	return summarizeDiffs(changes.map((change) => change.diff));
}

function applyPatchChangeLabel(change: ApplyPatchChange): string {
	if (change.moveTo) return `Rename ${change.displayPath}`;
	if (change.kind === "add") return `Create ${change.displayPath}`;
	if (change.kind === "delete") return `Delete ${change.displayPath}`;
	return `Update ${change.displayPath}`;
}

function applyPatchSummaryTarget(changes: ApplyPatchChange[], theme: any): string {
	if (changes.length === 0) return theme.fg("muted", "patch");
	if (changes.length > 1) return theme.fg("muted", `${changes.length} files changed`);
	const first = changes[0]!;
	const firstPath = first.moveTo || first.path;
	return theme.fg("accent", firstPath);
}

function applyPatchKindLabel(changes: ApplyPatchChange[]): string {
	if (changes.length !== 1) return "Apply Patch ";
	const change = changes[0]!;
	if (change.moveTo) return "Rename ";
	if (change.kind === "add") return "Create ";
	if (change.kind === "delete") return "Delete ";
	return "Update ";
}

function applyPatchChangeStatus(change: ApplyPatchChange): string {
	if (change.moveTo) return "renamed";
	if (change.kind === "add") return "created";
	if (change.kind === "delete") return "deleted";
	return "applied";
}

function applyPatchResultSummary(changes: ApplyPatchChange[], total: StructuredDiff, theme: any, cwd?: string): string {
	if (total.additions > 0 || total.removals > 0) return diffSummary(total, theme, cwd);
	return theme.fg("success", changes.length === 1 ? applyPatchChangeStatus(changes[0]!) : "applied");
}

function applyPatchChangesFromContext(context: any): ApplyPatchChange[] {
	if (Array.isArray(context?.state?._vstackApplyPatchChanges)) return context.state._vstackApplyPatchChanges as ApplyPatchChange[];
	try {
		return parseApplyPatchPreview(patchTextFromArgs(context?.args ?? {}));
	} catch {
		return [];
	}
}

function renderApplyPatchCall(args: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (context?.executionStarted) return makeEmpty();
	const patchText = patchTextFromArgs(args);
	let changes: ApplyPatchChange[] = [];
	if (patchText) {
		try {
			changes = parseApplyPatchPreview(patchText);
			if (context?.argsComplete && context?.state) context.state._vstackApplyPatchChanges = changes;
		} catch {
			// Leave compact pending header only if patch cannot be parsed.
		}
	}
	const files = changes.length > 0 ? changes.map((change) => change.moveTo || change.path) : extractApplyPatchFiles(patchText);
	const multiFile = changes.length > 1 || files.length > 1;
	const summary = multiFile ? theme.fg("muted", `${Math.max(changes.length, files.length)} files changed`) : theme.fg("muted", "patch");
	const total = changes.length > 1 ? `${theme.fg("dim", " · ")}${diffSummary(summarizeApplyPatchChanges(changes), theme, context?.cwd)}` : "";
	return makeTruncatedLines(`${genericStatusPrefix(context, theme)}${toolLabel(theme, "Apply Patch ")}${summary}${total}`);
}

function renderApplyPatchResult(result: any, { expanded, isPartial }: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (isPartial) return makeEmpty();
	clearBlink(context);
	const changes = applyPatchChangesFromContext(context);
	const target = applyPatchSummaryTarget(changes, theme);
	const call = `${toolLabel(theme, applyPatchKindLabel(changes))}${target}`;
	if (context?.isError) {
		const first = textContent(result).split(/\r?\n/)[0] || "apply_patch failed";
		return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("error", first)}`);
	}
	if (changes.length === 0) return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("success", "applied")}`);
	const total = summarizeApplyPatchChanges(changes);
	let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${applyPatchResultSummary(changes, total, theme, context?.cwd)}`;
	const maxShown = expanded ? changes.length : Math.min(1, changes.length);
	const hidden = changes.length - maxShown;
	const rowLimit = maxShown > 1 ? Math.max(4, Math.floor(settingNumber("applyPatchPreviewLines", 18, context?.cwd) / Math.max(1, maxShown))) : undefined;
	for (let i = 0; i < maxShown; i++) {
		const change = changes[i]!;
		const changed = change.diff.additions > 0 || change.diff.removals > 0;
		const connector = changes.length > 1 ? treeConnector(theme, i === maxShown - 1 && hidden === 0 ? "└" : "├", context?.cwd) : "";
		if (!changed) {
			if (changes.length > 1) text += `\n${connector}${theme.fg("accent", applyPatchChangeLabel(change))} ${theme.fg("success", applyPatchChangeStatus(change))}`;
			continue;
		}
		if (changes.length > 1) text += `\n${connector}${theme.fg("accent", applyPatchChangeLabel(change))} ${diffSummary(change.diff, theme, context?.cwd)}`;
		text += `\n${renderStructuredDiff(change.diff, theme, expanded, context?.cwd, rowLimit, change.diff.path)}`;
	}
	if (hidden > 0) text += `\n${treeConnector(theme, "└", context?.cwd)}${theme.fg("muted", `… ${hidden} more file patch${hidden === 1 ? "" : "es"} · Ctrl+O to expand`)}`;
	return makeTruncatedLines(text);
}

function formatScheduleWakeupDelay(value: unknown): string {
	const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return "later";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = seconds / 60;
	if (minutes < 60) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
	const hours = minutes / 60;
	return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function summarizeScheduleWakeupCall(args: any, theme: any): string {
	const delay = formatScheduleWakeupDelay(args?.delaySeconds ?? args?.delay_seconds ?? args?.delay ?? args?.seconds);
	const reason = stringArg(args, "reason", "prompt", "description") || "scheduled wakeup";
	return `${theme.fg("accent", delay)}${theme.fg("dim", " · ")}${theme.fg("muted", oneLine(reason, 56))}`;
}

function summarizeGenericCall(name: string, args: any, theme: any): string {
	if (isMcpToolName(name)) {
		const parts = name.split("__").filter(Boolean);
		const label = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join("/")}` : humanizeToolName(name);
		const arg = stringArg(args, "path", "file_path", "query", "url", "name", "prompt", "description");
		return arg ? `${theme.fg("accent", label)} ${theme.fg("muted", oneLine(arg, 48))}` : theme.fg("accent", label);
	}
	switch (name) {
		case "webfetch":
		case "web_fetch":
		case "fetch_content": {
			const url = stringArg(args, "url") || stringArrayArg(args, "urls")[0] || "fetch";
			return theme.fg("accent", oneLine(url, 72));
		}
		case "web_search":
		case "code_search": return theme.fg("accent", oneLine(stringArg(args, "query") || stringArrayArg(args, "queries")[0] || "search", 72));
		case "Agent": return theme.fg("accent", oneLine(stringArg(args, "description", "prompt") || "launch agent", 72));
		case "TaskCreate": return theme.fg("accent", oneLine(stringArg(args, "subject", "description") || "create task", 72));
		case "TaskGet":
		case "TaskUpdate":
		case "TaskOutput":
		case "TaskStop": return theme.fg("accent", stringArg(args, "taskId", "task_id") || "task");
		case "TaskList": return theme.fg("muted", "task list");
		case "TaskExecute": {
			const ids = stringArrayArg(args, "taskIds", "task_ids");
			return ids.length <= 1 ? theme.fg("accent", ids[0] ?? "start tasks") : `${theme.fg("accent", ids[0]!)}${theme.fg("muted", ` +${ids.length - 1} tasks`)}`;
		}
		case "ScheduleWakeup": return summarizeScheduleWakeupCall(args, theme);
		default: return theme.fg("accent", oneLine(stringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") || humanizeToolName(name), 72));
	}
}

function renderGenericToolCall(name: string, args: any, theme: any, context: any): TruncatedLines {
	return makeTruncatedLines(`${genericStatusPrefix(context, theme)}${toolLabel(theme, `${humanizeToolName(name)} `)}${summarizeGenericCall(name, args, theme)}`);
}

function summarizeUnknownToolCall(name: string, args: any, theme: any): string {
	if (name === "ScheduleWakeup") return summarizeScheduleWakeupCall(args, theme);
	return summarizeGenericCall(name, args, theme);
}

function unknownToolStatus(name: string, raw: string, isError: boolean, theme: any): string {
	if (!isError) return theme.fg("success", "done");
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (/not found/i.test(raw) || new RegExp(`\\b${escapedName}\\b.*not found`, "i").test(raw)) return theme.fg("error", "x not found");
	return theme.fg("error", "x error");
}

function renderUnknownToolCall(name: string, args: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (context?.executionStarted) return makeEmpty();
	return makeTruncatedLines(`${genericStatusPrefix(context, theme)}${toolLabel(theme, `${humanizeToolName(name)} `)}${summarizeUnknownToolCall(name, args, theme)}`);
}

function renderUnknownToolResult(name: string, result: any, { expanded, isPartial }: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (isPartial) return makeEmpty();
	clearBlink(context);
	const raw = textContent(result).trim();
	const args = context?.args ?? {};
	const status = unknownToolStatus(name, raw, Boolean(context?.isError), theme);
	let text = `${stackPrefix(theme)}${toolLabel(theme, `${humanizeToolName(name)} `)}${summarizeUnknownToolCall(name, args, theme)}${theme.fg("dim", " · ")}${status}`;
	if (!expanded) return makeTruncatedLines(`${text}${theme.fg("dim", " · Ctrl+O to expand")}`);
	const json = JSON.stringify(args, null, 2).split(/\r?\n/);
	text += `\n${treeConnector(theme, raw ? "├" : "└", context?.cwd)}${theme.fg("muted", "args")}`;
	text += `\n${json.map((line) => `${treeStem(theme, raw ? "├" : "└", context?.cwd)}${theme.fg("dim", clipLine(line, context?.cwd))}`).join("\n")}`;
	if (raw) {
		const lines = raw.split(/\r?\n/);
		text += `\n${treeConnector(theme, "└", context?.cwd)}${theme.fg(context?.isError ? "error" : "muted", clipLine(lines[0] ?? raw, context?.cwd))}`;
		for (const line of lines.slice(1, 8)) text += `\n${treeStem(theme, "└", context?.cwd)}${theme.fg("dim", clipLine(line, context?.cwd))}`;
		if (lines.length > 8) text += `\n${treeStem(theme, "└", context?.cwd)}${theme.fg("muted", `… ${lines.length - 8} more line(s)`)}`;
	}
	return makeTruncatedLines(text);
}

function renderScheduleWakeupCall(args: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	return renderUnknownToolCall("ScheduleWakeup", args, theme, context);
}

function renderScheduleWakeupResult(result: any, { expanded, isPartial }: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	return renderUnknownToolResult("ScheduleWakeup", result, { expanded, isPartial }, theme, context);
}

function renderGenericToolResult(name: string, result: any, { expanded, isPartial }: any, theme: any, context: any): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (isPartial) return renderPendingDetail(`${humanizeToolName(name)}…`, theme);
	clearBlink(context);
	const raw = textContent(result).trim();
	const lines = raw ? raw.split(/\r?\n/) : [];
	const mode = isMcpToolName(name) ? mcpOutputMode(context?.cwd) : "preview";
	if (mode === "hidden") return makeEmpty();
	if (context?.isError) {
		const first = lines[0] || `${humanizeToolName(name)} failed`;
		return makeTruncatedLines(`${treeConnector(theme, "└")}${theme.fg("error", first)}`);
	}
	if (lines.length === 0) return makeTruncatedLines(`${treeConnector(theme, "└")}${theme.fg("success", "done")}`);
	if (lines.length === 1) return makeTruncatedLines(`${treeConnector(theme, "└")}${theme.fg("muted", oneLine(lines[0]!, 120))}`);
	let text = `${treeConnector(theme, "└")}${theme.fg("success", `${lines.length} lines returned`)}`;
	if (mode === "preview" && expanded) {
		const limit = Math.max(1, Math.floor(settingNumber(isMcpToolName(name) ? "mcpPreviewLines" : "searchPreviewLines", 80, context?.cwd)));
		text += `\n${lines.slice(0, limit).map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", clipLine(line, context?.cwd))}`).join("\n")}`;
		if (lines.length > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${lines.length - limit} more line(s)`)}`;
	} else if (mode === "preview") {
		text += theme.fg("dim", " · Ctrl+O to expand");
	}
	return makeTruncatedLines(text);
}

function installToolExecutionRendererPatch(pi: ExtensionAPI): void {
	const proto = ToolExecutionComponent?.prototype as any;
	if (!proto) return;
	const existing = proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] as { originalGetCallRenderer?: unknown; originalGetRenderShell?: unknown; originalGetResultRenderer?: unknown; originalHasRendererDefinition?: unknown; originalRender?: unknown } | undefined;
	const originalGetCallRenderer = existing?.originalGetCallRenderer ?? proto.getCallRenderer;
	const originalGetResultRenderer = existing?.originalGetResultRenderer ?? proto.getResultRenderer;
	const originalHasRendererDefinition = existing?.originalHasRendererDefinition ?? proto.hasRendererDefinition;
	const originalGetRenderShell = existing?.originalGetRenderShell ?? proto.getRenderShell;
	const originalRender = existing?.originalRender ?? proto.render;
	if (typeof originalGetCallRenderer !== "function" || typeof originalGetResultRenderer !== "function" || typeof originalHasRendererDefinition !== "function" || typeof originalGetRenderShell !== "function" || typeof originalRender !== "function") return;
	const state = { originalGetCallRenderer, originalGetRenderShell, originalGetResultRenderer, originalHasRendererDefinition, originalRender };
	proto.render = function patchedToolExecutionRender(this: any, width: number): string[] {
		const rendered = originalRender.call(this, width);
		if (!Array.isArray(rendered) || typeof this?.toolName !== "string" || typeof this?.toolCallId !== "string") return rendered;
		return trimOuterBlankLines(rendered);
	};
	proto.hasRendererDefinition = function patchedHasRendererDefinition(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) return true;
		return originalHasRendererDefinition.call(this);
	};
	proto.getRenderShell = function patchedGetRenderShell(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) return "self";
		return originalGetRenderShell.call(this);
	};
	proto.getCallRenderer = function patchedGetCallRenderer(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) {
			return (args: any, theme: any, context: any) => renderUnknownToolCall(toolName, args, theme, context);
		}
		if (toolName === "apply_patch" && settingBoolean("applyPatchRenderer", true) && !componentDefinesRenderer(this, "renderCall")) {
			return (args: any, theme: any, context: any) => renderApplyPatchCall(args, theme, context);
		}
		if (settingBoolean("genericToolRenderers", true) && shouldUseGenericRenderer(toolName) && !componentDefinesRenderer(this, "renderCall")) {
			return (args: any, theme: any, context: any) => renderGenericToolCall(toolName, args, theme, context);
		}
		return originalGetCallRenderer.call(this);
	};
	proto.getResultRenderer = function patchedGetResultRenderer(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) {
			return (result: any, options: any, theme: any, context: any) => renderUnknownToolResult(toolName, result, options, theme, context);
		}
		if (toolName === "apply_patch" && settingBoolean("applyPatchRenderer", true) && !componentDefinesRenderer(this, "renderResult")) {
			return (result: any, options: any, theme: any, context: any) => renderApplyPatchResult(result, options, theme, context);
		}
		if (settingBoolean("genericToolRenderers", true) && shouldUseGenericRenderer(toolName) && !componentDefinesRenderer(this, "renderResult")) {
			return (result: any, options: any, theme: any, context: any) => renderGenericToolResult(toolName, result, options, theme, context);
		}
		return originalGetResultRenderer.call(this);
	};
	proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] = state;
	pi.on("session_shutdown", () => {
		if (proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] !== state) return;
		proto.render = originalRender;
		proto.hasRendererDefinition = originalHasRendererDefinition;
		proto.getRenderShell = originalGetRenderShell;
		proto.getCallRenderer = originalGetCallRenderer;
		proto.getResultRenderer = originalGetResultRenderer;
		delete proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL];
	});
}

function applyToolChromeTheme(theme: any, cwd?: string): void {
	if (toolChromeMode(cwd) === "off") return;
	const transparent = "\x1b[49m";
	try {
		if (theme?.bgColors instanceof Map) {
			theme.bgColors.set("toolPendingBg", transparent);
			theme.bgColors.set("toolSuccessBg", transparent);
			theme.bgColors.set("toolErrorBg", transparent);
		} else if (theme?.bgColors && typeof theme.bgColors === "object") {
			theme.bgColors.toolPendingBg = transparent;
			theme.bgColors.toolSuccessBg = transparent;
			theme.bgColors.toolErrorBg = transparent;
		}
	} catch {
		// Best-effort theme patch only.
	}
}

let activeToolChromeCtx: ExtensionContext | undefined;

function mutedHorizontalRule(theme: any, width: number): string {
	const rule = "─".repeat(Math.max(1, width));
	for (const token of ["borderMuted", "muted"] as const) {
		try {
			const styled = theme?.fg?.(token, rule);
			if (typeof styled === "string" && styled !== rule) return styled;
		} catch {
			// Try the next token/fallback below.
		}
	}
	return `\x1b[90m${rule}\x1b[39m`;
}

function shouldOmitBottomToolChromeRule(core: string[]): boolean {
	return core.some((line) => /└─+(?:┴─+)?┘/.test(stripAnsi(line ?? "")));
}

function installToolChromePatch(): void {
	const proto = Container?.prototype as any;
	if (!proto || proto[TOOL_CHROME_PATCH_SYMBOL]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto.render = function patchedToolChromeRender(this: any, width: number): string[] {
		const rendered = originalRender.call(this, width);
		if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
		if (typeof this?.toolName !== "string" || typeof this?.toolCallId !== "string") return rendered;
		const mode = toolChromeMode(this?.cwd ?? process.cwd());
		if (mode === "off") return rendered;
		let start = 0;
		while (start < rendered.length && stripAnsi(rendered[start] ?? "").trim().length === 0) start++;
		let end = rendered.length - 1;
		while (end >= start && stripAnsi(rendered[end] ?? "").trim().length === 0) end--;
		if (start > end) return rendered;
		const core = rendered.slice(start, end + 1).map((line) => truncateToWidth(line, Math.max(1, width), ""));
		if (mode === "transparent") return core;
		const activeTheme = this?.ui?.theme ?? (activeToolChromeCtx?.hasUI ? activeToolChromeCtx.ui.theme : undefined);
		const rule = mutedHorizontalRule(activeTheme, width);
		return shouldOmitBottomToolChromeRule(core) ? [rule, ...core] : [rule, ...core, rule];
	};
	proto[TOOL_CHROME_PATCH_SYMBOL] = true;
}

function registerToolChromeEvents(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		activeToolChromeCtx = ctx;
		if (ctx.hasUI) applyToolChromeTheme(ctx.ui.theme, ctx.cwd);
	});
	pi.on("turn_start", (_event, ctx) => {
		activeToolChromeCtx = ctx;
		if (ctx.hasUI) applyToolChromeTheme(ctx.ui.theme, ctx.cwd);
	});
	pi.on("session_shutdown", () => {
		activeToolChromeCtx = undefined;
	});
}

function installWorkingIndicator(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const mode = settingEnum("workingIndicator", ["default", "pulse", "hidden"] as const, "default", ctx.cwd);
		if (mode === "default") return;
		if (mode === "hidden") {
			ctx.ui.setWorkingIndicator({ frames: [] });
			return;
		}
		ctx.ui.setWorkingIndicator({
			frames: [ctx.ui.theme.fg("dim", "·"), ctx.ui.theme.fg("muted", "•"), ctx.ui.theme.fg("accent", "●"), ctx.ui.theme.fg("muted", "•")],
			intervalMs: 120,
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingIndicator();
	});
}

function installWorkingLoaderAlignmentPatch(): void {
	const proto = Loader.prototype as unknown as Record<PropertyKey, any>;
	if (proto[WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto[WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL] = true;
	proto.render = function patchedWorkingLoaderRender(this: any, width: number): string[] {
		const message = typeof this?.message === "string" ? this.message : "";
		if (!message.startsWith("Working...")) return originalRender.call(this, width);
		const originalPaddingX = this.paddingX;
		try {
			this.paddingX = 0;
			this.invalidate?.();
			return originalRender.call(this, width);
		} finally {
			this.paddingX = originalPaddingX;
			this.invalidate?.();
		}
	};
}

function registerRead(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "read");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "read",
		label: "read",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "read").execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any, context: any) {
			return renderPendingCall(readCallText(args ?? {}, theme), theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult("read", result, isPartial, expanded, theme, context, cwd);
			const call = readCallText(context?.args ?? {}, theme);
			if (isPartial) return renderPendingDetail("reading…", theme);
			clearBlink(context);
			const content = textContent(result);
			const count = lineCount(content);
			let summary = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			const mode = readOutputMode(context?.cwd ?? cwd);
			if (mode === "hidden") return makeEmpty();
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (mode === "preview" && expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, context?.cwd)));
				text += `\n${preview(content, limit, "head", context?.cwd)
					.split(/\r?\n/)
					.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} more line(s)`)}`;
			}
			return makeTruncatedLines(text);
		},
	});
}

function registerBash(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "bash");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "bash",
		label: "bash",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "bash").execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any, context: any) {
			return renderPendingCall(bashCallText(args ?? {}, theme, context?.cwd ?? cwd), theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult("bash", result, isPartial, expanded, theme, context, cwd);
			const effectiveCwd = context?.cwd ?? cwd;
			const call = bashCallText(context?.args ?? {}, theme, effectiveCwd);
			const output = textContent(result);
			if (isPartial) {
				const trimmedOutput = output.trim();
				const count = trimmedOutput ? output.split(/\r?\n/).filter((line) => line.trim().length > 0).length : 0;
				const lineText = count === 0 ? "starting" : `${count} line${count === 1 ? "" : "s"}`;
				const partialMode = bashOutputMode(effectiveCwd);
				if (partialMode !== "summary" && partialMode !== "hidden" && trimmedOutput) {
					const limit = Math.max(1, Math.floor(settingNumber("bashCollapsedLines", 10, effectiveCwd)));
					const tailLines = preview(output, limit, "tail", effectiveCwd).split(/\r?\n/);
					const hasOverflow = count > limit;
					let partialText = `${treeConnector(theme, "├")}${theme.fg("warning", `running… ${lineText}`)}`;
					for (let i = 0; i < tailLines.length; i++) {
						const isLastTail = i === tailLines.length - 1;
						const connector = treeConnector(theme, isLastTail && !hasOverflow ? "└" : "│");
						partialText += `\n${connector}${theme.fg("dim", tailLines[i] ?? "")}`;
					}
					if (hasOverflow) partialText += `\n${treeConnector(theme, "└")}${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
					return makeTruncatedLines(partialText);
				}
				return renderPendingDetail(`running… ${lineText}`, theme);
			}
			clearBlink(context);
			const exit = commandExit(output);
			const count = lineCount(output);
			const exitLabel = exit === null ? "exit 0" : `exit ${exit}`;
			let summary = exit !== null && exit !== 0 ? theme.fg("error", exitLabel) : theme.fg("success", exitLabel);
			summary += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			const mode = bashOutputMode(effectiveCwd);
			if (mode === "hidden") return makeEmpty();
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			const renderDiffs = shouldRenderBashDiffsForCommand(context?.args ?? {}, effectiveCwd);
			const suppressDiffOutput = output ? suppressReadOnlyBashDiffOutput(context?.args ?? {}, output, effectiveCwd) : false;
			const diffPreview = output && mode !== "summary" ? renderBashDiffOutput(output, theme, expanded, effectiveCwd, renderDiffs) : null;
			if (diffPreview) {
				text += `\n${diffPreview}`;
			} else if (!suppressDiffOutput && mode === "preview" && output) {
				const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashCollapsedLines", expanded ? 80 : 10, effectiveCwd)));
				text += `\n${preview(output, limit, "tail", effectiveCwd)
					.split(/\r?\n/)
					.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
			} else if (!suppressDiffOutput && mode === "opencode" && expanded && output) {
				const limit = Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, effectiveCwd)));
				text += `\n${preview(output, limit, "tail", effectiveCwd)
					.split(/\r?\n/)
					.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
			}
			return makeTruncatedLines(text);
		},
	});
}

function registerEdit(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "edit");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "edit",
		label: "edit",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const targetPath = params?.path ?? params?.file_path;
			const before = readTextForDiff(targetPath, effectiveCwd);
			const result = await getBuiltInTool(agent, effectiveCwd, "edit").execute(id, params, signal, onUpdate);
			const after = result?.isError ? before : readTextForDiff(targetPath, effectiveCwd);
			return attachDiffDetails(result, before, after, typeof targetPath === "string" ? targetPath : undefined);
		},
		renderCall(args: any, theme: any, context: any) {
			const effectiveCwd = context?.cwd ?? cwd;
			const targetPath = args?.path ?? args?.file_path ?? "";
			if (context?.argsComplete) {
				const diffs = editOperationsFromArgs(args).map((edit) => ({ ...buildStructuredDiff(edit.oldText, edit.newText), path: targetPath }));
				const previewComponent = renderMutationCallPreview("Edit", String(targetPath), diffs, theme, context, effectiveCwd);
				if (componentHasVisibleLines(previewComponent)) return previewComponent;
			}
			return renderPendingCall(`${toolLabel(theme, "Edit ")}${theme.fg("accent", targetPath)}`, theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const args = context?.args ?? {};
			const targetPath = args.path ?? args.file_path ?? "";
			const call = `${toolLabel(theme, "Edit ")}${theme.fg("accent", targetPath)}`;
			if (isPartial) return renderPendingDetail("editing…", theme);
			clearBlink(context);
			const structured = result?.details?.vstackDiff as StructuredDiff | undefined;
			if (context?.isError || result?.isError) {
				const errorText = textContent(result).split(/\r?\n/)[0] || "edit failed";
				return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("error", errorText)}`);
			}
			const summary = structured ? diffSummary(structured, theme, context?.cwd ?? cwd) : theme.fg("success", "applied");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (structured) text += `\n${renderStructuredDiff(structured, theme, expanded, context?.cwd ?? cwd, undefined, targetPath)}`;
			return makeTruncatedLines(text);
		},
	});
}

function registerWrite(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "write");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "write",
		label: "write",
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const targetPath = params?.path ?? params?.file_path;
			const before = readTextForDiff(targetPath, effectiveCwd);
			const result = await getBuiltInTool(agent, effectiveCwd, "write").execute(id, params, signal, onUpdate);
			const after = result?.isError ? before : typeof params?.content === "string" ? params.content : readTextForDiff(targetPath, effectiveCwd);
			return attachDiffDetails(result, before, after, typeof targetPath === "string" ? targetPath : undefined);
		},
		renderCall(args: any, theme: any, context: any) {
			const effectiveCwd = context?.cwd ?? cwd;
			const targetPath = args?.path ?? args?.file_path ?? "";
			const lineTotal = lineCount(args?.content ?? "");
			if (context?.argsComplete && typeof args?.content === "string") {
				const before = existingSmallTextOrUndefined(String(targetPath), effectiveCwd);
				const label: "Write" | "Create" = before === undefined ? "Create" : "Write";
				const diff = { ...buildStructuredDiff(before ?? "", args.content), path: String(targetPath) };
				const previewComponent = renderMutationCallPreview(label, String(targetPath), [diff], theme, context, effectiveCwd);
				if (componentHasVisibleLines(previewComponent)) return previewComponent;
			}
			return renderPendingCall(`${toolLabel(theme, "Write ")}${theme.fg("accent", targetPath)} ${theme.fg("dim", `· ${lineTotal} lines`)}`, theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const args = context?.args ?? {};
			const targetPath = args.path ?? args.file_path ?? "";
			const lineTotal = lineCount(args.content ?? "");
			const label = result?.details?.vstackDiffWasNewFile ? "Create " : "Write ";
			const call = `${toolLabel(theme, label)}${theme.fg("accent", targetPath)} ${theme.fg("dim", `· ${lineTotal} lines`)}`;
			if (isPartial) return renderPendingDetail("writing…", theme);
			clearBlink(context);
			const structured = result?.details?.vstackDiff as StructuredDiff | undefined;
			if (context?.isError || result?.isError) {
				const errorText = textContent(result).split(/\r?\n/)[0] || "write failed";
				return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("error", errorText)}`);
			}
			const summary = structured ? diffSummary(structured, theme, context?.cwd ?? cwd) : theme.fg("success", "written");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (structured) text += `\n${renderStructuredDiff(structured, theme, expanded, context?.cwd ?? cwd, undefined, targetPath)}`;
			return makeTruncatedLines(text);
		},
	});
}

function registerReadOnly(pi: ExtensionAPI, agent: any, cwd: string, toolName: "grep" | "find" | "ls"): void {
	const original = getBuiltInTool(agent, cwd, toolName);
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: toolName,
		label: toolName,
		description: original.description,
		parameters: original.parameters,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), toolName).execute(id, params, signal, onUpdate);
		},
		renderCall(args: any, theme: any, context: any) {
			return renderPendingCall(readOnlyCallText(toolName, args ?? {}, theme, context?.cwd ?? cwd), theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult(toolName, result, isPartial, expanded, theme, context, cwd);
			const call = readOnlyCallText(toolName, context?.args ?? {}, theme, context?.cwd ?? cwd);
			if (isPartial) return renderPendingDetail(`${toolName}…`, theme);
			clearBlink(context);
			const output = textContent(result);
			const count = output.trim() ? lineCount(output) : 0;
			const noun = toolName === "grep" ? "match" : toolName === "ls" ? "entr" : "file";
			const label = toolName === "ls" ? `${count} ${noun}${count === 1 ? "y" : "ies"}` : `${count} ${noun}${count === 1 ? "" : "s"}`;
			let summary = count === 0 ? theme.fg("muted", toolName === "grep" ? "no matches" : toolName === "ls" ? "empty" : "no files") : theme.fg("success", label);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			const mode = searchOutputMode(context?.cwd ?? cwd);
			if (mode === "hidden") return makeEmpty();
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (mode === "preview" && expanded && output) {
				if (toolName === "find" || toolName === "ls") {
					text += `\n${renderPathListPreview(output, toolName, theme, expanded, context?.cwd)}`;
				} else {
					const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, context?.cwd)));
					text += `\n${preview(output, limit, "head", context?.cwd)
						.split(/\r?\n/)
						.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
						.join("\n")}`;
					if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} more result line(s)`)}`;
				}
			}
			return makeTruncatedLines(text);
		},
	});
}

export default async function toolRenderer(pi: ExtensionAPI): Promise<void> {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	registerStackEvents(pi);
	installToolExecutionRendererPatch(pi);
	installToolChromePatch();
	registerToolChromeEvents(pi);
	installWorkingLoaderAlignmentPatch();
	installWorkingIndicator(pi);
	installMarkdownCodeBlockRenderer(pi);
	installCompactionSummaryRenderer(pi, CompactionSummaryMessageComponent);

	const agent = await import("@mariozechner/pi-coding-agent");
	installUserMessageRenderer(pi, agent.UserMessageComponent);
	installAssistantMessageRenderer(pi, agent.AssistantMessageComponent);
	installCustomMessageSpacingPatch(pi, (agent as any).CustomMessageComponent);
	installSkillInvocationRenderer(pi, (agent as any).SkillInvocationMessageComponent);
	const cwd = process.cwd();
	registerRead(pi, agent, cwd);
	registerBash(pi, agent, cwd);
	if (settingBoolean("renderMutationTools", false, cwd)) {
		registerEdit(pi, agent, cwd);
		registerWrite(pi, agent, cwd);
	}
	registerReadOnly(pi, agent, cwd, "grep");
	registerReadOnly(pi, agent, cwd, "find");
	registerReadOnly(pi, agent, cwd, "ls");
	if (settingBoolean("registerBatchTool", true, cwd)) registerToolBatch(pi, agent, cwd);
}
