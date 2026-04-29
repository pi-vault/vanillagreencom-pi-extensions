import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const STORE_FILE = "prompt-stash.json";
const STORE_VERSION = 1;
const POPUP_WIDTH = 92;
const POPUP_MAX_HEIGHT = "80%";
const LIST_ROWS = 10;
const PADDING_X = 4;
const PADDING_Y = 2;
const INSTALL_SYMBOL = Symbol.for("vstack.prompt-stash.installed");
const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";
const INPUT_BOTTOM_PADDING_LINES = 1;

interface StashItem {
	id: string;
	text: string;
	createdAt: string;
}

interface StashStore {
	version: number;
	items: StashItem[];
}

function projectRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (
			existsSync(join(current, ".git")) ||
			existsSync(join(current, ".vstack-lock.json")) ||
			existsSync(join(current, ".pi")) ||
			existsSync(join(current, ".agents"))
		) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function storePath(ctx: ExtensionContext): string {
	return join(projectRoot(ctx.cwd), ".pi", STORE_FILE);
}

function loadItems(path: string): StashItem[] {
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StashStore>;
		if (!Array.isArray(parsed.items)) return [];
		return parsed.items
			.filter((item): item is StashItem => {
				return Boolean(
					item &&
						typeof item === "object" &&
						typeof (item as StashItem).id === "string" &&
						typeof (item as StashItem).text === "string" &&
						typeof (item as StashItem).createdAt === "string",
				);
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	} catch {
		return [];
	}
}

function saveItems(path: string, items: StashItem[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}`;
	const store: StashStore = { version: STORE_VERSION, items };
	writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	renameSync(tempPath, path);
}

function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stashPrompt(ctx: ExtensionContext, text: string): number {
	const path = storePath(ctx);
	const now = new Date().toISOString();
	const existing = loadItems(path).filter((item) => item.text !== text);
	const items = [{ id: makeId(), text, createdAt: now }, ...existing];
	saveItems(path, items);
	return items.length;
}

function lineCount(text: string): number {
	return Math.max(1, text.split(/\r\n|\r|\n/).length);
}

function previewText(text: string): string {
	const first = text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return first ?? "(empty prompt)";
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function searchable(text: string): string {
	return text.toLowerCase();
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isEditorBorderLine(line: string): boolean {
	const visible = stripAnsi(line).trim();
	return visible.length > 0 && /^[─━╭╮╰╯┌┐└┘]+$/.test(visible);
}

function panelLine(theme: Theme, content: string, width: number): string {
	return theme.bg("customMessageBg", padAnsi(content, width));
}

function selectedLine(theme: Theme, content: string, width: number): string {
	return theme.bg("selectedBg", padAnsi(theme.fg("text", content), width));
}

function renderSearch(query: string, cursor: number, width: number, theme: Theme): string {
	if (query.length === 0) {
		return `${theme.bg("selectedBg", theme.fg("text", "S"))}${theme.fg("dim", "earch")}`;
	}

	const safeCursor = Math.max(0, Math.min(cursor, query.length));
	const before = query.slice(0, safeCursor);
	const char = safeCursor < query.length ? query[safeCursor] : " ";
	const after = safeCursor < query.length ? query.slice(safeCursor + 1) : "";
	return truncateToWidth(`${before}${theme.bg("selectedBg", theme.fg("text", char))}${after}`, width, "");
}

function filterItems(items: StashItem[], query: string): StashItem[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return items;
	return items.filter((item) => searchable(item.text).includes(trimmed));
}

async function openStashPopup(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const path = storePath(ctx);
	let items = loadItems(path);
	if (items.length === 0) {
		ctx.ui.notify("Prompt stash is empty", "info");
		return;
	}

	const popped = await ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			let query = "";
			let searchCursor = 0;
			let selected = 0;
			let scroll = 0;
			let confirmDeleteAll = false;

			const filtered = () => filterItems(items, query);
			const clampSelection = () => {
				const count = filtered().length;
				if (count === 0) {
					selected = 0;
					scroll = 0;
					return;
				}
				selected = Math.max(0, Math.min(selected, count - 1));
				if (selected < scroll) scroll = selected;
				if (selected >= scroll + LIST_ROWS) scroll = selected - LIST_ROWS + 1;
				scroll = Math.max(0, Math.min(scroll, Math.max(0, count - LIST_ROWS)));
			};

			const deleteSelected = () => {
				const item = filtered()[selected];
				if (!item) return;
				items = items.filter((candidate) => candidate.id !== item.id);
				saveItems(path, items);
				clampSelection();
				tui.requestRender();
			};

			const clearAll = () => {
				items = [];
				saveItems(path, items);
				confirmDeleteAll = false;
				clampSelection();
				tui.requestRender();
			};

			const popSelected = () => {
				const item = filtered()[selected];
				if (!item) return;
				items = items.filter((candidate) => candidate.id !== item.id);
				saveItems(path, items);
				done(item.text);
			};

			const render = (width: number): string[] => {
				const innerWidth = Math.max(20, width - PADDING_X * 2);
				const results = filtered();
				clampSelection();

				const lines: string[] = [];
				for (let i = 0; i < PADDING_Y; i += 1) lines.push(panelLine(theme, "", width));

				const title = theme.fg("text", theme.bold("Stash"));
				const esc = theme.fg("dim", "esc");
				const titleGap = Math.max(1, innerWidth - visibleWidth("Stash") - visibleWidth("esc"));
				lines.push(panelLine(theme, `${" ".repeat(PADDING_X)}${title}${" ".repeat(titleGap)}${esc}`, width));
				lines.push(panelLine(theme, "", width));
				lines.push(panelLine(theme, `${" ".repeat(PADDING_X)}${renderSearch(query, searchCursor, innerWidth, theme)}`, width));
				lines.push(panelLine(theme, "", width));

				if (results.length === 0) {
					lines.push(panelLine(theme, `${" ".repeat(PADDING_X)}${theme.fg("dim", "No matching stashed prompts")}`, width));
				} else {
					for (const [visibleIndex, item] of results.slice(scroll, scroll + LIST_ROWS).entries()) {
						const index = scroll + visibleIndex;
						const count = lineCount(item.text);
						const countText = `~${count} ${count === 1 ? "line" : "lines"}`;
						const countWidth = visibleWidth(countText);
						const rowWidth = Math.max(1, innerWidth - PADDING_X);
						const previewWidth = Math.max(1, rowWidth - countWidth - 2);
						const preview = truncateToWidth(previewText(item.text), previewWidth, "");
						const row = `${preview}${" ".repeat(Math.max(1, rowWidth - visibleWidth(preview) - countWidth))}${countText}`;
						const content = `${" ".repeat(PADDING_X)}${row}`;
						lines.push(index === selected ? selectedLine(theme, content, width) : panelLine(theme, content, width));
					}
				}

				const emptyRows = Math.max(0, LIST_ROWS - Math.max(1, Math.min(results.length, LIST_ROWS)));
				for (let i = 0; i < emptyRows; i += 1) lines.push(panelLine(theme, "", width));

				lines.push(panelLine(theme, "", width));
				const status = confirmDeleteAll
					? `${theme.fg("warning", "delete all stashed prompts?")} ${theme.fg("text", "y")} ${theme.fg("dim", "/ n")}`
					: `${theme.fg("text", "enter")} ${theme.fg("dim", "pop")}  ${theme.fg("text", "delete")} ${theme.fg("dim", "ctrl+d")}  ${theme.fg("text", "delete all")} ${theme.fg("dim", "ctrl+x")}`;
				lines.push(panelLine(theme, `${" ".repeat(PADDING_X)}${status}`, width));

				for (let i = 0; i < PADDING_Y - 1; i += 1) lines.push(panelLine(theme, "", width));
				return lines.map((line) => truncateToWidth(line, width, ""));
			};

			return {
				handleInput(data: string) {
					if (confirmDeleteAll) {
						if (data === "y" || data === "Y") {
							clearAll();
							return;
						}
						if (data === "n" || data === "N" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							confirmDeleteAll = false;
							tui.requestRender();
							return;
						}
					}

					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(null);
						return;
					}
					if (matchesKey(data, "return") || matchesKey(data, "enter")) {
						popSelected();
						return;
					}
					if (matchesKey(data, "up") || data === "k") {
						selected -= 1;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || data === "j") {
						selected += 1;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageUp")) {
						selected -= LIST_ROWS;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageDown")) {
						selected += LIST_ROWS;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "ctrl+d") || matchesKey(data, "delete")) {
						deleteSelected();
						return;
					}
					if (matchesKey(data, "ctrl+x")) {
						confirmDeleteAll = items.length > 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "left")) {
						searchCursor = Math.max(0, searchCursor - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right")) {
						searchCursor = Math.min(query.length, searchCursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
						searchCursor = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
						searchCursor = query.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "backspace")) {
						if (searchCursor > 0) {
							query = `${query.slice(0, searchCursor - 1)}${query.slice(searchCursor)}`;
							searchCursor -= 1;
							selected = 0;
							clampSelection();
							tui.requestRender();
						}
						return;
					}
					if (matchesKey(data, "ctrl+u")) {
						query = "";
						searchCursor = 0;
						selected = 0;
						clampSelection();
						tui.requestRender();
						return;
					}
					if (isPrintable(data)) {
						query = `${query.slice(0, searchCursor)}${data}${query.slice(searchCursor)}`;
						searchCursor += data.length;
						selected = 0;
						clampSelection();
						tui.requestRender();
					}
				},
				invalidate() {},
				render,
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", maxHeight: POPUP_MAX_HEIGHT, width: POPUP_WIDTH } },
	);

	if (popped != null) {
		ctx.ui.setEditorText(popped);
	}
}

class PromptStashEditor extends CustomEditor {
	private stashOpen = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+s")) {
			void this.toggleStash();
			return;
		}
		super.handleInput(data);
	}

	render(width: number): string[] {
		const prompt = this.borderColor("π");
		const prefix = `${prompt} `;
		const prefixWidth = visibleWidth("π ");
		const continuationPrefix = " ".repeat(prefixWidth);
		const innerWidth = Math.max(1, width - prefixWidth);
		const rendered = super.render(innerWidth);

		const inputLines: string[] = [];
		let completionLines: string[] = [];
		for (let index = 1; index < rendered.length; index += 1) {
			const line = rendered[index] ?? "";
			if (isEditorBorderLine(line)) {
				completionLines = rendered.slice(index + 1);
				break;
			}
			inputLines.push(line);
		}

		const lines = (inputLines.length > 0 ? inputLines : [""]).map((line, index) => {
			const linePrefix = index === 0 ? prefix : continuationPrefix;
			return truncateToWidth(linePrefix + line, width, "");
		});
		for (let index = 0; index < INPUT_BOTTOM_PADDING_LINES; index += 1) lines.push("");
		for (const line of completionLines) {
			lines.push(truncateToWidth(`${DIM}${continuationPrefix}${RESET}${line}`, width, ""));
		}
		return lines;
	}

	private async toggleStash(): Promise<void> {
		if (this.stashOpen) return;
		const text = this.getText();
		if (text.trim().length > 0) {
			const count = stashPrompt(this.ctx, text);
			this.ctx.ui.setEditorText("");
			this.ctx.ui.notify(`Stashed prompt (${count} total)`, "info");
			this.tui.requestRender();
			return;
		}

		this.stashOpen = true;
		try {
			await openStashPopup(this.ctx);
		} finally {
			this.stashOpen = false;
			this.tui.requestRender();
		}
	}
}

export default function promptStash(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptStashEditor(tui, theme, keybindings, ctx));
	});

	pi.registerCommand("prompt-stash", {
		description: "Open the project-local prompt stash popup",
		handler: async (_args, ctx) => openStashPopup(ctx),
	});
}
