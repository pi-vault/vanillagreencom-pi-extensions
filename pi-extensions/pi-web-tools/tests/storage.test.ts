import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearMemoryForTests, getWebContent, restoreStoredContent, storeWebContent } from "../src/storage.js";
import { createCodeSearchToolDefinition } from "../src/tools/code-search.js";
import { createGetWebContentToolDefinition } from "../src/tools/get-web-content.js";
import { buildWebFetchToolResult, createWebFetchToolDefinition, DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS } from "../src/tools/web-fetch.js";
import { createWebAnswerToolDefinition } from "../src/tools/web-answer.js";
import { createWebFindSimilarToolDefinition } from "../src/tools/web-find-similar.js";
import { createWebSearchToolDefinition } from "../src/tools/web-search.js";

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

test("stored content can be restored from session custom entries", () => {
	clearMemoryForTests();
	const appended: any[] = [];
	const pi = { appendEntry(type: string, data: unknown) { appended.push({ type, data }); } } as any;
	const stored = storeWebContent(pi, { title: "T", url: "https://example.com", content: "Body" });
	assert.equal(getWebContent(stored.id)?.content, "Body");
	clearMemoryForTests();
	restoreStoredContent({ sessionManager: { getEntries: () => appended.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })) } } as any);
	assert.equal(getWebContent(stored.id)?.url, "https://example.com");
});

test("get_web_content renderer styles missing-id errors with tree guidance", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ content: [{ type: "text", text: "Stored content id not found: https://example.com" }] }, {}, theme, { isError: true, args: { id: "https://example.com" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\)/);
	assert.match(text, /Get Web Content \(Session\) stored content id not found/);
	assert.doesNotMatch(text.split("\n")[0] ?? "", /https:\/\/example\.com/);
	assert.match(text, /├─ content id https:\/\/example\.com/);
	assert.match(text, /URLs are not content ids/);
});

test("get_web_content renderer separates session retrieval from source provider", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ details: { id: "web-123", title: "Example", url: "https://example.com", contentLength: 42, metadata: { provider: "exa" } } }, {}, theme, { args: { id: "web-123" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\) Example · 42 chars · full/);
	assert.doesNotMatch(text, /content id web-123/);
	assert.match(text, /source Exa/);
});

test("get_web_content renderer shows shown/full metadata when truncated", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ details: { id: "web-long", title: "Long", url: "https://example.com/long", contentLength: 120000, maxCharacters: 50000, truncated: true, metadata: { provider: "http" } } }, {}, theme, { args: { id: "web-long" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\) Long · 50000\/120000 chars · truncated/);
	assert.match(text, /source HTTP/);
});

test("get_web_content renderer marks search-stored content as a provider-capped excerpt", () => {
	const tool = createGetWebContentToolDefinition();
	const component = tool.renderResult({ details: { id: "web-search", title: "Result", url: "https://example.com/result", contentLength: 1200, maxCharacters: 50000, truncated: false, metadata: { provider: "exa", contentKind: "search-result", providerTextMaxCharacters: 1200 } } }, {}, theme, { args: { id: "web-search" } });
	const text = component.render(200).join("\n");
	assert.match(text, /Get Web Content \(Session\) Result · 1200 chars · stored excerpt/);
	assert.match(text, /provider cap 1200 chars/);
	assert.doesNotMatch(text, /1200 chars · full/);
});

test("web_fetch renderer shows resolved provider without requested auto suffix", () => {
	const tool = createWebFetchToolDefinition({} as any, () => ({}) as any);
	const pending = tool.renderCall({ url: "https://example.com", provider: "auto" }, theme, {}).render(200).join("\n");
	assert.match(pending, /Web Fetch \(Resolving…\)/);
	const complete = tool.renderResult({ details: { provider: "github", stored: [{ id: "web-123", title: "file.zig" }] } }, {}, theme, { args: { provider: "auto", url: "https://example.com" } }).render(200).join("\n");
	assert.match(complete, /Web Fetch \(GitHub\)/);
	assert.doesNotMatch(complete, /GitHub\/Auto/);
	assert.doesNotMatch(complete, /content id web-123/);
});

test("web_fetch returned text and details identify preview truncation and stored full text", () => {
	const result = buildWebFetchToolResult([{
		id: "web-long",
		title: "Long page",
		url: "https://example.com/long",
		content: "x".repeat(DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS + 5),
		createdAt: "2026-01-01T00:00:00.000Z",
	}], "http");
	const text = result.content[0]!.text;
	assert.match(text, /Preview returned \(4000\/4005 chars shown\)/);
	assert.match(text, /Full extracted text is stored under content id\(s\): web-long/);
	assert.match(text, /\[preview 4000\/4005 chars; full text stored\]/);
	assert.match(text, /Use get_web_content with the content id for stored full text/);
	assert.equal(result.details.preview.truncated, true);
	assert.equal(result.details.preview.shownCharacters, 4000);
	assert.equal(result.details.preview.fullCharacters, 4005);
	assert.deepEqual(result.details.preview.items, [{ id: "web-long", shownCharacters: 4000, fullCharacters: 4005, truncated: true }]);
});

