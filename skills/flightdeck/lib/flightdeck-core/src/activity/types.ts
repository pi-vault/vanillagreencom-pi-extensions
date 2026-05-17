import { createHash } from "node:crypto";

export const ACTIVITY_SCHEMA_VERSION = 1;
export const DEFAULT_ACTIVITY_LIMIT = 300;
export const DEFAULT_ACTIVITY_MAX_EVENTS = 5000;
export const DEFAULT_ACTIVITY_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ACTIVITY_DETAILS_MAX_BYTES = 16 * 1024;

export class ActivityValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivityValidationError";
	}
}

export type ActivitySource =
	| "flightdeck"
	| "daemon"
	| "subscriber"
	| "pi-session"
	| "pi-agents"
	| "pi-bg-task"
	| "workflow"
	| "github"
	| "linear"
	| string;

export type ActivitySeverity = "debug" | "info" | "success" | "warning" | "error";
export type ActivityImportance = "critical" | "important" | "normal" | "noisy";

export interface ActivityLink {
	label: string;
	url?: string;
	path?: string;
}

export interface ActivityRefs {
	task_id?: string;
	agent?: string;
	bg_task_id?: string;
	question_id?: string;
	pr_number?: number;
	issue_id?: string;
	linear_id?: string;
	commit?: string;
	check_name?: string;
	/** PR head branch name carried alongside pr.* events (vstack#101). */
	branch?: string;
}

export interface FlightdeckActivityEventV1 {
	schema_version: 1;
	id: string;
	ts: string;
	session_id?: string;
	source: ActivitySource;
	entry_id?: string;
	entry_title?: string;
	entry_kind?: string;
	pane_id?: string;
	harness?: string;
	type: string;
	severity: ActivitySeverity;
	importance: ActivityImportance;
	summary: string;
	body?: string;
	links?: ActivityLink[];
	refs?: ActivityRefs;
	details?: Record<string, unknown>;
	noisy?: boolean;
}

export interface ActivityEventInput {
	id?: unknown;
	schema_version?: unknown;
	ts?: unknown;
	session_id?: unknown;
	source?: unknown;
	entry_id?: unknown;
	entry_title?: unknown;
	entry_kind?: unknown;
	pane_id?: unknown;
	harness?: unknown;
	type?: unknown;
	severity?: unknown;
	importance?: unknown;
	summary?: unknown;
	body?: unknown;
	links?: unknown;
	refs?: unknown;
	details?: unknown;
	noisy?: unknown;
	natural_key?: unknown;
}

export interface NormalizeActivityOptions {
	sessionId?: string;
	naturalKey?: string;
	now?: () => Date;
	detailsMaxBytes?: number;
}

export function activityEventId(parts: {
	sessionId?: string;
	entryId?: string;
	type: string;
	naturalKey: string;
}): string {
	return createHash("sha256")
		.update([parts.sessionId ?? "", parts.entryId ?? "", parts.type, parts.naturalKey].join("\0"))
		.digest("hex");
}

