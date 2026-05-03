import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { calculateImageRows, getCapabilities, getImageDimensions, getCellDimensions, Image, setCapabilities, Text, type Component } from "@mariozechner/pi-tui";
import { hasOpenAiModelsLoaded } from "./activation.js";
import { computeNextActiveTools, computeToolCapabilities, modelKey, PACKAGE_TOOL_NAMES, type ModelLike } from "./capabilities.js";
import { rewriteNativeOpenAiTools } from "./provider-native-tools.js";
import { loadSettings, settingsDiagnostics } from "./settings.js";
import { createApplyPatchToolDefinition } from "./tools/apply-patch.js";
import { createImageGenerationToolDefinition } from "./tools/image-generation.js";
import { viewImage, viewImageToolSchema, type ValidatedImage, type ViewImageInput } from "./tools/view-image.js";
import { createWebSearchToolDefinition } from "./tools/web-search.js";
import { renderTmuxKittyPlaceholderImage, wrapKittyGraphicsForTmux } from "./terminal-image-rendering.js";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-codex-minimal-tools.installed");
let tmuxClientTermCacheKey: string | undefined;
let tmuxClientTermCacheValue = "";

function terminalImageProtocol(): "kitty" | "iterm2" | null {
	const caps = getCapabilities();
	if (caps.images) return caps.images;
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const tmuxClientTerm = process.env.TMUX ? (() => {
		const cacheKey = `${process.env.TMUX}|${process.env.TMUX_PANE ?? ""}`;
		if (tmuxClientTermCacheKey === cacheKey) return tmuxClientTermCacheValue;
		try {
			const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
			tmuxClientTermCacheKey = cacheKey;
			tmuxClientTermCacheValue = execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase();
			return tmuxClientTermCacheValue;
		} catch {
			tmuxClientTermCacheKey = cacheKey;
			tmuxClientTermCacheValue = "";
			return "";
		}
	})() : "";
	const outer = `${termProgram} ${term} ${tmuxClientTerm}`;
	if (process.env.KITTY_WINDOW_ID || outer.includes("kitty") || outer.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR || process.env.WEZTERM_PANE || outer.includes("wezterm")) return "kitty";
	if (process.env.ITERM_SESSION_ID || outer.includes("iterm")) return "iterm2";
	return null;
}