test("web_fetch renderer shows concise preview shown/full metadata when preview-truncated", () => {
	const tool = createWebFetchToolDefinition({} as any, () => ({}) as any);
	const result = buildWebFetchToolResult([{
		id: "web-long",
		title: "Long page",
		url: "https://example.com/long",
		content: "x".repeat(DEFAULT_WEB_FETCH_PREVIEW_CHARACTERS + 5),
		createdAt: "2026-01-01T00:00:00.000Z",
	}], "github");
	const rendered = tool.renderResult(result, {}, theme, { args: { provider: "auto", url: "https://example.com/long" } }).render(200).join("\n");
	assert.match(rendered, /Web Fetch \(GitHub\) https:\/\/example\.com\/long · 1 stored · preview 4000\/4005 chars/);
	assert.match(rendered, /Long page · https:\/\/example\.com\/long · preview 4000\/4005 chars/);
	assert.doesNotMatch(rendered, /content id web-long/);
	assert.doesNotMatch(rendered, /GitHub\/Auto/);
});

test("web_fetch and get_web_content render URL leaf when provider returns blank title", () => {
	const fetchTool = createWebFetchToolDefinition({} as any, () => ({}) as any);
	const result = buildWebFetchToolResult([{
		id: "web-pdf",
		title: "",
		url: "https://example.com/path/dummy.pdf",
		content: "Dummy PDF file\n",
		createdAt: "2026-01-01T00:00:00.000Z",
	}], "exa");
	const renderedFetch = fetchTool.renderResult(result, {}, theme, { args: { provider: "auto", url: "https://example.com/path/dummy.pdf" } }).render(200).join("\n");
	assert.match(renderedFetch, /dummy\.pdf · https:\/\/example.com\/path\/dummy\.pdf/);
	assert.doesNotMatch(renderedFetch, /content id web-pdf/);

	const contentTool = createGetWebContentToolDefinition();
	const renderedContent = contentTool.renderResult({ details: { id: "web-pdf", title: "", url: "https://example.com/path/dummy.pdf", contentLength: 15, truncated: false, metadata: { provider: "exa" } } }, {}, theme, { args: { id: "web-pdf" } }).render(200).join("\n");
	assert.match(renderedContent, /Get Web Content \(Session\) dummy\.pdf · 15 chars · full/);
});

test("advanced search renderers hide content ids in compact rows", () => {
	const tool = createCodeSearchToolDefinition({} as any, () => ({}) as any);
	const rendered = tool.renderResult({ details: { results: [{ title: "Example", url: "https://example.com", contentId: "web-123" }] } }, {}, theme, { args: { query: "q" } }).render(200).join("\n");
	assert.match(rendered, /Code Search \(Exa\) q · 1 results/);
	assert.match(rendered, /https:\/\/example.com/);
	assert.doesNotMatch(rendered, /content id web-123/);
	assert.doesNotMatch(rendered, /contentId/);
});

test("web_search renderer shows result URLs and hides content ids", () => {
	const tool = createWebSearchToolDefinition({} as any, () => ({}) as any);
	const rendered = tool.renderResult({ details: { provider: "exa", results: [{ title: "Example", url: "https://example.com/path", contentId: "web-123" }] } }, {}, theme, { args: { query: "q" } }).render(200).join("\n");
	assert.match(rendered, /Web Search \(Exa\) q · 1 results/);
	assert.match(rendered, /https:\/\/example.com\/path/);
	assert.doesNotMatch(rendered, /content id web-123/);
});

test("advanced Exa tools render compact provider-labeled summaries", () => {
	const answer = createWebAnswerToolDefinition({} as any, () => ({}) as any);
	const similar = createWebFindSimilarToolDefinition({} as any, () => ({}) as any);
	const answerCall = answer.renderCall({ query: "What is Ghostty?" }, theme, {}).render(200).join("\n");
	const similarResult = similar.renderResult({ details: { results: [{ title: "Docs", url: "https://ghostty.org/docs" }, { title: "Repo", url: "https://github.com/ghostty-org/ghostty" }] } }, {}, theme, { args: { url: "https://ghostty.org" } }).render(200).join("\n");
	assert.match(answerCall, /Web Answer \(Exa\) What is Ghostty\?/);
	assert.match(similarResult, /Web Find Similar \(Exa\) https:\/\/ghostty.org · 2 results/);
	assert.match(similarResult, /Docs · https:\/\/ghostty.org\/docs/);
});

test("web_fetch extracts local PDF file paths into session storage", async () => {
	clearMemoryForTests();
	const dir = mkdtempSync(join(tmpdir(), "pi-web-tools-local-pdf-"));
	const path = join(dir, "local.pdf");
	writeFileSync(path, "%PDF-1.4\nBT\n(Local PDF) Tj\nET");
	const appended: any[] = [];
	const tool = createWebFetchToolDefinition({ appendEntry(type: string, data: unknown) { appended.push({ type, data }); } } as any, () => ({ githubClone: { enabled: true }, apiKeys: {} }) as any);
	const result = await tool.execute("call", { filePath: path, provider: "auto" }, undefined, undefined, { cwd: dir } as any);
	assert.equal(result.details.provider, "local");
	const stored = result.details.stored[0]!;
	assert.equal(stored.title, "local.pdf");
	assert.equal(stored.metadata?.provider, "local");
	assert.match(result.content[0]!.text, /Local PDF/);
	assert.equal(appended.length, 1);
});
