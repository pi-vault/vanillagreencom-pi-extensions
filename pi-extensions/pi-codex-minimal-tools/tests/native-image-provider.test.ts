import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import { buildWebSearchActivityMessage, renderWebSearchActivityText, saveOpenAICodexGeneratedImage } from "../src/provider-shim.js";

async function* asAsyncIterable(events: any[]) {
	for (const event of events) yield event;
}

function createAssistantOutput() {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
	input: ["text", "image"],
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

test("processResponsesStream preserves completed image_generation_call items for later turns", async () => {
	const output = createAssistantOutput();
	const base64 = Buffer.from("png-bytes").toString("base64");
	const rawImageItem = {
		type: "image_generation_call",
		id: "ig_123",
		status: "completed",
		result: base64,
		output_format: "png",
		revised_prompt: "A tiny red square icon",
		quality: "high",
	};
	const expectedImageItem = {
		type: "image_generation_call",
		id: "ig_123",
		status: "completed",
		result: base64,
		revised_prompt: "A tiny red square icon",
	};

	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "image_generation_call", id: "ig_123", status: "in_progress" } },
			{ type: "response.output_item.done", output_index: 0, item: rawImageItem },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);

	assert.deepEqual(output.content.filter((block: any) => block.type === "image_generation_call"), [
		{ type: "image_generation_call", item: expectedImageItem },
	]);
	assert.deepEqual(convertResponsesMessages(model, { messages: [output] } as any, new Set(["openai-codex"])), [expectedImageItem]);
});

test("processResponsesStream ignores in-progress image_generation_call items", async () => {
	const output = createAssistantOutput();
	await processResponsesStream(
		asAsyncIterable([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "image_generation_call", id: "ig_123", status: "in_progress" } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
		]),
		output,
		{ push() {} } as any,
		model,
	);
	assert.deepEqual(output.content.filter((block: any) => block.type === "image_generation_call"), []);
});

test("native web search activity renders like compact tool output", () => {
	const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
	const searches = [{
		callId: "ws_123",
		status: "completed",
		query: "latest qwen local model",
		queries: [],
		sources: [
			{ title: "Qwen3.6-27B", url: "https://huggingface.co/Qwen/Qwen3.6-27B" },
			{ title: "Qwen3.6-35B-A3B", url: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B" },
		],
	}];

	const text = renderWebSearchActivityText(searches as any, false, theme);
	assert.match(text, /^● Web Search \(OpenAI Native\) latest qwen local model · 2 sources/);
	assert.match(text, /├─ Qwen3\.6-27B · https:\/\/huggingface\.co\/Qwen\/Qwen3\.6-27B/);
	assert.match(text, /└─ Qwen3\.6-35B-A3B · https:\/\/huggingface\.co\/Qwen\/Qwen3\.6-35B-A3B/);
});

test("native web search activity raw message keeps queries and sources", () => {
	const text = buildWebSearchActivityMessage([{ callId: "ws_1", query: "q", queries: [], sources: [{ title: "Source", url: "https://example.com" }] }] as any);
	assert.match(text, /Web search results/);
	assert.match(text, /- q/);
	assert.match(text, /- Source — https:\/\/example\.com/);
});

test("saveOpenAICodexGeneratedImage writes generated images under the configured default output dir", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-codex-minimal-image-"));
	const encoded = Buffer.from("png-bytes").toString("base64");
	try {
		const saved = await saveOpenAICodexGeneratedImage(cwd, { responseId: "resp_123", callId: "ig_456", result: encoded, outputFormat: "png" });
		assert.match(saved.relativePath, /^\.pi[/\\]openai-codex-images[/\\].+ig_456-resp_123\.png$/);
		assert.equal(saved.latestRelativePath, path.join(".pi", "openai-codex-images", "latest.png"));
		assert.deepEqual(await fs.readFile(saved.absolutePath), Buffer.from("png-bytes"));
		assert.deepEqual(await fs.readFile(saved.latestAbsolutePath), Buffer.from("png-bytes"));
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
