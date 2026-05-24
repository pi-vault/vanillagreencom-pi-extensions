/**
 * Tests for extra-usage detection helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatResetTimestamp, isExtraUsageRequiredMessage, uniqueNonEmptyLines } from "../src/index.ts";

describe("isExtraUsageRequiredMessage", () => {
	it("detects Claude Code extra-usage rate-limit text", () => {
		assert.equal(isExtraUsageRequiredMessage("Fast mode requires extra usage billing — /extra-usage to enable"), true);
		assert.equal(isExtraUsageRequiredMessage({ message: "Extra usage is required for 1M context" }), true);
		assert.equal(isExtraUsageRequiredMessage(new Error("overage not provisioned")), true);
	});

	it("ignores normal rate-limit text", () => {
		assert.equal(isExtraUsageRequiredMessage("Claude rate limited; resets at 12:00"), false);
	});

	it("deduplicates repeated Claude Code error lines", () => {
		assert.deepEqual(uniqueNonEmptyLines(["You're out of extra usage", "You're out of extra usage", " other "]), [
			"You're out of extra usage",
			"other",
		]);
	});

	it("formats reset timestamps with timezone context", () => {
		const formatted = formatResetTimestamp("2026-05-23T13:19:55Z");
		assert.match(formatted, /2026|May|23|13|1|UTC|GMT|AM|PM/i);
		assert.equal(formatResetTimestamp("not a date"), "unknown");
	});
});
