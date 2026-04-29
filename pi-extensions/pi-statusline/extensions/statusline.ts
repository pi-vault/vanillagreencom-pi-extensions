/**
 * Claude-style status line + single-line prompt for pi.
 *
 * Auto-loaded from ~/.pi/agent/extensions/statusline/index.ts.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const DIM = "\x1b[38;5;8m";
const RESET = "\x1b[0m";
const INPUT_BOTTOM_PADDING_LINES = 1;

interface GitState {
	projectName: string;
	branch?: string;
	dirty: boolean;
	inLinkedWorktree: boolean;
}

function basename(input: string): string {
	return input.replace(/\/$/, "").split("/").filter(Boolean).pop() ?? input;
}

function repoNameFromRemote(remote: string): string | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	const match = trimmed.match(/([^/:]+)$/);
	return match?.[1];
}

function formatModel(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const model = ctx.model;
	if (!model) return `no model / ${pi.getThinkingLevel()}`;

	let name = model.name || model.id;
	name = name.replace(/^Claude\s+/i, "");
	name = name.replace(/^claude[-_]/i, "");
	name = name.replace(/[-_](20\d{6}|latest)$/i, "");
	name = name.replace(/^gpt[-_]/i, "GPT ");
	name = name.replace(/[-_]/g, " ");
	name = name.replace(/\bopus\b/i, "Opus");
	name = name.replace(/\bsonnet\b/i, "Sonnet");
	name = name.replace(/\bhaiku\b/i, "Haiku");
	name = name.replace(/\s+/g, " ").trim();

	// Humanize common Claude ids like opus 4 5 -> Opus 4.5.
	name = name.replace(/\b(Opus|Sonnet|Haiku) (\d) (\d)\b/, "$1 $2.$3");
	return `${name} / ${pi.getThinkingLevel()}`;
}

function formatWindow(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "?";
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		const value = tokens / 1_000;
		return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
	}
	return `${tokens}`;
}

function contextInfo(ctx: ExtensionContext): { label: string; percent: number | null } {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (typeof usage?.percent !== "number") {
		return { label: formatWindow(contextWindow), percent: null };
	}

	const usedPercent = Math.max(0, Math.min(100, Math.round(usage.percent)));
	return { label: formatWindow(contextWindow), percent: 100 - usedPercent };
}

function gitBadge(state: GitState): string {
	if (!state.branch) return "";
	const icon = state.inLinkedWorktree || state.branch !== "main" ? `🌳 ${state.branch}` : "🦀";
	return ` (${icon}${state.dirty ? "*" : ""})`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isEditorBorderLine(line: string): boolean {
	const visible = stripAnsi(line).trim();
	return visible.length > 0 && /^[─━╭╮╰╯┌┐└┘]+$/.test(visible);
}

function makeFallbackGitState(cwd: string): GitState {
	return {
		projectName: basename(cwd),
		dirty: false,
		inLinkedWorktree: false,
	};
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 1500 });
		if (result.code !== 0) return undefined;
		const stdout = result.stdout.trim();
		return stdout.length > 0 ? stdout : undefined;
	} catch {
		return undefined;
	}
}

async function refreshGitState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GitState> {
	const cwd = ctx.cwd;
	const topLevel = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!topLevel) return makeFallbackGitState(cwd);

	const [remote, worktreesRaw, branchRaw, shortHead, diffExit] = await Promise.all([
		runGit(pi, cwd, ["remote", "get-url", "origin"]),
		runGit(pi, cwd, ["worktree", "list", "--porcelain"]),
		runGit(pi, cwd, ["branch", "--show-current"]),
		runGit(pi, cwd, ["rev-parse", "--short", "HEAD"]),
		pi.exec("git", ["-C", cwd, "diff-index", "--quiet", "HEAD", "--"], { timeout: 1500 })
			.then((result) => result.code)
			.catch(() => 0),
	]);

	const firstWorktreeLine = worktreesRaw?.split("\n").find((line) => line.startsWith("worktree "));
	const mainWorktree = firstWorktreeLine?.slice("worktree ".length).trim();
	const inLinkedWorktree = Boolean(mainWorktree && mainWorktree !== topLevel);
	const projectName = repoNameFromRemote(remote ?? "") ?? basename(mainWorktree || topLevel);
	const branch = branchRaw || shortHead;

	return {
		projectName,
		branch,
		dirty: diffExit === 1,
		inLinkedWorktree,
	};
}

function renderStatusLine(
	width: number,
	ctx: ExtensionContext,
	git: GitState,
	pi: ExtensionAPI,
	theme: { fg: (color: string, text: string) => string },
): string {
	const { label: contextLabel, percent } = contextInfo(ctx);
	const leftPlain = `${git.projectName}${gitBadge(git)} ${formatModel(ctx, pi)} (${contextLabel})`;
	const rightPlain = percent === null ? "…%" : `${percent}%`;
	const percentColor = percent === null ? "muted" : percent <= 15 ? "error" : percent <= 30 ? "warning" : "success";

	const left = theme.fg("accent", leftPlain);
	const right = theme.fg(percentColor, rightPlain);
	const minimumGap = 1;
	const gapWidth = Math.max(minimumGap, width - visibleWidth(leftPlain) - visibleWidth(rightPlain) - 2);
	const filled = percent === null ? 0 : Math.round(gapWidth * (percent / 100));
	const empty = Math.max(0, gapWidth - filled);
	const bar = " ".repeat(empty) + theme.fg("warning", "─".repeat(filled));

	return truncateToWidth(`${left} ${bar} ${right}`, width, "");
}

class ClaudePromptEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 0 });
	}

	render(width: number): string[] {
		const prompt = this.borderColor("π");
		const prefix = `${prompt} `;
		const prefixWidth = visibleWidth("π ");
		const continuationPrefix = " ".repeat(prefixWidth);
		const innerWidth = Math.max(1, width - prefixWidth);
		const rendered = super.render(innerWidth);

		// CustomEditor renders hidden border rows around the editable content. The
		// bottom border moves down as the editor wraps; keeping a fixed rendered[1]
		// dropped the second visual line and made the border appear only later.
		const inputLines: string[] = [];
		let completionLines: string[] = [];
		for (let index = 1; index < rendered.length; index++) {
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
		for (let index = 0; index < INPUT_BOTTOM_PADDING_LINES; index++) {
			lines.push("");
		}

		// Keep autocomplete visible below the wrapped prompt.
		for (const line of completionLines) {
			lines.push(truncateToWidth(`${DIM}${continuationPrefix}${RESET}${line}`, width, ""));
		}
		return lines;
	}
}

export default function statusline(pi: ExtensionAPI) {
	let activeTui: TUI | undefined;
	let gitState: GitState | undefined;
	let refreshInFlight: Promise<void> | undefined;

	const requestRender = () => activeTui?.requestRender();

	const refresh = (ctx: ExtensionContext) => {
		if (refreshInFlight) return refreshInFlight;
		refreshInFlight = refreshGitState(pi, ctx)
			.then((next) => {
				gitState = next;
				requestRender();
			})
			.finally(() => {
				refreshInFlight = undefined;
			});
		return refreshInFlight;
	};

	pi.on("session_start", (_event, ctx) => {
		gitState = makeFallbackGitState(ctx.cwd);
		void refresh(ctx);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new ClaudePromptEditor(tui, theme, keybindings);
		});

		ctx.ui.setWidget("statusline", (tui, theme) => {
			activeTui = tui;
			return {
				invalidate() {},
				render(width: number): string[] {
					return [renderStatusLine(width, ctx, gitState ?? makeFallbackGitState(ctx.cwd), pi, theme)];
				},
			};
		});

		// Hide pi's built-in footer; our status line lives directly above the input.
		ctx.ui.setFooter((tui, _theme, footerData) => {
			activeTui = tui;
			const unsubscribe = footerData.onBranchChange(() => {
				void refresh(ctx);
				requestRender();
			});

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});
	});

	pi.on("model_select", (_event, ctx) => {
		void refresh(ctx);
		requestRender();
	});
	pi.on("agent_start", (_event, ctx) => {
		void refresh(ctx);
		requestRender();
	});
	pi.on("message_update", () => requestRender());
	pi.on("agent_end", (_event, ctx) => {
		void refresh(ctx);
		requestRender();
	});
	pi.on("session_compact", (_event, ctx) => {
		void refresh(ctx);
		requestRender();
	});
	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});
}