function ensureTerminalImageCapability(): "kitty" | "iterm2" | null {
	const protocol = terminalImageProtocol();
	if (!protocol) return null;
	const caps = getCapabilities();
	if (caps.images !== protocol) setCapabilities({ ...caps, images: protocol, hyperlinks: caps.hyperlinks || Boolean(process.env.TMUX) });
	return protocol;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}K`;
	return `${Math.round(bytes / (1024 * 102.4)) / 10}M`;
}

function viewImageCallText(args: ViewImageInput | undefined, theme: any): string {
	const path = typeof args?.path === "string" ? args.path : "image";
	const detail = args?.detail && args.detail !== "auto" ? ` ${theme.fg("dim", `· ${args.detail}`)}` : "";
	return `${theme.fg("accent", "● ")}${theme.fg("text", theme.bold("View Image "))}${theme.fg("accent", path)}${detail}`;
}

function viewImageResultText(details: ValidatedImage | undefined, theme: any): string {
	if (!details) return `${theme.fg("accent", "● ")}${theme.fg("text", theme.bold("View Image"))}${theme.fg("dim", " · image loaded")}`;
	const type = details.mimeType.replace(/^image\//, "").toUpperCase();
	const protocol = terminalImageProtocol();
	const preview = protocol ? theme.fg("success", `inline ${protocol}`) : theme.fg("warning", "fallback");
	return `${theme.fg("accent", "● ")}${theme.fg("text", theme.bold("View Image "))}${theme.fg("accent", details.displayPath)}${theme.fg("dim", " · ")}${theme.fg("success", type)}${theme.fg("dim", ` · ${formatBytes(details.sizeBytes)} · `)}${preview}`;
}

function emptyComponent(): Component {
	return { invalidate() {}, render: () => [] };
}

function textComponent(text: string): Component {
	return new Text(text, 0, 0);
}

function tmuxKittyImageComponent(base64Data: string, mimeType: string, details: ValidatedImage | undefined, maxWidthCells: number, maxHeightCells: number, theme: any): Component {
	const dimensions = getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
	const imageId = Math.floor(Math.random() * 0xffffffff) + 1;
	let cachedLines: string[] | undefined;
	let cachedWidth = 0;
	return {
		invalidate() {
			cachedLines = undefined;
			cachedWidth = 0;
		},
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const columns = Math.max(1, Math.min(width - 2, maxWidthCells));
			const rows = Math.max(1, Math.min(maxHeightCells, calculateImageRows(dimensions, columns, getCellDimensions())));
			try {
				cachedLines = renderTmuxKittyPlaceholderImage(base64Data, { columns, rows, imageId });
			} catch {
				cachedLines = [theme.fg("dim", `[Image: ${details?.displayPath ?? mimeType} ${dimensions.widthPx}x${dimensions.heightPx}]`)];
			}
			cachedWidth = width;
			return cachedLines;
		},
	};
}

function viewImageResultComponent(result: any, options: any, theme: any, context: any): Component {
	if (options?.isPartial) return emptyComponent();
	const details = result?.details as ValidatedImage | undefined;
	const imagePart = result?.content?.find?.((part: any) => part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string");
	const header = textComponent(viewImageResultText(details, theme));
	if (!imagePart) return header;
	const protocol = ensureTerminalImageCapability();
	const imageTheme = { fallbackColor: (text: string) => theme.fg("dim", text) };
	const maxHeightCells = options?.expanded ? 28 : 18;
	const image = process.env.TMUX && protocol === "kitty"
		? tmuxKittyImageComponent(imagePart.data, imagePart.mimeType, details, 80, maxHeightCells, theme)
		: new Image(imagePart.data, imagePart.mimeType, imageTheme, { maxWidthCells: 80, maxHeightCells, filename: details?.displayPath });
	return {
		invalidate() {
			header.invalidate();
			image.invalidate();
		},
		render(width: number): string[] {
			return [...header.render(width), ...image.render(width).map(wrapKittyGraphicsForTmux)];
		},
	};
}

function contextModel(ctx: ExtensionContext): ModelLike | undefined {
	return ctx.model as ModelLike | undefined;
}

function removePackageToolsIfPresent(pi: ExtensionAPI): void {
	const active = pi.getActiveTools?.() ?? [];
	const next = active.filter((name) => !PACKAGE_TOOL_NAMES.includes(name as never));
	if (next.length !== active.length) pi.setActiveTools(next);
}

function syncActiveTools(pi: ExtensionAPI, ctx: ExtensionContext, toolsRegistered: boolean): void {
	if (!toolsRegistered || !hasOpenAiModelsLoaded(ctx)) {
		removePackageToolsIfPresent(pi);
		return;
	}
	const settings = loadSettings(ctx.cwd);
	const active = pi.getActiveTools?.() ?? [];
	const next = computeNextActiveTools(active, contextModel(ctx), settings);
	if (next.activeTools.join("\0") !== active.join("\0")) pi.setActiveTools(next.activeTools);
}

function statusLines(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const settings = loadSettings(ctx.cwd);
	const model = contextModel(ctx);
	const capabilities = computeToolCapabilities(model, settings);
	const active = new Set(pi.getActiveTools?.() ?? []);
	return [
		"Codex Minimal Tools",
		`model: ${modelKey(model)}`,
		`openai models loaded: ${hasOpenAiModelsLoaded(ctx)}`,
		`enabled: ${settings.enabled}`,
		`autoEnable: ${settings.autoEnable}`,
		`nativeProviderTools: ${settings.nativeProviderTools}`,
		"tools:",
		...Object.entries(capabilities).map(([name, capability]) => `- ${name}: ${capability.enabled ? "supported" : "disabled"}${active.has(name) ? ", active" : ""} — ${capability.reason}`),
	];
}

function registerDiagnosticCommand(pi: ExtensionAPI): void {
	pi.registerCommand("codex-minimal-tools", {
		description: "Show Codex Minimal Tools status and diagnostics.",
		getArgumentCompletions(prefix: string) {
			const items = [
				{ value: "doctor", label: "doctor", description: "Run lightweight self-checks" },
				{ value: "settings", label: "settings", description: "Explain extension-manager settings location" },
			];
			const query = prefix.trim().toLowerCase();
			const filtered = items.filter((item) => item.value.startsWith(query));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx) => {
			const subcommand = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
			if (subcommand === "settings") {
				ctx.ui.notify("Codex Minimal Tools settings are under /extensions or /extensions settings when pi-extension-manager is installed. Config key: vstack.extensionManager.config[\"pi-codex-minimal-tools\"].", "info");
				return;
			}
			if (subcommand === "doctor") {
				const settings = loadSettings(ctx.cwd);
				const lines = statusLines(pi, ctx);
				lines.push(`image output dir: ${settings.imageOutputDir}`);
				lines.push(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "present" : "not set"}`);
				const diagnostics = settingsDiagnostics(ctx.cwd);
				if (diagnostics.length > 0) lines.push("settings diagnostics:", ...diagnostics.map((line) => `- ${line}`));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			ctx.ui.notify(statusLines(pi, ctx).join("\n"), "info");
		},
	});
}

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool(createImageGenerationToolDefinition({ loadSettings }) as never);
	pi.registerTool(createWebSearchToolDefinition() as never);
	pi.registerTool({
		renderShell: "self",
		name: "view_image",
		label: "View Image",
		description: "Inspect a local image file by returning image content to the model. Relative paths resolve against ctx.cwd; a leading @ is accepted.",
		promptSnippet: "Inspect local image files by path.",
		promptGuidelines: ["Use view_image when you need to inspect a local image file; pass the path in the path argument."],
		parameters: viewImageToolSchema,
		async execute(_toolCallId: string, params: ViewImageInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			return viewImage(params, ctx.cwd) as never;
		},
		renderCall(args: ViewImageInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			return textComponent(viewImageCallText(args, theme));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			return viewImageResultComponent(result, options, theme, context);
		},
	} as never);
	pi.registerTool(createApplyPatchToolDefinition({
		allowAbsolutePaths: (cwd) => loadSettings(cwd).allowAbsolutePatchPaths,
		deferRendering: loadSettings().deferApplyPatchRendering,
	}) as never);
}

