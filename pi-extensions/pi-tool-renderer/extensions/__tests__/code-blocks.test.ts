import { describe, expect, test } from "bun:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { __test } from "../tool-renderer/messages.js";

const ANSI_RE = /\x1b(?:\[[0-9;:]*m|\]133;[ABC]\x07)/g;

const theme = {
	bg(_token: string, text: string) {
		return `\x1b[48;5;236m${text}\x1b[49m`;
	},
	codeBlock(text: string) {
		return text;
	},
	codeBlockBorder(text: string) {
		return text;
	},
	highlightCode(code: string) {
		return code.split("\n");
	},
};

function stripControl(text: string): string {
	return text.replace(ANSI_RE, "");
}

describe("styled markdown code blocks", () => {
	test("render code flush-left with dashed background border but no copy gutter", () => {
		const rendered = __test.renderStyledCodeBlock({ type: "code", lang: "bash", text: "echo hi\nprintf ok" }, 20, theme);

		expect(rendered).toHaveLength(4);
		expect(stripControl(rendered[0]!)).toBe("┄".repeat(19));
		expect(stripControl(rendered[1]!)).toBe("echo hi" + " ".repeat(12));
		expect(stripControl(rendered[2]!)).toBe("printf ok" + " ".repeat(10));
		expect(stripControl(rendered[3]!)).toBe("┄".repeat(19));
		expect(stripControl(rendered[1]!).startsWith(" ")).toBe(false);
		for (const line of rendered) {
			expect(stripControl(line)).not.toContain("┃");
			expect(stripControl(line)).not.toContain("│");
			expect(line).toContain("\x1b[48;5;236m");
			expect(visibleWidth(line)).toBe(19);
		}
	});
});