export function normalizeActivityEvent(input: ActivityEventInput, opts: NormalizeActivityOptions = {}): FlightdeckActivityEventV1 {
	const source = requiredString(input.source, "source");
	const type = requiredString(input.type, "type");
	const summary = requiredString(input.summary, "summary");
	const sessionId = optionalString(input.session_id) ?? optionalString(opts.sessionId);
	const entryId = optionalString(input.entry_id);
	const ts = optionalString(input.ts) ?? (opts.now ?? (() => new Date()))().toISOString();
	if (!isValidIsoTimestamp(ts)) throw new Error(`invalid activity ts: ${ts}`);
	const severity = normalizeSeverity(input.severity);
	const importance = normalizeImportance(input.importance);
	const links = normalizeLinks(input.links);
	const refs = normalizeRefs(input.refs);
	const details = normalizeDetails(input.details, opts.detailsMaxBytes ?? DEFAULT_ACTIVITY_DETAILS_MAX_BYTES);
	const naturalKey = optionalString(opts.naturalKey)
		?? optionalString(input.natural_key)
		?? optionalString(details?.dedup_key)
		?? refs.task_id
		?? refs.bg_task_id
		?? refs.question_id
		?? refs.commit
		?? ts;
	const id = optionalString(input.id) ?? activityEventId({ entryId, naturalKey, sessionId, type });
	if (!id) throw new Error("activity id must be non-empty");

	const event: FlightdeckActivityEventV1 = {
		id,
		importance,
		schema_version: ACTIVITY_SCHEMA_VERSION,
		severity,
		source,
		summary,
		ts,
		type,
	};
	if (sessionId) event.session_id = sessionId;
	if (entryId) event.entry_id = entryId;
	const entryTitle = optionalString(input.entry_title);
	if (entryTitle) event.entry_title = entryTitle;
	const entryKind = optionalString(input.entry_kind);
	if (entryKind) event.entry_kind = entryKind;
	const paneId = optionalString(input.pane_id);
	if (paneId) event.pane_id = paneId;
	const harness = optionalString(input.harness);
	if (harness) event.harness = harness;
	const body = optionalString(input.body);
	if (body) event.body = body;
	if (links.length > 0) event.links = links;
	if (Object.keys(refs).length > 0) event.refs = refs;
	if (details) event.details = details;
	const noisy = typeof input.noisy === "boolean" ? input.noisy : importance === "noisy";
	if (noisy) event.noisy = true;
	return event;
}

export function isActivityEvent(value: unknown): value is FlightdeckActivityEventV1 {
	if (!isRecord(value)) return false;
	return value.schema_version === ACTIVITY_SCHEMA_VERSION
		&& typeof value.id === "string"
		&& typeof value.ts === "string"
		&& typeof value.source === "string"
		&& typeof value.type === "string"
		&& typeof value.severity === "string"
		&& typeof value.importance === "string"
		&& typeof value.summary === "string";
}

function requiredString(value: unknown, label: string): string {
	const normalized = optionalString(value);
	if (!normalized) throw new Error(`activity ${label} must be a non-empty string`);
	return normalized;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSeverity(value: unknown): ActivitySeverity {
	if (value === undefined || value === null) return "info";
	if (value === "debug" || value === "info" || value === "success" || value === "warning" || value === "error") return value;
	throw new ActivityValidationError(`invalid activity severity: ${String(value)}`);
}

function normalizeImportance(value: unknown): ActivityImportance {
	if (value === undefined || value === null) return "normal";
	if (value === "critical" || value === "important" || value === "normal" || value === "noisy") return value;
	throw new ActivityValidationError(`invalid activity importance: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeLinks(value: unknown): ActivityLink[] {
	if (!Array.isArray(value)) return [];
	const out: ActivityLink[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const label = optionalString(item.label);
		if (!label) continue;
		const link: ActivityLink = { label };
		const url = optionalString(item.url);
		if (url) link.url = url;
		const path = optionalString(item.path);
		if (path) link.path = path;
		out.push(link);
	}
	return out;
}

function normalizeRefs(value: unknown): ActivityRefs {
	if (!isRecord(value)) return {};
	const refs: ActivityRefs = {};
	for (const key of ["task_id", "agent", "bg_task_id", "question_id", "issue_id", "linear_id", "commit", "check_name", "branch"] as const) {
		const v = optionalString(value[key]);
		if (v) refs[key] = v;
	}
	if (typeof value.pr_number === "number" && Number.isFinite(value.pr_number)) refs.pr_number = Math.trunc(value.pr_number);
	return refs;
}

function normalizeDetails(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const encoded = JSON.stringify(value);
	if (encoded.length <= maxBytes) return value;
	return { original_bytes: encoded.length, truncated: true };
}

function isValidIsoTimestamp(value: string): boolean {
	const ms = Date.parse(value);
	return Number.isFinite(ms);
}