export default function codexMinimalTools(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let toolsRegistered = false;
	const ensureToolsRegistered = (ctx: ExtensionContext): boolean => {
		if (toolsRegistered) return true;
		const settings = loadSettings(ctx.cwd);
		if (!settings.enabled || !hasOpenAiModelsLoaded(ctx)) return false;
		registerTools(pi);
		toolsRegistered = true;
		return true;
	};

	registerDiagnosticCommand(pi);

	pi.on("session_start", async (_event, ctx) => syncActiveTools(pi, ctx, ensureToolsRegistered(ctx)));
	pi.on("model_select", async (_event, ctx) => syncActiveTools(pi, ctx, ensureToolsRegistered(ctx)));
	pi.on("thinking_level_select", async (_event, ctx) => syncActiveTools(pi, ctx, ensureToolsRegistered(ctx)));

	pi.on("before_provider_request", (event, ctx) => {
		const settings = loadSettings(ctx.cwd);
		if (!settings.enabled || !settings.nativeProviderTools || !hasOpenAiModelsLoaded(ctx) || contextModel(ctx)?.provider !== "openai-codex") return undefined;
		const result = rewriteNativeOpenAiTools(event.payload, { webSearchExternalAccess: settings.webSearchExternalAccess });
		return result.rewritten.length > 0 ? result.payload : undefined;
	});
}
