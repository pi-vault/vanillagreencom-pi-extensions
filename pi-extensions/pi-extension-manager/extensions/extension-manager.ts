/**
 * vstack Pi extension manager.
 *
 * Provides a Pi-styled settings shell with package tabs. Pi does not yet
 * expose a public API for third-party extensions to inject native built-in
 * /settings tabs, so this extension exposes /extensions and the
 * /extensions settings subcommand.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-extension-manager.installed");
const MANAGER_ID = "@vanillagreen/pi-extension-manager";
const SETTINGS_EVENT = "vstack:extension-settings-changed";
const DEFAULT_WIDTH = 124;
const DEFAULT_WIDTH_PERCENT = "92%";
const DEFAULT_MAX_HEIGHT = "85%";
const POPUP_HEIGHT_RATIO = 0.85;
const POPUP_PADDING_X = 2;
const POPUP_PADDING_Y = 1;
const POPUP_FRAME_ROWS = 2 + POPUP_PADDING_Y * 2;
const LEFT_MIN_WIDTH = 34;
const LEFT_MAX_WIDTH = 48;
const LIST_ROWS = 18;
const SETTINGS_ROWS = 10;
const MANAGER_INNER_ROWS = 32;
const QUICK_SETTINGS_INNER_ROWS = 30;
const QUICK_SETTINGS_ROWS = 18;
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
const VSTACK_OPEN_QUICK_SETTINGS_SYMBOL = Symbol.for("vstack.pi.extension-manager.open-quick-settings");
const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

function ansiGreen(text: string): string { return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`; }
function ansiYellow(text: string): string { return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`; }

type Scope = "user" | "project" | "temporary" | "builtin" | "unknown";
type ExtensionState = "active" | "disabled" | "shadowed" | "broken";
type ApplyMode = "live" | "reload" | "session" | "restart";
type SettingType = "boolean" | "enum" | "string" | "number" | "secret" | "path";
type TopTab = string;
type Pane = "list" | "settings";

const TAB_ALL = "all";
const PACKAGE_TAB_PREFIX = "package:";

interface SettingsSchema {
	key: string;
	label?: string;
	description?: string;
	type: SettingType;
	default?: unknown;
	enumValues?: string[];
	secret?: boolean;
	category?: string;
	apply?: ApplyMode;
	requiresReload?: boolean;
	validation?: Record<string, unknown>;
}

interface PackageManifest {
	name?: string;
	version?: string;
	description?: string;
	keywords?: string[];
	pi?: {
		extensions?: string[];
		skills?: string[];
		prompts?: string[];
		themes?: string[];
	};
	bin?: string | Record<string, string>;
	vstack?: {
		extensionManager?: {
			displayName?: string;
			settings?: SettingsSchema[];
			resources?: ResourceMetadata[];
		};
	};
}

interface ResourceMetadata {
	kind: string;
	name: string;
	description?: string;
	trigger?: string;
	path?: string;
}

interface SettingsFile {
	scope: Scope;
	baseDir: string;
	path: string;
	json: Record<string, unknown>;
	exists: boolean;
}

interface ManagerState {
	disabledItems: string[];
	disabledProviders: string[];
	config: Record<string, Record<string, unknown>>;
}

interface ConfigValue {
	value: unknown;
	scope: Scope | "default";
	explicit: boolean;
}

interface PopupLayout {
	bodyRows: number;
	innerRows: number;
	listRows: number;
	settingsRows: number;
}

interface VstackModalLock {
	depth: number;
}

interface InventoryItem {
	id: string;
	displayName: string;
	kind: string;
	state: ExtensionState;
	stateReason: string;
	description: string;
	provider: string;
	scope: Scope;
	sourcePath: string;
	sourceName: string;
	packageName?: string;
	packageDir?: string;
	entrypoint?: string;
	trigger?: string;
	shadowedBy?: string;
	settingsSchema?: SettingsSchema[];
	brokenError?: string;
	metadata?: Record<string, unknown>;
	installedVersion?: string;
	latestVersion?: string;
	updateAvailable?: boolean;
	updateSource?: "vstack" | "npm";
	updateCommand?: string;
}

interface SourceIndexEntry {
	sourceRepo?: string;
	sourcePath?: string;
	sourceVersion?: string;
	sourceCommit?: string;
	installedAt?: number;
}

type SourceIndex = Record<string, SourceIndexEntry>;

interface NpmCacheEntry {
	version: string;
	checkedAt: number;
}

type NpmCache = Record<string, NpmCacheEntry>;

const NPM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let npmCheckInFlight = false;

interface Inventory {
	items: InventoryItem[];
	packages: InventoryItem[];
	settingsFiles: SettingsFile[];
	managerState: ManagerState;
	auditLines: string[];
}

interface ManagerTab {
	id: TopTab;
	label: string;
	packageName?: string;
}

interface ManagerActionEdit {
	type: "edit-setting";
	itemId: string;
	settingKey: string;
}

interface ManagerActionSet {
	type: "set-setting";
	itemId: string;
	settingKey: string;
	value: unknown;
}

interface ManagerActionToggleItem {
	type: "toggle-item";
	itemId: string;
}

interface ManagerActionToggleProvider {
	type: "toggle-provider";
	provider: string;
}

interface ManagerActionResetSetting {
	type: "reset-setting";
	itemId: string;
	settingKey: string;
}

interface ManagerActionResetSettings {
	type: "reset-settings";
	itemId: string;
}

interface ManagerActionUninstallPackage {
	type: "uninstall-package";
	itemId: string;
}

type ManagerAction = ManagerActionEdit | ManagerActionSet | ManagerActionToggleItem | ManagerActionToggleProvider | ManagerActionResetSetting | ManagerActionResetSettings | ManagerActionUninstallPackage | { type: "close" } | undefined;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function userPiDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function findProjectPiDir(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi");
		current = parent;
	}
}

function readJsonObject(path: string): { json: Record<string, unknown>; exists: boolean; error?: string } {
	if (!existsSync(path)) return { json: {}, exists: false };
	try {
		const text = readFileSync(path, "utf8");
		if (!text.trim()) return { json: {}, exists: true };
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { json: {}, exists: true, error: "settings root is not an object" };
		return { json: parsed as Record<string, unknown>, exists: true };
	} catch (error) {
		return { json: {}, exists: true, error: stringifyError(error) };
	}
}

function loadSettingsFiles(ctx: ExtensionContext): SettingsFile[] {
	const projectBase = findProjectPiDir(ctx.cwd);
	const userBase = userPiDir();
	const user = readJsonObject(join(userBase, "settings.json"));
	const project = readJsonObject(join(projectBase, "settings.json"));
	return [
		{ scope: "user", baseDir: userBase, path: join(userBase, "settings.json"), json: user.json, exists: user.exists },
		{ scope: "project", baseDir: projectBase, path: join(projectBase, "settings.json"), json: project.json, exists: project.exists },
	];
}

function writeSettingsFile(file: SettingsFile): void {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(file.path, `${JSON.stringify(file.json, null, 2)}\n`, "utf8");
	file.exists = true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getOrCreateRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = asRecord(parent[key]);
	if (current) return current;
	const created: Record<string, unknown> = {};
	parent[key] = created;
	return created;
}

function managerStateFrom(json: Record<string, unknown>): ManagerState {
	const vstack = asRecord(json.vstack) ?? {};
	const manager = asRecord(vstack.extensionManager) ?? {};
	const config = asRecord(manager.config) ?? {};
	const normalizedConfig: Record<string, Record<string, unknown>> = {};
	for (const [id, value] of Object.entries(config)) {
		const record = asRecord(value);
		if (record) normalizedConfig[id] = { ...record };
	}
	return {
		disabledItems: Array.isArray(manager.disabledItems) ? manager.disabledItems.filter((v): v is string => typeof v === "string") : [],
		disabledProviders: Array.isArray(manager.disabledProviders)
			? manager.disabledProviders.filter((v): v is string => typeof v === "string")
			: [],
		config: normalizedConfig,
	};
}

function mergedManagerState(files: SettingsFile[]): ManagerState {
	const user = managerStateFrom(files.find((f) => f.scope === "user")?.json ?? {});
	const project = managerStateFrom(files.find((f) => f.scope === "project")?.json ?? {});
	return {
		disabledItems: [...new Set([...user.disabledItems, ...project.disabledItems])],
		disabledProviders: [...new Set([...user.disabledProviders, ...project.disabledProviders])],
		config: deepMergeConfig(user.config, project.config),
	};
}

function deepMergeConfig(
	base: Record<string, Record<string, unknown>>,
	override: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [id, values] of Object.entries(base)) out[id] = { ...values };
	for (const [id, values] of Object.entries(override)) out[id] = { ...(out[id] ?? {}), ...values };
	return out;
}

function updateManagerState(file: SettingsFile, updater: (state: ManagerState) => void): void {
	const vstack = getOrCreateRecord(file.json, "vstack");
	const manager = getOrCreateRecord(vstack, "extensionManager");
	const current = managerStateFrom(file.json);
	updater(current);
	manager.disabledItems = current.disabledItems;
	manager.disabledProviders = current.disabledProviders;
	manager.config = current.config;
	writeSettingsFile(file);
}

function findSettingsFile(files: SettingsFile[], scope: Scope): SettingsFile {
	return files.find((file) => file.scope === scope) ?? files[0]!;
}

function acquireVstackModalLock(): () => void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[VSTACK_MODAL_LOCK_SYMBOL] as VstackModalLock | undefined;
	const lock = existing && typeof existing.depth === "number" ? existing : { depth: 0 };
	host[VSTACK_MODAL_LOCK_SYMBOL] = lock;
	lock.depth += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lock.depth = Math.max(0, lock.depth - 1);
	};
}

function responsiveInnerRows(terminalRows: number, preferred: number, minimum = 12): number {
	const available = Math.max(minimum + POPUP_FRAME_ROWS, Math.floor(Math.max(1, terminalRows) * POPUP_HEIGHT_RATIO));
	return Math.max(minimum, Math.min(preferred, available - POPUP_FRAME_ROWS));
}

function managerLayout(terminalRows: number): PopupLayout {
	const innerRows = responsiveInnerRows(terminalRows, MANAGER_INNER_ROWS, 14);
	const bodyRows = Math.max(4, innerRows - 10);
	return {
		bodyRows,
		innerRows,
		listRows: Math.max(3, Math.min(LIST_ROWS, bodyRows - 3)),
		settingsRows: Math.max(3, Math.min(SETTINGS_ROWS, bodyRows - 10)),
	};
}

function quickSettingsLayout(terminalRows: number): PopupLayout {
	const innerRows = responsiveInnerRows(terminalRows, QUICK_SETTINGS_INNER_ROWS, 12);
	const bodyRows = Math.max(4, innerRows - 8);
	return {
		bodyRows,
		innerRows,
		listRows: Math.max(3, Math.min(QUICK_SETTINGS_ROWS, bodyRows)),
		settingsRows: 0,
	};
}

function defaultWriteScope(item: InventoryItem | undefined, files: SettingsFile[], managerState: ManagerState): Scope {
	if (item?.scope === "project" || item?.scope === "user") return item.scope;
	const configured = managerState.config[MANAGER_ID]?.defaultSaveScope;
	if (configured === "user") return "user";
	if (configured === "project") return "project";
	return files.some((file) => file.scope === "project" && file.exists) ? "project" : "user";
}

function loadSourceIndex(settingsFiles: SettingsFile[]): SourceIndex {
	const merged: SourceIndex = {};
	for (const file of settingsFiles) {
		const path = join(file.baseDir, ".vstack-source.json");
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") {
				for (const [name, entry] of Object.entries(parsed)) {
					if (entry && typeof entry === "object") merged[name] = entry as SourceIndexEntry;
				}
			}
		} catch {}
	}
	return merged;
}

function npmCachePath(): string {
	return join(homedir(), ".pi", "agent", ".vstack-update-cache.json");
}

function loadNpmCache(): NpmCache {
	const path = npmCachePath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveNpmCache(cache: NpmCache): void {
	const path = npmCachePath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache, null, 2));
	} catch {}
}

function parseSemver(v: string | undefined): number[] | undefined {
	if (!v) return undefined;
	const clean = v.replace(/^v/, "").split(/[-+]/)[0];
	const parts = clean.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.some((n) => Number.isNaN(n))) return undefined;
	while (parts.length < 3) parts.push(0);
	return parts;
}

function isNewer(latest: string | undefined, current: string | undefined): boolean {
	const a = parseSemver(latest);
	const b = parseSemver(current);
	if (!a || !b) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return false;
}

function localPackageDirName(packageName: string): string {
	return packageName.startsWith("@vanillagreen/") ? packageName.split("/").pop() || packageName : packageName;
}

function readSourceRepoVersion(repoRoot: string, packageName: string): string | undefined {
	const manifestPath = join(repoRoot, "pi-extensions", localPackageDirName(packageName), "package.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		return typeof parsed?.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

function npmPackageNameFromSource(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const rest = source.slice("npm:".length);
	if (!rest) return undefined;
	const withoutTag = rest.startsWith("@")
		? rest.split("@").slice(0, 2).join("@")
		: rest.split("@")[0];
	return withoutTag || undefined;
}

function fetchNpmLatest(name: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const https = require("node:https") as typeof import("node:https");
			const encoded = encodeURIComponent(name).replace(/%40/g, "@").replace(/%2F/g, "/");
			const req = https.request(
				{
					host: "registry.npmjs.org",
					path: `/${encoded}/latest`,
					headers: { accept: "application/json", "user-agent": "vstack-extension-manager" },
					timeout: 4000,
				},
				(res) => {
					if ((res.statusCode ?? 0) >= 400) {
						res.resume();
						resolve(undefined);
						return;
					}
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => { body += chunk; });
					res.on("end", () => {
						try {
							const parsed = JSON.parse(body);
							resolve(typeof parsed?.version === "string" ? parsed.version : undefined);
						} catch {
							resolve(undefined);
						}
					});
				},
			);
			req.on("error", () => resolve(undefined));
			req.on("timeout", () => { req.destroy(); resolve(undefined); });
			req.end();
		} catch {
			resolve(undefined);
		}
	});
}

function kickNpmUpdateCheck(packages: { name: string; npmName: string }[], onUpdate: () => void): void {
	if (npmCheckInFlight || packages.length === 0) return;
	const cache = loadNpmCache();
	const now = Date.now();
	const stale = packages.filter((p) => {
		const entry = cache[p.npmName];
		return !entry || now - entry.checkedAt > NPM_CACHE_TTL_MS;
	});
	if (stale.length === 0) return;
	npmCheckInFlight = true;
	void (async () => {
		let changed = false;
		for (const p of stale) {
			const latest = await fetchNpmLatest(p.npmName);
			if (latest) {
				cache[p.npmName] = { version: latest, checkedAt: Date.now() };
				changed = true;
			}
		}
		if (changed) saveNpmCache(cache);
		npmCheckInFlight = false;
		try { onUpdate(); } catch {}
	})();
}

function readPackageManifest(dir: string): { manifest?: PackageManifest; error?: string } {
	try {
		const path = join(dir, "package.json");
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return { manifest: parsed as PackageManifest };
	} catch (error) {
		return { error: stringifyError(error) };
	}
}

function normalizePackageEntry(entry: unknown, baseDir: string): { source: string; resolved: string; disabledByFilter: boolean } | undefined {
	if (typeof entry === "string") {
		return { source: entry, resolved: resolveSource(entry, baseDir), disabledByFilter: false };
	}
	const record = asRecord(entry);
	if (!record || typeof record.source !== "string") return undefined;
	const extensionsFilter = record.extensions;
	const allDisabled = Array.isArray(extensionsFilter) && extensionsFilter.length === 0;
	return { source: record.source, resolved: resolveSource(record.source, baseDir), disabledByFilter: allDisabled };
}

function resolveSource(source: string, baseDir: string): string {
	const expanded = expandHome(source);
	if (expanded.startsWith("npm:") || expanded.startsWith("git:") || expanded.startsWith("http://") || expanded.startsWith("https://")) {
		return expanded;
	}
	return resolve(baseDir, expanded);
}

function binNames(bin: PackageManifest["bin"]): string[] {
	if (!bin) return [];
	if (typeof bin === "string") return [bin];
	return Object.keys(bin);
}

function packageDisplayName(manifest: PackageManifest, fallback: string): string {
	return manifest.vstack?.extensionManager?.displayName || manifest.name || fallback;
}

function settingSchema(manifest: PackageManifest): SettingsSchema[] {
	const schema = manifest.vstack?.extensionManager?.settings;
	return Array.isArray(schema) ? schema.filter(isSettingSchema) : [];
}

function isSettingSchema(value: unknown): value is SettingsSchema {
	const record = asRecord(value);
	return Boolean(record && typeof record.key === "string" && isSettingType(record.type));
}

function isSettingType(value: unknown): value is SettingType {
	return value === "boolean" || value === "enum" || value === "string" || value === "number" || value === "secret" || value === "path";
}

function collectConfiguredExtensions(file: SettingsFile): InventoryItem[] {
	const entries = Array.isArray(file.json.extensions) ? file.json.extensions : [];
	const items: InventoryItem[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string" || entry.startsWith("!")) continue;
		const resolved = resolveSource(entry, file.baseDir);
		items.push(makeResourceItem(`extension-setting:${file.scope}:${entry}`, entry, "extension setting", file.scope, resolved, `${file.scope}:extensions`, entry, "Configured in settings.json extensions[]"));
	}
	return items;
}

function collectAutoExtensions(baseDir: string, scope: Scope): InventoryItem[] {
	const roots = [join(baseDir, "extensions")];
	const items: InventoryItem[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of safeReadDir(root)) {
			const full = join(root, entry);
			try {
				const stat = statSync(full);
				if (stat.isFile() && /\.[cm]?[jt]s$/.test(entry)) {
					items.push(makeResourceItem(`extension:${scope}:${full}`, entry, "extension module", scope, full, `${scope}:extensions`, full));
				} else if (stat.isDirectory()) {
					const index = ["index.ts", "index.js", "index.mts", "index.mjs"].map((name) => join(full, name)).find((p) => existsSync(p));
					if (index) items.push(makeResourceItem(`extension:${scope}:${index}`, entry, "extension module", scope, index, `${scope}:extensions`, root));
				}
			} catch {
				// ignore transient filesystem errors in inventory scan
			}
		}
	}
	return items;
}

function safeReadDir(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

function makeResourceItem(
	id: string,
	displayName: string,
	kind: string,
	scope: Scope,
	sourcePath: string,
	provider: string,
	sourceName: string,
	description = "",
	trigger?: string,
): InventoryItem {
	return {
		description,
		displayName,
		id,
		kind,
		provider,
		scope,
		sourceName,
		sourcePath,
		state: "active",
		stateReason: "loaded or discoverable",
		trigger,
	};
}

function buildInventory(pi: ExtensionAPI, ctx: ExtensionContext): Inventory {
	const settingsFiles = loadSettingsFiles(ctx);
	const managerState = mergedManagerState(settingsFiles);
	const items: InventoryItem[] = [];
	const auditLines: string[] = [];
	const seenPackages = new Map<string, InventoryItem>();

	// Project scope wins over user scope, mirroring Pi settings override behavior.
	for (const file of [...settingsFiles].sort((a, b) => (a.scope === "project" ? -1 : b.scope === "project" ? 1 : 0))) {
		const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
		for (const rawEntry of packages) {
			const normalized = normalizePackageEntry(rawEntry, file.baseDir);
			if (!normalized) continue;
			const fallbackName = normalized.source.split("/").filter(Boolean).pop() ?? normalized.source;
			let manifest: PackageManifest | undefined;
			let brokenError: string | undefined;
			if (existsSync(normalized.resolved) && statSync(normalized.resolved).isDirectory()) {
				const read = readPackageManifest(normalized.resolved);
				manifest = read.manifest;
				brokenError = read.error;
			} else if (normalized.resolved.startsWith("npm:") || normalized.resolved.startsWith("git:") || normalized.resolved.startsWith("http")) {
				manifest = { name: fallbackName, description: "External package source" };
			} else {
				brokenError = `package source not found: ${normalized.resolved}`;
			}

			const packageName = manifest?.name ?? fallbackName;
			const pkgId = `package:${packageName}`;
			const packageItem: InventoryItem = {
				brokenError,
				description: manifest?.description ?? "Pi package",
				displayName: packageDisplayName(manifest ?? {}, packageName),
				id: pkgId,
				kind: "package",
				packageDir: normalized.resolved,
				packageName,
				provider: `${file.scope}:packages`,
				scope: file.scope,
				settingsSchema: manifest ? settingSchema(manifest) : [],
				sourceName: normalized.source,
				sourcePath: normalized.resolved,
				state: brokenError ? "broken" : normalized.disabledByFilter ? "disabled" : "active",
				stateReason: brokenError ?? (normalized.disabledByFilter ? "package entry filters extensions: []" : "package listed in settings.json"),
			};

			const existing = seenPackages.get(packageName);
			if (existing && existing.scope === "project" && packageItem.scope === "user") {
				packageItem.state = "shadowed";
				packageItem.stateReason = `shadowed by project package ${existing.sourcePath}`;
				packageItem.shadowedBy = existing.id;
			} else if (!existing) {
				seenPackages.set(packageName, packageItem);
			}
			items.push(packageItem);

			if (manifest) {
				auditLines.push(formatPackageAudit(packageItem, manifest));
				for (const extPath of manifest.pi?.extensions ?? []) {
					const fullPath = resolve(normalized.resolved, extPath);
					items.push({
						description: `Entrypoint from ${packageName}`,
						displayName: extPath,
						entrypoint: extPath,
						id: `extension:${packageName}:${extPath}`,
						kind: "extension module",
						packageDir: normalized.resolved,
						packageName,
						provider: `${file.scope}:packages`,
						scope: file.scope,
						sourceName: packageName,
						sourcePath: fullPath,
						state: packageItem.state,
						stateReason: packageItem.state === "active" ? "declared in package pi.extensions" : packageItem.stateReason,
					});
				}
				for (const binName of binNames(manifest.bin)) {
					items.push(makeResourceItem(`bin:${packageName}:${binName}`, binName, "bin", file.scope, normalized.resolved, `${file.scope}:packages`, packageName, `CLI bin from ${packageName}`));
				}
				for (const resource of manifest.vstack?.extensionManager?.resources ?? []) {
					items.push(makeResourceItem(`resource:${packageName}:${resource.kind}:${resource.name}`, resource.name, resource.kind, file.scope, resolve(normalized.resolved, resource.path ?? "."), `${file.scope}:packages`, packageName, resource.description ?? "", resource.trigger));
				}
			}
		}
		items.push(...collectConfiguredExtensions(file));
		items.push(...collectAutoExtensions(file.baseDir, file.scope));
	}

	const sourceIndex = loadSourceIndex(settingsFiles);
	const npmCache = loadNpmCache();
	for (const item of items) {
		if (item.kind !== "package" || !item.packageName) continue;
		const manifestPath = item.packageDir ? join(item.packageDir, "package.json") : undefined;
		let installedVersion: string | undefined;
		if (manifestPath && existsSync(manifestPath)) {
			try {
				const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (typeof parsed?.version === "string") installedVersion = parsed.version;
			} catch {}
		}
		item.installedVersion = installedVersion;

		const sourceEntry = sourceIndex[item.packageName];
		if (sourceEntry?.sourceRepo) {
			const latest = readSourceRepoVersion(sourceEntry.sourceRepo, item.packageName);
			if (latest) {
				item.latestVersion = latest;
				item.updateSource = "vstack";
				item.updateAvailable = isNewer(latest, installedVersion);
				const scopeFlag = item.scope === "user" ? " --global" : "";
				item.updateCommand = `vstack add ${sourceEntry.sourceRepo}${scopeFlag} --pi-extension ${item.packageName} --harness pi -y`;
				continue;
			}
		}

		const npmName = npmPackageNameFromSource(item.sourceName) ?? (item.sourceName.startsWith("npm:") ? item.packageName : undefined);
		if (npmName && npmCache[npmName]) {
			item.latestVersion = npmCache[npmName].version;
			item.updateSource = "npm";
			item.updateAvailable = isNewer(npmCache[npmName].version, installedVersion);
			item.updateCommand = `npm install -g ${npmName}@latest`;
		}
	}

	for (const command of safeCommands(pi)) {
		const sourceInfo = command.sourceInfo ?? {};
		const scope = normalizeScope(sourceInfo.scope);
		items.push({
			description: command.description ?? "Slash command",
			displayName: `/${command.name}`,
			id: `command:${command.name}`,
			kind: command.source === "skill" ? "skill command" : command.source === "prompt" ? "prompt command" : "slash command",
			provider: sourceInfo.source ?? command.source ?? "commands",
			scope,
			sourceName: sourceInfo.source ?? command.source ?? "commands",
			sourcePath: sourceInfo.path ?? "<runtime>",
			state: "active",
			stateReason: "registered in current runtime",
			trigger: `/${command.name}`,
		});
	}

	const activeTools = new Set(safeActiveTools(pi));
	const showBuiltins = managerState.config[MANAGER_ID]?.showBuiltinTools === true;
	for (const tool of safeTools(pi)) {
		const sourceInfo = tool.sourceInfo ?? {};
		if (!showBuiltins && sourceInfo.source === "builtin") continue;
		items.push({
			description: tool.description ?? "Tool",
			displayName: tool.name,
			id: `tool:${tool.name}`,
			kind: "tool",
			provider: sourceInfo.source ?? "tools",
			scope: normalizeScope(sourceInfo.scope),
			sourceName: sourceInfo.source ?? "tools",
			sourcePath: sourceInfo.path ?? "<runtime>",
			state: activeTools.has(tool.name) ? "active" : "disabled",
			stateReason: activeTools.has(tool.name) ? "active tool" : "not present in active tool set",
			trigger: tool.name,
		});
	}

	applyDisableState(items, managerState);
	items.sort(compareInventoryItems);
	return { auditLines, items, managerState, packages: items.filter((item) => item.kind === "package"), settingsFiles };
}

export function npmCandidatesFromInventory(inventory: Inventory): { name: string; npmName: string }[] {
	const out: { name: string; npmName: string }[] = [];
	for (const item of inventory.items) {
		if (item.kind !== "package" || !item.packageName) continue;
		const npmName = npmPackageNameFromSource(item.sourceName);
		if (npmName) out.push({ name: item.packageName, npmName });
	}
	return out;
}

function formatPackageAudit(item: InventoryItem, manifest: PackageManifest): string {
	const extensions = manifest.pi?.extensions?.join(", ") || "none";
	const settings = settingSchema(manifest);
	const settingText = settings.length === 0 ? "no declared settings schema" : settings.map((s) => `${s.key}:${s.type}:${s.apply ?? (s.requiresReload ? "reload" : "live")}`).join(", ");
	return `${manifest.name ?? item.displayName}\n  source: ${item.sourcePath}\n  entrypoints: ${extensions}\n  settings: ${settingText}`;
}

function kindRank(kind: string): number {
	const order: Record<string, number> = {
		package: 0,
		"extension module": 1,
		tool: 2,
		"slash command": 3,
		"prompt command": 4,
		"skill command": 5,
		bin: 6,
	};
	return order[kind] ?? 9;
}

function compareInventoryItems(a: InventoryItem, b: InventoryItem): number {
	return kindRank(a.kind) - kindRank(b.kind)
		|| (a.packageName ?? a.sourceName ?? "").localeCompare(b.packageName ?? b.sourceName ?? "")
		|| a.displayName.localeCompare(b.displayName)
		|| a.id.localeCompare(b.id);
}

function kindLabel(kind: string): string {
	return kind === "extension module" ? "module" : kind.replace(" command", " cmd");
}

function compactPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function applyDisableState(items: InventoryItem[], managerState: ManagerState): void {
	const disabledItems = new Set(managerState.disabledItems);
	const disabledProviders = new Set(managerState.disabledProviders);
	for (const item of items) {
		if (item.state === "shadowed" || item.state === "broken") continue;
		if (disabledProviders.has(item.provider)) {
			item.state = "disabled";
			item.stateReason = `provider disabled: ${item.provider}`;
		}
		if (disabledItems.has(item.id)) {
			item.state = "disabled";
			item.stateReason = "explicitly disabled in vstack extension manager";
		}
	}
}

function normalizeScope(value: unknown): Scope {
	return value === "user" || value === "project" || value === "temporary" || value === "builtin" ? value : "unknown";
}

function safeCommands(pi: ExtensionAPI): any[] {
	try {
		return pi.getCommands?.() ?? [];
	} catch {
		return [];
	}
}

function safeTools(pi: ExtensionAPI): any[] {
	try {
		return pi.getAllTools?.() ?? [];
	} catch {
		return [];
	}
}

function safeActiveTools(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools?.() ?? [];
	} catch {
		return [];
	}
}

function getConfigValue(inventory: Inventory, extensionId: string, schema: SettingsSchema): ConfigValue {
	const project = managerStateFrom(inventory.settingsFiles.find((file) => file.scope === "project")?.json ?? {});
	const user = managerStateFrom(inventory.settingsFiles.find((file) => file.scope === "user")?.json ?? {});
	if (Object.prototype.hasOwnProperty.call(project.config[extensionId] ?? {}, schema.key)) {
		return { explicit: true, scope: "project", value: project.config[extensionId]![schema.key] };
	}
	if (Object.prototype.hasOwnProperty.call(user.config[extensionId] ?? {}, schema.key)) {
		return { explicit: true, scope: "user", value: user.config[extensionId]![schema.key] };
	}
	return { explicit: false, scope: "default", value: schema.default };
}

function setConfigValue(inventory: Inventory, item: InventoryItem, schema: SettingsSchema, value: unknown): void {
	const scope = defaultWriteScope(item, inventory.settingsFiles, inventory.managerState);
	const file = findSettingsFile(inventory.settingsFiles, scope);
	const extensionId = item.packageName ?? item.displayName;
	updateManagerState(file, (state) => {
		state.config[extensionId] = { ...(state.config[extensionId] ?? {}), [schema.key]: value };
	});
}

function deleteConfigKeysFromFile(file: SettingsFile, extensionId: string, keys: Set<string>): number {
	const vstack = asRecord(file.json.vstack);
	const manager = asRecord(vstack?.extensionManager);
	const config = asRecord(manager?.config);
	const record = asRecord(config?.[extensionId]);
	if (!manager || !config || !record) return 0;
	let deleted = 0;
	for (const key of keys) {
		if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
		delete record[key];
		deleted += 1;
	}
	if (deleted === 0) return 0;
	if (Object.keys(record).length === 0) delete config[extensionId];
	if (Object.keys(config).length === 0) delete manager.config;
	writeSettingsFile(file);
	return deleted;
}

function resetConfigKeys(inventory: Inventory, extensionId: string, keys: Iterable<string>): number {
	const keySet = new Set(keys);
	if (keySet.size === 0) return 0;
	let deleted = 0;
	for (const file of inventory.settingsFiles.filter((candidate) => candidate.scope === "user" || candidate.scope === "project")) {
		deleted += deleteConfigKeysFromFile(file, extensionId, keySet);
	}
	return deleted;
}

function hasDeferredApply(schemas: SettingsSchema[]): boolean {
	return schemas.some((schema) => {
		const apply = schema.apply ?? (schema.requiresReload ? "reload" : "live");
		return apply !== "live";
	});
}

function notifyReset(ctx: ExtensionCommandContext | ExtensionContext, label: string, schemas: SettingsSchema[]): void {
	ctx.ui.notify(`${label} reset to default${schemas.length === 1 ? "" : "s"}.${hasDeferredApply(schemas) ? " Reload/restart may be required for deferred settings." : ""}`, hasDeferredApply(schemas) ? "warning" : "info");
}

function parseSettingInput(schema: SettingsSchema, input: string): unknown {
	switch (schema.type) {
		case "boolean": {
			const lower = input.trim().toLowerCase();
			if (["true", "yes", "on", "1", "enabled"].includes(lower)) return true;
			if (["false", "no", "off", "0", "disabled"].includes(lower)) return false;
			throw new Error("Expected boolean: true/false, on/off, yes/no");
		}
		case "number": {
			const parsed = Number(input.trim());
			if (!Number.isFinite(parsed)) throw new Error("Expected a number");
			return parsed;
		}
		case "enum": {
			const value = input.trim();
			if (schema.enumValues?.length && !schema.enumValues.includes(value)) {
				throw new Error(`Expected one of: ${schema.enumValues.join(", ")}`);
			}
			return value;
		}
		case "secret":
		case "path":
		case "string":
			return input;
	}
}

function nextSettingValue(schema: SettingsSchema, current: unknown): unknown {
	if (schema.type === "boolean") return !(current === true);
	if (schema.type === "enum" && schema.enumValues?.length) {
		const idx = schema.enumValues.indexOf(String(current ?? schema.default ?? ""));
		return schema.enumValues[(idx + 1 + schema.enumValues.length) % schema.enumValues.length];
	}
	return current;
}

function formatSettingValue(schema: SettingsSchema, value: unknown): string {
	if (schema.secret) return value == null || value === "" ? "(unset)" : "••••••";
	if (value === undefined) return "(unset)";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function isPlainSearchInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function packageTabId(packageName: string): TopTab {
	return `${PACKAGE_TAB_PREFIX}${packageName}`;
}

function packageNameForTab(tab: TopTab): string | undefined {
	return tab.startsWith(PACKAGE_TAB_PREFIX) ? tab.slice(PACKAGE_TAB_PREFIX.length) : undefined;
}

function isInventoryTab(tab: TopTab): boolean {
	return tab === TAB_ALL || packageNameForTab(tab) !== undefined;
}

function itemBelongsToPackage(item: InventoryItem, packageName: string): boolean {
	return item.packageName === packageName || item.sourceName === packageName || item.provider === packageName || item.sourcePath.includes(`/packages/${packageName}/`);
}

function managerTabs(inventory: Inventory): ManagerTab[] {
	const tabs: ManagerTab[] = [{ id: TAB_ALL, label: "All" }];
	const seen = new Set<string>();
	for (const item of [...inventory.packages].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
		if (!item.packageName || item.state === "shadowed" || seen.has(item.packageName)) continue;
		seen.add(item.packageName);
		tabs.push({ id: packageTabId(item.packageName), label: item.displayName, packageName: item.packageName });
	}
	return tabs;
}

function selectedPackageForSetting(item: InventoryItem): string | undefined {
	return item.packageName ?? (item.kind === "package" ? item.displayName : undefined);
}

function childItemsForPackage(items: InventoryItem[], packageName: string): InventoryItem[] {
	return items.filter((item) => item.kind !== "package" && itemBelongsToPackage(item, packageName)).sort(compareInventoryItems);
}

function itemSearchText(item: InventoryItem, allItems: InventoryItem[]): string {
	const own = [item.displayName, item.kind, item.provider, item.description, item.sourcePath, item.stateReason, item.trigger].join("\n");
	if (item.kind !== "package" || !item.packageName) return own.toLowerCase();
	const children = childItemsForPackage(allItems, item.packageName)
		.map((child) => [child.displayName, child.kind, child.description, child.trigger, child.sourcePath].join("\n"))
		.join("\n");
	return `${own}\n${children}`.toLowerCase();
}

function packageSummaryMatches(item: InventoryItem, allItems: InventoryItem[], ui: ManagerUiState): boolean {
	const related = item.packageName ? [item, ...childItemsForPackage(allItems, item.packageName)] : [item];
	if (ui.kindFilter !== "all" && !related.some((candidate) => candidate.kind === ui.kindFilter)) return false;
	if (ui.providerFilter !== "all" && !related.some((candidate) => candidate.provider === ui.providerFilter)) return false;
	if (ui.stateFilter !== "all" && !related.some((candidate) => candidate.state === ui.stateFilter)) return false;
	if (ui.scopeFilter !== "all" && !related.some((candidate) => candidate.scope === ui.scopeFilter)) return false;
	return true;
}

function itemMatchesFilters(item: InventoryItem, allItems: InventoryItem[], ui: ManagerUiState, packageSummary: boolean): boolean {
	if (packageSummary) return packageSummaryMatches(item, allItems, ui);
	if (ui.kindFilter !== "all" && item.kind !== ui.kindFilter) return false;
	if (ui.providerFilter !== "all" && item.provider !== ui.providerFilter) return false;
	if (ui.stateFilter !== "all" && item.state !== ui.stateFilter) return false;
	if (ui.scopeFilter !== "all" && item.scope !== ui.scopeFilter) return false;
	return true;
}

function filteredItems(items: InventoryItem[], ui: ManagerUiState): InventoryItem[] {
	const query = ui.search.trim().toLowerCase();
	const packageName = packageNameForTab(ui.topTab);
	const allPackageSummary = ui.topTab === TAB_ALL && !ui.showResources;
	const base = packageName
		? items.filter((item) => itemBelongsToPackage(item, packageName))
		: allPackageSummary
			? items.filter((item) => item.kind === "package")
			: items;
	const fallback = allPackageSummary && base.length === 0 ? items : base;
	return fallback.filter((item) => {
		const packageSummary = allPackageSummary && item.kind === "package";
		if (query && !itemSearchText(item, items).includes(query)) return false;
		return itemMatchesFilters(item, items, ui, packageSummary);
	});
}

interface ManagerUiState {
	topTab: TopTab;
	pane: Pane;
	search: string;
	selected: number;
	settingSelected: number;
	scroll: number;
	settingScroll: number;
	diagnosticsScroll: number;
	kindFilter: string;
	providerFilter: string;
	stateFilter: string;
	scopeFilter: string;
	showAudit: boolean;
	showResources: boolean;
	editing?: InlineEditState & { itemId: string; settingKey: string };
}

interface InlineEditState {
	buffer: string;
	cursor: number;
}

interface InlineEditChar {
	ch: string;
	start: number;
	end: number;
}

function inlineEditChars(text: string): InlineEditChar[] {
	const out: InlineEditChar[] = [];
	let offset = 0;
	for (const ch of text) {
		const start = offset;
		offset += ch.length;
		out.push({ ch, start, end: offset });
	}
	return out;
}

function clampInlineCursor(editing: InlineEditState): void {
	editing.cursor = Math.max(0, Math.min(editing.cursor, editing.buffer.length));
}

function codeUnitToCharIndex(chars: InlineEditChar[], cursor: number): number {
	let index = 0;
	while (index < chars.length && chars[index]!.end <= cursor) index += 1;
	return index;
}

function charIndexToCodeUnit(chars: InlineEditChar[], index: number, textLength: number): number {
	if (index <= 0) return 0;
	if (index >= chars.length) return textLength;
	return chars[index]!.start;
}

function inlineCharKind(ch: string): "space" | "word" | "punct" {
	if (/\s/u.test(ch)) return "space";
	if (/[A-Za-z0-9_]/.test(ch)) return "word";
	return "punct";
}

function moveInlineCursorByChars(editing: InlineEditState, delta: number): void {
	const chars = inlineEditChars(editing.buffer);
	const index = codeUnitToCharIndex(chars, editing.cursor);
	editing.cursor = charIndexToCodeUnit(chars, index + delta, editing.buffer.length);
}

function moveInlineCursorWordLeft(editing: InlineEditState): void {
	const chars = inlineEditChars(editing.buffer);
	let index = codeUnitToCharIndex(chars, editing.cursor);
	while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === "space") index -= 1;
	if (index <= 0) {
		editing.cursor = 0;
		return;
	}
	const kind = inlineCharKind(chars[index - 1]!.ch);
	while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === kind) index -= 1;
	editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

function moveInlineCursorWordRight(editing: InlineEditState): void {
	const chars = inlineEditChars(editing.buffer);
	let index = codeUnitToCharIndex(chars, editing.cursor);
	while (index < chars.length && inlineCharKind(chars[index]!.ch) === "space") index += 1;
	if (index >= chars.length) {
		editing.cursor = editing.buffer.length;
		return;
	}
	const kind = inlineCharKind(chars[index]!.ch);
	while (index < chars.length && inlineCharKind(chars[index]!.ch) === kind) index += 1;
	editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

function insertInlineText(editing: InlineEditState, text: string): void {
	clampInlineCursor(editing);
	editing.buffer = `${editing.buffer.slice(0, editing.cursor)}${text}${editing.buffer.slice(editing.cursor)}`;
	editing.cursor += text.length;
}

function deleteInlineRange(editing: InlineEditState, start: number, end: number): void {
	const safeStart = Math.max(0, Math.min(start, editing.buffer.length));
	const safeEnd = Math.max(safeStart, Math.min(end, editing.buffer.length));
	editing.buffer = `${editing.buffer.slice(0, safeStart)}${editing.buffer.slice(safeEnd)}`;
	editing.cursor = safeStart;
}

function handleInlineEditInput(editing: InlineEditState, data: string): boolean {
	clampInlineCursor(editing);
	if (matchesKey(data, "left") || matchesKey(data, "ctrl+b")) {
		moveInlineCursorByChars(editing, -1);
		return true;
	}
	if (matchesKey(data, "right") || matchesKey(data, "ctrl+f")) {
		moveInlineCursorByChars(editing, 1);
		return true;
	}
	if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left") || matchesKey(data, "alt+b")) {
		moveInlineCursorWordLeft(editing);
		return true;
	}
	if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right") || matchesKey(data, "alt+f")) {
		moveInlineCursorWordRight(editing);
		return true;
	}
	if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
		editing.cursor = 0;
		return true;
	}
	if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
		editing.cursor = editing.buffer.length;
		return true;
	}
	if (matchesKey(data, "backspace")) {
		const before = editing.cursor;
		moveInlineCursorByChars(editing, -1);
		deleteInlineRange(editing, editing.cursor, before);
		return true;
	}
	if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
		const start = editing.cursor;
		moveInlineCursorByChars(editing, 1);
		deleteInlineRange(editing, start, editing.cursor);
		return true;
	}
	if (matchesKey(data, "ctrl+u")) {
		editing.buffer = "";
		editing.cursor = 0;
		return true;
	}
	if (isPlainSearchInput(data)) {
		insertInlineText(editing, data);
		return true;
	}
	return false;
}

function renderInlineEditValue(editing: InlineEditState): string {
	clampInlineCursor(editing);
	return `${editing.buffer.slice(0, editing.cursor)}█${editing.buffer.slice(editing.cursor)}`;
}

function makeInitialUiState(initialTab: TopTab): ManagerUiState {
	return {
		kindFilter: "all",
		pane: "list",
		providerFilter: "all",
		scopeFilter: "all",
		search: "",
		selected: 0,
		settingScroll: 0,
		settingSelected: 0,
		diagnosticsScroll: 0,
		showAudit: false,
		showResources: false,
		stateFilter: "all",
		topTab: initialTab,
		scroll: 0,
	};
}

type UninstallMethod =
	| { kind: "vstack"; packageName: string; scope: Scope }
	| { kind: "npm"; npmName: string; scope: Scope; cwd: string }
	| { kind: "orphan"; packageName: string; scope: Scope };

interface UninstallPlan {
	item: InventoryItem;
	method: UninstallMethod;
	command: string;
	description: string;
}

function planUninstall(item: InventoryItem, inventory: Inventory, ctx: ExtensionCommandContext | ExtensionContext): UninstallPlan | undefined {
	if (item.kind !== "package" || !item.packageName) return undefined;
	const sourceIndex = loadSourceIndex(inventory.settingsFiles);
	const scopeFlag = item.scope === "user" ? " --global" : "";
	if (sourceIndex[item.packageName]) {
		return {
			item,
			method: { kind: "vstack", packageName: item.packageName, scope: item.scope },
			command: `vstack remove ${item.packageName}${scopeFlag}`,
			description: "Installed via vstack — runs the vstack remove command (deletes the package directory, the settings.json entry, and the source-index entry).",
		};
	}
	const npmName = npmPackageNameFromSource(item.sourceName);
	if (npmName) {
		const gFlag = item.scope === "user" ? " -g" : "";
		return {
			item,
			method: { kind: "npm", npmName, scope: item.scope, cwd: ctx.cwd },
			command: `npm uninstall${gFlag} ${npmName}`,
			description: "Installed via npm — runs npm uninstall, then strips the npm: entry from Pi settings.json.",
		};
	}
	return {
		item,
		method: { kind: "orphan", packageName: item.packageName, scope: item.scope },
		command: `(strip ${item.sourceName} from ${item.scope} settings.json)`,
		description: "No vstack source-index entry and no npm: prefix — only the Pi settings.json entry will be removed.",
	};
}

function removePackageEntryFromSettings(item: InventoryItem, files: SettingsFile[]): boolean {
	const file = findSettingsFile(files, item.scope);
	if (!Array.isArray(file.json.packages)) return false;
	const before = file.json.packages.length;
	const next = file.json.packages.filter((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized) return true;
		if (normalized.resolved === item.sourcePath) return false;
		if (normalized.source === item.sourceName) return false;
		return true;
	});
	if (next.length === before) return false;
	if (next.length === 0) delete file.json.packages;
	else file.json.packages = next;
	writeSettingsFile(file);
	return true;
}

function runUninstall(plan: UninstallPlan, inventory: Inventory): { ok: boolean; message: string } {
	if (plan.method.kind === "vstack") {
		const args = ["remove", plan.method.packageName];
		if (plan.method.scope === "user") args.push("--global");
		const result = spawnSync("vstack", args, { encoding: "utf8" });
		if (result.error) return { ok: false, message: `Failed to launch vstack: ${stringifyError(result.error)}` };
		if ((result.status ?? 1) !== 0) {
			const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
			return { ok: false, message: `vstack remove failed: ${stderr}` };
		}
		return { ok: true, message: `Removed via vstack: ${plan.item.displayName}.` };
	}
	if (plan.method.kind === "npm") {
		const args = ["uninstall"];
		if (plan.method.scope === "user") args.push("-g");
		args.push(plan.method.npmName);
		const result = spawnSync("npm", args, { encoding: "utf8", cwd: plan.method.cwd });
		if (result.error) return { ok: false, message: `Failed to launch npm: ${stringifyError(result.error)}` };
		if ((result.status ?? 1) !== 0) {
			const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
			return { ok: false, message: `npm uninstall failed: ${stderr}` };
		}
		const stripped = removePackageEntryFromSettings(plan.item, inventory.settingsFiles);
		return { ok: true, message: `npm uninstall ${plan.method.npmName} succeeded${stripped ? "; removed Pi settings entry." : " (no settings entry to remove)."}` };
	}
	const stripped = removePackageEntryFromSettings(plan.item, inventory.settingsFiles);
	return stripped
		? { ok: true, message: `Removed ${plan.item.sourceName} from ${plan.item.scope} settings.json.` }
		: { ok: false, message: `Could not find a matching entry for ${plan.item.sourceName} in ${plan.item.scope} settings.json.` };
}

async function openManager(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, initialTab: TopTab = TAB_ALL): Promise<void> {
	const releaseModalLock = acquireVstackModalLock();
	try {
	let ui = makeInitialUiState(initialTab);
	while (true) {
		const inventory = buildInventory(pi, ctx as ExtensionContext);
		const action = await ctx.ui.custom<ManagerAction>(
			(tui, theme, _keybindings, done) => createManagerComponent(pi, ctx, inventory, ui, theme, () => tui.requestRender(), () => managerLayout(tui.terminal.rows), done),
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: DEFAULT_MAX_HEIGHT, width: DEFAULT_WIDTH_PERCENT } },
		);

		if (!action || action.type === "close") return;
		if (action.type === "edit-setting") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schema = item?.settingsSchema?.find((candidate) => candidate.key === action.settingKey);
			if (!item || !schema) continue;
			const extensionId = selectedPackageForSetting(item) ?? item.displayName;
			const current = getConfigValue(inventory, extensionId, schema).value;
			const prompt = `${schema.label ?? schema.key} (${schema.type}${schema.enumValues?.length ? `: ${schema.enumValues.join("|")}` : ""})`;
			const input = await ctx.ui.input(prompt, formatSettingValue({ ...schema, secret: false }, current));
			if (input === undefined) continue;
			try {
				const value = parseSettingInput(schema, input);
				setConfigValue(inventory, item, schema, value);
				pi.events.emit(SETTINGS_EVENT, { extensionId, key: schema.key, value });
				ctx.ui.notify(applyMessage(schema), schema.apply === "restart" || schema.requiresReload ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(stringifyError(error), "error");
			}
			continue;
		}
		if (action.type === "set-setting") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schema = item?.settingsSchema?.find((candidate) => candidate.key === action.settingKey);
			if (!item || !schema) continue;
			setConfigValue(inventory, item, schema, action.value);
			pi.events.emit(SETTINGS_EVENT, { extensionId: selectedPackageForSetting(item) ?? item.displayName, key: schema.key, value: action.value });
			ctx.ui.notify(applyMessage(schema), schema.apply === "restart" || schema.requiresReload ? "warning" : "info");
			continue;
		}
		if (action.type === "reset-setting") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schema = item?.settingsSchema?.find((candidate) => candidate.key === action.settingKey);
			if (!item || !schema) continue;
			const extensionId = selectedPackageForSetting(item) ?? item.displayName;
			if (!getConfigValue(inventory, extensionId, schema).explicit) {
				ctx.ui.notify(`${schema.label ?? schema.key} is already using its default.`, "info");
				continue;
			}
			resetConfigKeys(inventory, extensionId, [schema.key]);
			pi.events.emit(SETTINGS_EVENT, { extensionId, key: schema.key, value: schema.default });
			notifyReset(ctx, schema.label ?? schema.key, [schema]);
			continue;
		}
		if (action.type === "reset-settings") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schemas = item?.settingsSchema?.filter((schema) => schema.type !== "secret") ?? [];
			if (!item || schemas.length === 0) continue;
			const extensionId = selectedPackageForSetting(item) ?? item.displayName;
			const explicitSchemas = schemas.filter((schema) => getConfigValue(inventory, extensionId, schema).explicit);
			if (explicitSchemas.length === 0) {
				ctx.ui.notify(`${item.displayName} settings are already using defaults.`, "info");
				continue;
			}
			resetConfigKeys(inventory, extensionId, explicitSchemas.map((schema) => schema.key));
			for (const schema of explicitSchemas) pi.events.emit(SETTINGS_EVENT, { extensionId, key: schema.key, value: schema.default });
			notifyReset(ctx, `${item.displayName} settings`, explicitSchemas);
			continue;
		}
		if (action.type === "toggle-item") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			if (item) toggleItem(pi, ctx, inventory, item);
			continue;
		}
		if (action.type === "toggle-provider") {
			toggleProvider(pi, ctx, inventory, action.provider);
			continue;
		}
		if (action.type === "uninstall-package") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			if (!item) continue;
			if (item.packageName === MANAGER_ID) {
				ctx.ui.notify("Refusing to uninstall pi-extension-manager from inside itself.", "warning");
				continue;
			}
			const plan = planUninstall(item, inventory, ctx);
			if (!plan) {
				ctx.ui.notify(`${item.displayName} is not an uninstallable package.`, "warning");
				continue;
			}
			const body = [
				`Package: ${plan.item.packageName}`,
				`Scope: ${plan.item.scope}`,
				`Source: ${plan.item.sourceName}`,
				"",
				plan.description,
				"",
				`Will run: ${plan.command}`,
			].join("\n");
			const confirmed = await ctx.ui.confirm(`Uninstall ${plan.item.displayName}?`, body);
			if (!confirmed) continue;
			const result = runUninstall(plan, inventory);
			if (result.ok) ctx.ui.notify(`${result.message} Run /reload to apply.`, "warning");
			else ctx.ui.notify(result.message, "error");
			continue;
		}
	}
	} finally {
		releaseModalLock();
	}
}

function applyMessage(schema: SettingsSchema): string {
	const apply = schema.apply ?? (schema.requiresReload ? "reload" : "live");
	if (apply === "live") return "Setting saved and available to extensions immediately.";
	if (apply === "reload") return "Setting saved. Run /reload for extensions that read it at load time.";
	if (apply === "session") return "Setting saved. Start/resume a session to fully apply it.";
	return "Setting saved. Restart Pi to fully apply it.";
}

function toggleItem(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, item: InventoryItem): void {
	if ((item.id === `package:${MANAGER_ID}` || item.packageName === MANAGER_ID) && item.state !== "disabled") {
		ctx.ui.notify("Refusing to disable pi-extension-manager from inside itself. Edit settings.json manually if needed.", "warning");
		return;
	}
	const scope = defaultWriteScope(item, inventory.settingsFiles, inventory.managerState);
	const file = findSettingsFile(inventory.settingsFiles, scope);
	const disabled = new Set(inventory.managerState.disabledItems);
	const currentlyDisabled = item.state === "disabled" || disabled.has(item.id);
	const willDisable = !currentlyDisabled;
	if (willDisable) disabled.add(item.id);
	else disabled.delete(item.id);
	updateManagerState(file, (state) => {
		state.disabledItems = [...disabled].sort();
	});

	if (item.kind === "tool") {
		const active = new Set(safeActiveTools(pi));
		if (willDisable) active.delete(item.displayName);
		else active.add(item.displayName);
		pi.setActiveTools?.([...active]);
		ctx.ui.notify(`${item.displayName} ${willDisable ? "disabled" : "enabled"} live.`, "info");
		return;
	}

	if (item.kind === "package" && item.packageName) {
		const changed = setPackageFiltered(item, inventory.settingsFiles, willDisable);
		ctx.ui.notify(changed ? "Package setting updated. Run /reload or restart Pi to apply module loading changes." : "Item toggle saved. Reload may be required.", "warning");
		return;
	}

	if (item.kind === "extension module" && item.packageName && item.entrypoint) {
		const changed = setPackageExtensionFiltered(item, inventory.settingsFiles, willDisable);
		ctx.ui.notify(changed ? "Extension module filter updated. Run /reload or restart Pi to apply." : "Module toggle saved. Reload may be required.", "warning");
		return;
	}

	ctx.ui.notify("Item toggle saved. Pi cannot unload this resource type live; /reload or restart may be required.", "warning");
}

function setPackageFiltered(item: InventoryItem, files: SettingsFile[], disabled: boolean): boolean {
	const file = findSettingsFile(files, item.scope);
	const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
	let changed = false;
	const next = packages.map((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized || normalized.resolved !== item.sourcePath) return entry;
		changed = true;
		const record = asRecord(entry);
		if (disabled) {
			return record ? { ...record, extensions: [] } : { source: normalized.source, extensions: [] };
		}
		if (record) {
			const restored = { ...record };
			if (Array.isArray(restored.extensions) && restored.extensions.length === 0) delete restored.extensions;
			return Object.keys(restored).length === 1 && restored.source === normalized.source ? normalized.source : restored;
		}
		return normalized.source;
	});
	if (changed) {
		file.json.packages = next;
		writeSettingsFile(file);
	}
	return changed;
}

function setPackageExtensionFiltered(item: InventoryItem, files: SettingsFile[], disabled: boolean): boolean {
	if (!item.packageDir || !item.entrypoint) return false;
	const file = findSettingsFile(files, item.scope);
	const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
	const exclude = `-${item.entrypoint}`;
	let changed = false;
	const next = packages.map((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized || normalized.resolved !== item.packageDir) return entry;
		changed = true;
		const record = asRecord(entry);
		const filters = Array.isArray(record?.extensions) ? record!.extensions.filter((value): value is string => typeof value === "string") : [];
		const withoutThis = filters.filter((value) => value !== exclude && value !== `!${item.entrypoint}`);
		if (disabled) {
			const extensions = withoutThis.includes(exclude) ? withoutThis : [...withoutThis, exclude];
			return record ? { ...record, extensions } : { source: normalized.source, extensions };
		}
		if (record) {
			const restored = { ...record };
			if (withoutThis.length > 0) restored.extensions = withoutThis;
			else delete restored.extensions;
			return Object.keys(restored).length === 1 && restored.source === normalized.source ? normalized.source : restored;
		}
		return normalized.source;
	});
	if (changed) {
		file.json.packages = next;
		writeSettingsFile(file);
	}
	return changed;
}

function toggleProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, provider: string): void {
	const file = findSettingsFile(inventory.settingsFiles, "project");
	const disabled = new Set(inventory.managerState.disabledProviders);
	if (disabled.has(provider)) disabled.delete(provider);
	else disabled.add(provider);
	updateManagerState(file, (state) => {
		state.disabledProviders = [...disabled].sort();
	});
	const active = new Set(safeActiveTools(pi));
	const itemDisabled = new Set(inventory.managerState.disabledItems);
	for (const tool of inventory.items.filter((item) => item.kind === "tool" && item.provider === provider)) {
		if (disabled.has(provider)) active.delete(tool.displayName);
		else if (!itemDisabled.has(tool.id)) active.add(tool.displayName);
	}
	pi.setActiveTools?.([...active]);
	ctx.ui.notify(`Provider ${provider} ${disabled.has(provider) ? "disabled" : "enabled"}. Package/module resources require /reload.`, "warning");
}

function createManagerComponent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	inventory: Inventory,
	ui: ManagerUiState,
	theme: Theme,
	requestRender: () => void,
	getLayout: () => PopupLayout,
	done: (value: ManagerAction) => void,
) {
	const topTabs = managerTabs(inventory);
	const providers = ["all", ...new Set(inventory.items.map((item) => item.provider))].sort();
	const kinds = ["all", ...new Set(inventory.items.map((item) => item.kind))].sort();
	const states = ["all", "active", "disabled", "shadowed", "broken"];
	const scopes = ["all", "project", "user", "temporary", "builtin", "unknown"];

	function clamp(): void {
		const layout = getLayout();
		if (!topTabs.some((tab) => tab.id === ui.topTab)) ui.topTab = TAB_ALL;
		if (!isInventoryTab(ui.topTab)) return;
		const list = filteredItems(inventory.items, ui);
		ui.selected = Math.max(0, Math.min(ui.selected, Math.max(0, list.length - 1)));
		ui.scroll = Math.max(0, Math.min(ui.scroll, Math.max(0, list.length - layout.listRows)));
		if (ui.selected < ui.scroll) ui.scroll = ui.selected;
		if (ui.selected >= ui.scroll + layout.listRows) ui.scroll = ui.selected - layout.listRows + 1;
		const selected = list[ui.selected];
		const settingCount = selected?.settingsSchema?.length ?? 0;
		ui.settingSelected = Math.max(0, Math.min(ui.settingSelected, Math.max(0, settingCount - 1)));
		if (ui.settingSelected < ui.settingScroll) ui.settingScroll = ui.settingSelected;
		if (ui.settingSelected >= ui.settingScroll + layout.settingsRows) ui.settingScroll = ui.settingSelected - layout.settingsRows + 1;
		ui.settingScroll = Math.max(0, Math.min(ui.settingScroll, Math.max(0, settingCount - layout.settingsRows)));
	}

	function cycle<T extends string>(values: T[], current: string, delta: number): T {
		const idx = Math.max(0, values.indexOf(current as T));
		return values[(idx + delta + values.length) % values.length]!;
	}

	function switchTab(delta: number): void {
		ui.topTab = cycle(topTabs.map((tab) => tab.id), ui.topTab, delta);
		ui.selected = 0;
		ui.scroll = 0;
		ui.settingSelected = 0;
		ui.settingScroll = 0;
		ui.diagnosticsScroll = 0;
		clamp();
		requestRender();
	}

	function diagnosticsMaxScroll(): number {
		const width = frameContentWidth(DEFAULT_WIDTH);
		return Math.max(0, renderDiagnostics(inventory, width, theme).length - diagnosticsPageRows());
	}

	function diagnosticsPageRows(): number {
		return Math.max(1, getLayout().innerRows - 5);
	}

	function scrollDiagnostics(delta: number): void {
		ui.diagnosticsScroll = Math.max(0, Math.min(ui.diagnosticsScroll + delta, diagnosticsMaxScroll()));
		requestRender();
	}

	function saveInlineEdit(): void {
		const editing = ui.editing;
		if (!editing) return;
		const item = inventory.items.find((candidate) => candidate.id === editing.itemId);
		const schema = item?.settingsSchema?.find((candidate) => candidate.key === editing.settingKey);
		if (!item || !schema) {
			ui.editing = undefined;
			requestRender();
			return;
		}
		try {
			const value = parseSettingInput(schema, editing.buffer);
			setConfigValue(inventory, item, schema, value);
			const extensionId = selectedPackageForSetting(item) ?? item.displayName;
			pi.events.emit(SETTINGS_EVENT, { extensionId, key: schema.key, value });
			const apply = schema.apply ?? (schema.requiresReload ? "reload" : "live");
			if (apply !== "live") ctx.ui.notify(applyMessage(schema), apply === "restart" ? "warning" : "info");
			ui.editing = undefined;
			requestRender();
		} catch (error) {
			ctx.ui.notify(stringifyError(error), "error");
		}
	}

	function handleInput(data: string): void {
		if (ui.editing) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				ui.editing = undefined;
				requestRender();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) return saveInlineEdit();
			if (handleInlineEditInput(ui.editing, data)) {
				requestRender();
			}
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done({ type: "close" });
		if (matchesKey(data, "tab")) {
			switchTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			switchTab(-1);
			return;
		}
		if (matchesKey(data, "alt+a")) {
			ui.showAudit = !ui.showAudit;
			ui.diagnosticsScroll = 0;
			requestRender();
			return;
		}
		if (ui.showAudit) {
			if (matchesKey(data, "up")) return scrollDiagnostics(-1);
			if (matchesKey(data, "down")) return scrollDiagnostics(1);
			if (matchesKey(data, "-") || matchesKey(data, "pageUp")) return scrollDiagnostics(-diagnosticsPageRows());
			if (matchesKey(data, "=") || matchesKey(data, "pageDown")) return scrollDiagnostics(diagnosticsPageRows());
			if (matchesKey(data, "home")) {
				ui.diagnosticsScroll = 0;
				requestRender();
				return;
			}
			if (matchesKey(data, "end")) {
				ui.diagnosticsScroll = diagnosticsMaxScroll();
				requestRender();
				return;
			}
			return;
		}
		if (!isInventoryTab(ui.topTab)) return;
		const list = filteredItems(inventory.items, ui);
		const selected = list[ui.selected];
		const settings = selected?.settingsSchema ?? [];
		if (matchesKey(data, "left")) {
			ui.pane = "list";
			requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			ui.pane = "settings";
			requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			if (ui.pane === "settings") ui.settingSelected -= 1;
			else ui.selected -= 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			if (ui.pane === "settings") ui.settingSelected += 1;
			else ui.selected += 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "-") || matchesKey(data, "pageUp")) {
			if (ui.pane === "settings") ui.settingSelected -= getLayout().settingsRows;
			else ui.selected -= getLayout().listRows;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "=") || matchesKey(data, "pageDown")) {
			if (ui.pane === "settings") ui.settingSelected += getLayout().settingsRows;
			else ui.selected += getLayout().listRows;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			ui.search = ui.search.slice(0, -1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			ui.search = "";
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if ((matchesKey(data, "delete") || matchesKey(data, "ctrl+x")) && selected) {
			if (matchesKey(data, "ctrl+x")) return done({ type: "reset-settings", itemId: selected.id });
			if (ui.pane === "settings" && settings.length > 0) {
				const schema = settings[ui.settingSelected];
				if (schema) return done({ type: "reset-setting", itemId: selected.id, settingKey: schema.key });
			}
		}
		if (isPlainSearchInput(data)) {
			ui.search += data;
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+k")) {
			ui.kindFilter = cycle(kinds, ui.kindFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+p")) {
			ui.providerFilter = cycle(providers, ui.providerFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+s")) {
			ui.stateFilter = cycle(states, ui.stateFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+o")) {
			ui.scopeFilter = cycle(scopes, ui.scopeFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+r")) {
			ui.showResources = !ui.showResources;
			ui.selected = 0;
			ui.scroll = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "alt+t") && selected) return done({ type: "toggle-provider", provider: selected.provider });
		if (matchesKey(data, "alt+u") && selected && selected.kind === "package") {
			return done({ type: "uninstall-package", itemId: selected.id });
		}
		if ((matchesKey(data, "enter") || matchesKey(data, "return")) && selected) {
			if (ui.pane === "settings" && settings.length > 0) {
				const schema = settings[ui.settingSelected];
				if (!schema) return;
				const extensionId = selectedPackageForSetting(selected) ?? selected.displayName;
				const current = getConfigValue(inventory, extensionId, schema).value;
				if (schema.type === "boolean" || schema.type === "enum") {
					return done({ type: "set-setting", itemId: selected.id, settingKey: schema.key, value: nextSettingValue(schema, current) });
				}
				const buffer = stringifySettingValue(current ?? schema.default ?? "");
				ui.editing = { buffer, cursor: buffer.length, itemId: selected.id, settingKey: schema.key };
				requestRender();
				return;
			}
			return done({ type: "toggle-item", itemId: selected.id });
		}
	}

	function render(width: number): string[] {
		clamp();
		const layout = getLayout();
		const safeWidth = Math.max(1, width);
		const bodyWidth = frameContentWidth(safeWidth);
		let lines: string[] = [];
		lines.push(renderTabBar(topTabs, ui.topTab, bodyWidth, theme));
		lines.push("");
		const primaryHint = ui.editing
			? `${theme.fg("dim", "editing value · ")}${ansiYellow("←/→")} ${theme.fg("dim", "move · ")}${ansiYellow("alt+←/→")} ${theme.fg("dim", "word · ")}${ansiYellow("enter")} ${theme.fg("dim", "save · ")}${ansiYellow("esc")} ${theme.fg("dim", "cancel · ")}${ansiYellow("backspace/delete")} ${theme.fg("dim", "delete · ")}${ansiYellow("ctrl+u")} ${theme.fg("dim", "clear")}`
			: ui.showAudit
			? `${theme.fg("dim", "diagnostics · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("Alt+A")} ${theme.fg("dim", "back · ")}${ansiYellow("esc")} ${theme.fg("dim", "close")}`
			: `${ansiYellow("tab")} ${theme.fg("dim", "switch tabs · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("Alt+A")} ${theme.fg("dim", "diagnostics · ")}${ansiYellow("esc")} ${theme.fg("dim", "close")}`;
		const footerLines = ["", ...wrapLine(primaryHint, bodyWidth)];
		const availableRows = Math.max(1, layout.innerRows - lines.length - footerLines.length);
		if (ui.showAudit) lines.push(...renderDiagnosticsViewport(inventory, ui, bodyWidth, theme, availableRows));
		else lines.push(...renderExtensions(inventory, ui, bodyWidth, theme, layout, footerLines.length));
		lines.push(...footerLines);
		return frame(lines, safeWidth, theme, layout.innerRows, "Extension Manager");
	}

	return { handleInput, invalidate() {}, render };
}

function managerActivePill(theme: Theme, label: string): string {
	return theme.fg("accent", theme.inverse(theme.bold(label)));
}

function managerInactivePill(theme: Theme, label: string): string {
	return theme.bg("selectedBg", theme.fg("accent", label));
}

function managerPaneTitle(theme: Theme, label: string, active: boolean): string {
	const padded = ` ${label} `;
	return active ? managerActivePill(theme, padded) : managerInactivePill(theme, padded);
}

function managerEntityTitle(theme: Theme, label: string): string {
	return theme.fg("accent", theme.bold(label));
}

function managerSectionTitle(theme: Theme, label: string): string {
	return theme.fg("muted", theme.bold(label));
}

function managerSelectedLine(theme: Theme, line: string, width: number): string {
	return theme.bg("selectedBg", pad(line, width));
}

function managerMutedForSelection(theme: Theme, text: string, selected: boolean): string {
	return theme.fg(selected ? "text" : "dim", text);
}

function renderTabBar(tabs: ManagerTab[], active: TopTab, width: number, theme: Theme): string {
	const safeWidth = Math.max(1, width);
	if (tabs.length === 0) return " ".repeat(safeWidth);
	const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === active));
	const widths = tabs.map((tab) => visibleWidth(tab.label) + 2);
	const sliceWidth = (s: number, e: number): number => {
		let total = 0;
		for (let i = s; i < e; i += 1) total += widths[i]!;
		total += Math.max(0, e - s - 1); // single-space gaps between tabs
		total += s > 0 ? 2 : 0; // "‹ "
		total += e < tabs.length ? 2 : 0; // " ›"
		return total;
	};

	let start = activeIndex;
	let end = activeIndex + 1;
	let preferRight = true;
	while (start > 0 || end < tabs.length) {
		let progressed = false;
		const tryRight = (): boolean => {
			if (end < tabs.length && sliceWidth(start, end + 1) <= safeWidth) {
				end += 1;
				return true;
			}
			return false;
		};
		const tryLeft = (): boolean => {
			if (start > 0 && sliceWidth(start - 1, end) <= safeWidth) {
				start -= 1;
				return true;
			}
			return false;
		};
		if (preferRight) {
			if (tryRight()) progressed = true;
			if (tryLeft()) progressed = true;
		} else {
			if (tryLeft()) progressed = true;
			if (tryRight()) progressed = true;
		}
		if (!progressed) break;
		preferRight = !preferRight;
	}

	const cells = tabs.slice(start, end).map((tab) => {
		const label = ` ${tab.label} `;
		return tab.id === active ? managerActivePill(theme, label) : managerInactivePill(theme, label);
	});
	if (start > 0) cells.unshift(theme.fg("dim", "‹"));
	if (end < tabs.length) cells.push(theme.fg("dim", "›"));
	return pad(cells.join(" "), safeWidth);
}

function renderDiagnosticsViewport(inventory: Inventory, ui: ManagerUiState, width: number, theme: Theme, viewportRows: number): string[] {
	const all = renderDiagnostics(inventory, width, theme);
	viewportRows = Math.max(1, viewportRows);
	if (all.length <= viewportRows) {
		ui.diagnosticsScroll = 0;
		return all;
	}
	const contentRows = Math.max(1, viewportRows - 1);
	ui.diagnosticsScroll = Math.max(0, Math.min(ui.diagnosticsScroll, Math.max(0, all.length - contentRows)));
	const visible = all.slice(ui.diagnosticsScroll, ui.diagnosticsScroll + contentRows);
	const before = ui.diagnosticsScroll > 0 ? `↑ ${ui.diagnosticsScroll}` : "";
	const afterCount = Math.max(0, all.length - ui.diagnosticsScroll - contentRows);
	const after = afterCount > 0 ? `↓ ${afterCount}` : "";
	return [...visible, theme.fg("dim", [before, after].filter(Boolean).join(" · "))];
}

function renderDiagnostics(inventory: Inventory, width: number, theme: Theme): string[] {
	const counts = countBy(inventory.items, (item) => item.state);
	const kinds = countBy(inventory.items, (item) => item.kind);
	const lines = [
		managerEntityTitle(theme, "Diagnostics"),
		`Inventory: ${inventory.items.length} resources · ${counts.active ?? 0} active · ${counts.disabled ?? 0} disabled · ${counts.shadowed ?? 0} shadowed · ${counts.broken ?? 0} broken`,
		`Kinds: ${Object.entries(kinds).map(([kind, count]) => `${kind}=${count}`).join(", ")}`,
		"",
		managerSectionTitle(theme, "Settings files"),
	];
	for (const file of inventory.settingsFiles) lines.push(`${file.scope}: ${compactPath(file.path)}${file.exists ? "" : " (not created yet)"}`);
	lines.push("", managerSectionTitle(theme, "Package manifests"));
	if (inventory.auditLines.length === 0) lines.push(theme.fg("dim", "No package manifests found in current Pi settings."));
	for (const block of inventory.auditLines) {
		const [head, ...rest] = block.split("\n");
		lines.push(managerSectionTitle(theme, head ?? "package"));
		for (const line of rest.slice(0, 3)) lines.push(theme.fg("dim", line));
	}
	lines.push("", theme.fg("warning", "Runtime note"));
	lines.push("Pi cannot unload already-loaded extension modules live. Package/module toggles apply after /reload or restart; tool toggles apply live.");
	return lines.flatMap((line) => wrapLine(line, width));
}

function renderExtensions(inventory: Inventory, ui: ManagerUiState, width: number, theme: Theme, layout: PopupLayout, footerRows = 0): string[] {
	const list = filteredItems(inventory.items, ui);
	const selected = list[ui.selected];
	const leftWidth = Math.max(Math.min(LEFT_MIN_WIDTH, Math.floor(width * 0.45)), Math.min(LEFT_MAX_WIDTH, Math.floor(width * 0.38)));
	const rightWidth = Math.max(20, width - leftWidth - 3);
	const left = renderList(list, ui, leftWidth, theme, layout.listRows);
	const rows = layout.bodyRows;
	const right = renderInspector(inventory, selected, ui, rightWidth, theme, layout.settingsRows, rows);
	const view = ui.topTab === TAB_ALL ? (ui.showResources ? "raw resources" : "packages") : "package";
	const searchText = ` > ${ui.search}${theme.inverse(" ")}`;
	const searchLine = theme.bg("toolPendingBg", pad(searchText, width));
	const filterLine = `${theme.fg("muted", "View")}: ${theme.fg("text", view)}  ${theme.fg("muted", "Filters")}: kind ${ui.kindFilter} · provider ${ui.providerFilter} · state ${ui.stateFilter} · scope ${ui.scopeFilter}`;
	const hintLine = `${ansiYellow("Alt+K/P/S/O")} ${theme.fg("dim", "filters · ")}${ansiYellow("Alt+R")} ${theme.fg("dim", "raw resources · ")}${ansiYellow("Alt+T")} ${theme.fg("dim", "toggle provider · ")}${ansiYellow("Alt+U")} ${theme.fg("dim", "uninstall package · ")}${ansiYellow("delete")} ${theme.fg("dim", "reset setting · ")}${ansiYellow("ctrl+x")} ${theme.fg("dim", "reset extension · ")}${ansiYellow("←/→")} ${theme.fg("dim", "pane")}`;
	const lines = [searchLine, ...wrapLine(filterLine, width), "", ...wrapLine(hintLine, width), divider(width, theme)];
	const tableRows = Math.max(1, rows - Math.max(0, lines.length - 5) - footerRows);
	for (let i = 0; i < tableRows; i += 1) {
		lines.push(`${pad(left[i] ?? "", leftWidth)} ${theme.fg("dim", "│")} ${truncateToWidth(right[i] ?? "", rightWidth, "")}`);
	}
	return lines;
}

function listDisplayName(item: InventoryItem, ui: ManagerUiState): string {
	if (packageNameForTab(ui.topTab) && item.kind === "package") return "Overview";
	if (item.kind === "extension module") return (item.entrypoint ?? item.displayName).replace(/^\.\//, "");
	return item.displayName;
}

function renderList(items: InventoryItem[], ui: ManagerUiState, width: number, theme: Theme, listRows: number): string[] {
	const title = packageNameForTab(ui.topTab) ? "Package" : ui.showResources ? "Resources" : "Packages";
	const lines = [`${managerPaneTitle(theme, title, ui.pane === "list")} ${theme.fg("dim", `(${items.length})`)}`, ""];
	if (items.length === 0) {
		lines.push(theme.fg("dim", "No matching items."));
		return lines;
	}
	if (ui.scroll > 0) lines.push(theme.fg("dim", `↑ ${ui.scroll} earlier`));
	for (const [visibleIndex, item] of items.slice(ui.scroll, ui.scroll + listRows).entries()) {
		const index = ui.scroll + visibleIndex;
		const selected = index === ui.selected;
		const marker = " ";
		const stateIcon = item.state === "active" ? theme.fg("success", "●") : item.state === "disabled" ? theme.fg("warning", "○") : item.state === "shadowed" ? theme.fg(selected ? "text" : "dim", "◌") : theme.fg("error", "×");
		const name = selected ? theme.fg("text", listDisplayName(item, ui)) : listDisplayName(item, ui);
		const meta = managerMutedForSelection(theme, ` ${kindLabel(item.kind)} · ${item.scope}`, selected);
		const updateBadge = item.updateAvailable && item.latestVersion ? ` ${ansiYellow(`↑ ${item.latestVersion}`)}` : "";
		const row = truncateToWidth(`${marker}${stateIcon} ${name}${meta}${updateBadge}`, width, "…");
		lines.push(selected ? managerSelectedLine(theme, row, width) : row);
	}
	const hidden = Math.max(0, items.length - (ui.scroll + listRows));
	if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
	return lines;
}

function shortResourceName(item: InventoryItem): string {
	if (item.kind === "extension module") return (item.entrypoint ?? item.displayName).replace(/^\.\//, "");
	return item.trigger ?? item.displayName;
}

function packageResourceLines(inventory: Inventory, item: InventoryItem, width: number, theme: Theme): string[] {
	if (item.kind !== "package" || !item.packageName) return [];
	const children = childItemsForPackage(inventory.items, item.packageName);
	if (children.length === 0) return [];
	const groups = new Map<string, InventoryItem[]>();
	for (const child of children) {
		const label = kindLabel(child.kind);
		groups.set(label, [...(groups.get(label) ?? []), child]);
	}
	const lines = ["", managerSectionTitle(theme, `Resources (${children.length})`)];
	for (const [label, group] of [...groups.entries()].sort((a, b) => kindRank(a[0]) - kindRank(b[0]) || a[0].localeCompare(b[0]))) {
		const names = group.slice(0, 4).map(shortResourceName).join(", ");
		const suffix = group.length > 4 ? `, +${group.length - 4} more` : "";
		lines.push(truncateToWidth(`${theme.fg("muted", label)} (${group.length}): ${names}${suffix}`, width, "…"));
	}
	return lines;
}

function renderInspector(inventory: Inventory, item: InventoryItem | undefined, ui: ManagerUiState, width: number, theme: Theme, settingsRows: number, viewportRows: number): string[] {
	if (!item) return [theme.fg("dim", "Select an item to inspect it.")];
	const detailLines = [
		`${managerEntityTitle(theme, item.displayName)} ${theme.fg(stateColor(item.state), item.state)}`,
		item.description ? theme.fg("text", item.description) : theme.fg("dim", "No description."),
		"",
		`${theme.fg("muted", "Kind")}: ${kindLabel(item.kind)}    ${theme.fg("muted", "Scope")}: ${item.scope}`,
		`${theme.fg("muted", "Provider")}: ${item.provider}`,
		`${theme.fg("muted", "Source")}: ${compactPath(item.sourcePath)}`,
		`${theme.fg("muted", "State")}: ${item.stateReason}`,
	];
	if (item.installedVersion || item.latestVersion) {
		const current = item.installedVersion ?? "unknown";
		if (item.updateAvailable && item.latestVersion) {
			const src = item.updateSource === "npm" ? "npm" : "vstack source";
			detailLines.push(`${theme.fg("muted", "Version")}: ${current} ${ansiYellow(`↑ ${item.latestVersion}`)} ${theme.fg("dim", `(${src})`)}`);
			if (item.updateCommand) {
				detailLines.push(`${theme.fg("muted", "Update")}: ${ansiYellow(item.updateCommand)}`);
			}
		} else if (item.latestVersion) {
			detailLines.push(`${theme.fg("muted", "Version")}: ${current} ${theme.fg("dim", `(latest ${item.latestVersion})`)}`);
		} else {
			detailLines.push(`${theme.fg("muted", "Version")}: ${current}`);
		}
	}
	if (item.trigger) detailLines.push(`${theme.fg("muted", "Trigger")}: ${item.trigger}`);
	if (item.shadowedBy) detailLines.push(`${theme.fg("muted", "Shadowed by")}: ${item.shadowedBy}`);
	if (item.brokenError) detailLines.push(`${theme.fg("error", "Error")}: ${item.brokenError}`);
	detailLines.push(...packageResourceLines(inventory, item, width, theme));

	const schemas = item.settingsSchema ?? [];
	const settingsHeader = ["", managerPaneTitle(theme, "Settings", ui.pane === "settings"), ""];
	const safeViewportRows = Math.max(1, viewportRows);
	const minimumSettingsRows = schemas.length > 0 ? Math.min(safeViewportRows, ui.pane === "settings" ? 6 : 3) : 1;
	const maxDetailRows = Math.max(0, safeViewportRows - settingsHeader.length - minimumSettingsRows);
	const clippedDetails = detailLines.length > maxDetailRows
		? [...detailLines.slice(0, Math.max(0, maxDetailRows - 1)), theme.fg("dim", "… details clipped")]
		: detailLines;
	const lines = [...clippedDetails, ...settingsHeader];

	if (schemas.length === 0) {
		lines.push(theme.fg("dim", "No declared settings schema for this item."));
		return lines.flatMap((line) => wrapLine(line, width)).slice(0, safeViewportRows);
	}

	const extensionId = selectedPackageForSetting(item) ?? item.displayName;
	const settingViewportRows = Math.max(1, safeViewportRows - lines.length);
	ui.settingSelected = Math.max(0, Math.min(ui.settingSelected, Math.max(0, schemas.length - 1)));
	const selectedSchema = schemas[ui.settingSelected];
	const hasSelectedDescription = Boolean(selectedSchema?.description);
	const maxVisibleSettings = Math.max(1, Math.min(settingsRows, settingViewportRows - 2 - (hasSelectedDescription ? 2 : 0)));
	if (ui.settingSelected < ui.settingScroll) ui.settingScroll = ui.settingSelected;
	if (ui.settingSelected >= ui.settingScroll + maxVisibleSettings) ui.settingScroll = ui.settingSelected - maxVisibleSettings + 1;
	ui.settingScroll = Math.max(0, Math.min(ui.settingScroll, Math.max(0, schemas.length - maxVisibleSettings)));

	const settingLines: string[] = [];
	if (ui.settingScroll > 0) settingLines.push(theme.fg("dim", `↑ ${ui.settingScroll} earlier setting(s)`));
	for (const [visibleIndex, schema] of schemas.slice(ui.settingScroll, ui.settingScroll + maxVisibleSettings).entries()) {
		const index = ui.settingScroll + visibleIndex;
		const selected = index === ui.settingSelected;
		const config = getConfigValue(inventory, extensionId, schema);
		const marker = " ";
		const isEditing = ui.editing?.itemId === item.id && ui.editing?.settingKey === schema.key;
		const value = isEditing && ui.editing ? renderInlineEditValue(ui.editing) : formatSettingValue(schema, config.value);
		const valueText = theme.fg(isEditing ? "accent" : config.explicit ? "success" : selected ? "text" : "muted", value);
		const label = selected ? theme.fg("text", schema.label ?? schema.key) : schema.label ?? schema.key;
		const row = truncateToWidth(`${marker}${label}: ${valueText}`, width, "…");
		settingLines.push(selected ? managerSelectedLine(theme, row, width) : row);
		if (selected && !isEditing && schema.description) settingLines.push(...wrapDescription(schema.description, width, theme, "  "));
	}
	const hidden = Math.max(0, schemas.length - (ui.settingScroll + maxVisibleSettings));
	if (hidden > 0) settingLines.push(theme.fg("dim", `↓ ${hidden} more setting(s)`));
	lines.push(...settingLines.slice(0, settingViewportRows));
	return lines.flatMap((line) => wrapLine(line, width)).slice(0, safeViewportRows);
}

function stateColor(state: ExtensionState): ThemeColor {
	if (state === "active") return "success";
	if (state === "disabled") return "warning";
	if (state === "broken") return "error";
	return "dim";
}

function frameContentWidth(width: number): number {
	return Math.max(1, width - 2 - POPUP_PADDING_X * 2);
}

function divider(width: number, theme: Theme): string {
	return theme.fg("dim", "─".repeat(Math.max(1, width)));
}

function frame(lines: string[], width: number, theme: Theme, fixedInnerRows?: number, title = ""): string[] {
	const inner = Math.max(1, width - 2);
	const contentWidth = frameContentWidth(width);
	const border = (s: string) => theme.fg("borderAccent", s);
	let body = lines;
	if (fixedInnerRows !== undefined && body.length > fixedInnerRows) {
		const hidden = body.length - fixedInnerRows + 1;
		body = [...body.slice(0, Math.max(0, fixedInnerRows - 1)), theme.fg("dim", `↓ ${hidden} more line(s)`)].slice(0, fixedInnerRows);
	}
	const blank = `${border("┃")}${" ".repeat(inner)}${border("┃")}`;
	const top = () => {
		if (!title) return `${border("┏")}${border("━".repeat(inner))}${border("┓")}`;
		const titlePlain = ` ${truncateToWidth(title, Math.max(1, inner - 2), "…")} `;
		const fill = Math.max(1, inner - visibleWidth(titlePlain));
		return `${border("┏")}${ansiGreen(titlePlain)}${border("━".repeat(fill))}${border("┓")}`;
	};
	const out = [top()];
	for (let i = 0; i < POPUP_PADDING_Y; i += 1) out.push(blank);
	for (const line of body) out.push(`${border("┃")}${" ".repeat(POPUP_PADDING_X)}${pad(line, contentWidth)}${" ".repeat(POPUP_PADDING_X)}${border("┃")}`);
	for (let i = 0; i < POPUP_PADDING_Y; i += 1) out.push(blank);
	out.push(`${border("┗")}${border("━".repeat(inner))}${border("┛")}`);
	return out.map((line) => truncateToWidth(line, width, ""));
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function wrapLine(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const normalized = String(line ?? "").replace(/\t/g, "  ");
	const wrapped = normalized.split(/\r?\n/).flatMap((part) => {
		const rows = wrapTextWithAnsi(part, safeWidth);
		return rows.length > 0 ? rows : [""];
	});
	return wrapped.map((part) => truncateToWidth(part, safeWidth, ""));
}

function wrapDescription(text: string, width: number, theme: Theme, indent = ""): string[] {
	const indentWidth = visibleWidth(indent);
	const contentWidth = Math.max(1, width - indentWidth);
	return wrapLine(text, contentWidth).map((line) => `${indent}${theme.fg("muted", line)}`);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
	return out;
}

interface QuickSettingTarget {
	item: InventoryItem;
	schema: SettingsSchema;
	extensionId: string;
}

interface QuickSettingRow extends QuickSettingTarget {
	id: string;
	packageName: string;
}

interface QuickSettingsUiState {
	editing?: InlineEditState & { rowId: string };
	scroll: number;
	search: string;
	selected: number;
	tab: TopTab;
}

type QuickSettingsAction = { type: "close" } | undefined;

function settingPackages(inventory: Inventory): InventoryItem[] {
	return inventory.packages.filter((item) => item.packageName && item.settingsSchema?.length && item.state !== "shadowed");
}

function stringifySettingValue(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function quickSettingRows(inventory: Inventory): QuickSettingRow[] {
	const rows: QuickSettingRow[] = [];
	for (const item of settingPackages(inventory).sort((a, b) => a.displayName.localeCompare(b.displayName))) {
		const extensionId = selectedPackageForSetting(item) ?? item.displayName;
		const schemas = (item.settingsSchema ?? []).filter((schema) => schema.type !== "secret");
		for (const schema of schemas) {
			rows.push({
				extensionId,
				id: `${item.id}::${schema.key}`,
				item,
				packageName: item.displayName,
				schema,
			});
		}
	}
	return rows;
}

function quickSettingsTabs(rows: QuickSettingRow[]): ManagerTab[] {
	const tabs: ManagerTab[] = [{ id: TAB_ALL, label: "All" }];
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.extensionId)) continue;
		seen.add(row.extensionId);
		tabs.push({ id: packageTabId(row.extensionId), label: row.packageName, packageName: row.extensionId });
	}
	return tabs;
}

function filterQuickSettingRows(rows: QuickSettingRow[], search: string, inventory: Inventory, tab: TopTab): QuickSettingRow[] {
	const packageName = packageNameForTab(tab);
	const scopedRows = packageName ? rows.filter((row) => row.extensionId === packageName) : rows;
	const query = search.trim().toLowerCase();
	if (!query) return scopedRows;
	return scopedRows.filter((row) => {
		const config = getConfigValue(inventory, row.extensionId, row.schema);
		const hay = [
			row.packageName,
			row.schema.key,
			row.schema.label,
			row.schema.description,
			row.schema.type,
			formatSettingValue({ ...row.schema, secret: false }, config.value),
		].join("\n").toLowerCase();
		return hay.includes(query);
	});
}

function quickSettingEditValue(inventory: Inventory, row: QuickSettingRow): string {
	const value = getConfigValue(inventory, row.extensionId, row.schema).value;
	return stringifySettingValue(value ?? row.schema.default ?? "");
}

function saveQuickSetting(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, row: QuickSettingRow, value: unknown): void {
	setConfigValue(inventory, row.item, row.schema, value);
	pi.events.emit(SETTINGS_EVENT, { extensionId: row.extensionId, key: row.schema.key, value });
	const apply = row.schema.apply ?? (row.schema.requiresReload ? "reload" : "live");
	if (apply !== "live") ctx.ui.notify(applyMessage(row.schema), apply === "restart" ? "warning" : "info");
}

function resetQuickSetting(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, row: QuickSettingRow): void {
	if (!getConfigValue(inventory, row.extensionId, row.schema).explicit) {
		ctx.ui.notify(`${row.schema.label ?? row.schema.key} is already using its default.`, "info");
		return;
	}
	resetConfigKeys(inventory, row.extensionId, [row.schema.key]);
	pi.events.emit(SETTINGS_EVENT, { extensionId: row.extensionId, key: row.schema.key, value: row.schema.default });
	notifyReset(ctx, row.schema.label ?? row.schema.key, [row.schema]);
}

function resetQuickSettingsForExtension(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, rows: QuickSettingRow[], extensionId: string, label: string): void {
	const scoped = rows.filter((row) => row.extensionId === extensionId);
	const explicit = scoped.filter((row) => getConfigValue(inventory, row.extensionId, row.schema).explicit);
	if (explicit.length === 0) {
		ctx.ui.notify(`${label} settings are already using defaults.`, "info");
		return;
	}
	resetConfigKeys(inventory, extensionId, explicit.map((row) => row.schema.key));
	for (const row of explicit) pi.events.emit(SETTINGS_EVENT, { extensionId, key: row.schema.key, value: row.schema.default });
	notifyReset(ctx, `${label} settings`, explicit.map((row) => row.schema));
}

function createQuickSettingsComponent(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, ui: QuickSettingsUiState, theme: Theme, requestRender: () => void, getLayout: () => PopupLayout, done: (action: QuickSettingsAction) => void) {
	const rows = quickSettingRows(inventory);
	const tabs = quickSettingsTabs(rows);
	const filtered = () => filterQuickSettingRows(rows, ui.search, inventory, ui.tab);
	const clamp = () => {
		const layout = getLayout();
		if (!tabs.some((tab) => tab.id === ui.tab)) ui.tab = TAB_ALL;
		const count = filtered().length;
		ui.selected = Math.max(0, Math.min(ui.selected, Math.max(0, count - 1)));
		if (ui.selected < ui.scroll) ui.scroll = ui.selected;
		if (ui.selected >= ui.scroll + layout.listRows) ui.scroll = ui.selected - layout.listRows + 1;
		ui.scroll = Math.max(0, Math.min(ui.scroll, Math.max(0, count - layout.listRows)));
	};
	const selectedRow = () => {
		clamp();
		return filtered()[ui.selected];
	};
	const cycle = <T extends string>(values: T[], current: string, delta: number): T => {
		const idx = Math.max(0, values.indexOf(current as T));
		return values[(idx + delta + values.length) % values.length]!;
	};
	const switchTab = (delta: number): void => {
		ui.tab = cycle(tabs.map((tab) => tab.id), ui.tab, delta);
		ui.selected = 0;
		ui.scroll = 0;
		clamp();
		requestRender();
	};
	const editOrToggle = () => {
		const row = selectedRow();
		if (!row) return;
		const current = getConfigValue(inventory, row.extensionId, row.schema).value;
		if (row.schema.type === "boolean" || row.schema.type === "enum") {
			saveQuickSetting(pi, ctx, inventory, row, nextSettingValue(row.schema, current));
			requestRender();
			return;
		}
		const buffer = quickSettingEditValue(inventory, row);
		ui.editing = { buffer, cursor: buffer.length, rowId: row.id };
		requestRender();
	};

	const saveInlineEdit = () => {
		const editing = ui.editing;
		if (!editing) return;
		const row = rows.find((candidate) => candidate.id === editing.rowId);
		if (!row) {
			ui.editing = undefined;
			requestRender();
			return;
		}
		try {
			const value = parseSettingInput(row.schema, editing.buffer);
			saveQuickSetting(pi, ctx, inventory, row, value);
			ui.editing = undefined;
			requestRender();
		} catch (error) {
			ctx.ui.notify(stringifyError(error), "error");
		}
	};

	function handleInput(data: string): void {
		if (ui.editing) {
			if (data === "\u001b" || matchesKey(data, "ctrl+c")) {
				ui.editing = undefined;
				requestRender();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) return saveInlineEdit();
			if (handleInlineEditInput(ui.editing, data)) {
				requestRender();
			}
			return;
		}
		if (data === "\u001b" || matchesKey(data, "ctrl+c")) return done({ type: "close" });
		if (matchesKey(data, "tab")) {
			switchTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			switchTab(-1);
			return;
		}
		if (matchesKey(data, "up")) {
			ui.selected -= 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			ui.selected += 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "-") || matchesKey(data, "pageUp")) {
			ui.selected -= getLayout().listRows;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "=") || matchesKey(data, "pageDown")) {
			ui.selected += getLayout().listRows;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			ui.search = ui.search.slice(0, -1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			ui.search = "";
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "delete")) {
			const row = selectedRow();
			if (row) resetQuickSetting(pi, ctx, inventory, row);
			requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			const row = selectedRow();
			if (row) resetQuickSettingsForExtension(pi, ctx, inventory, rows, row.extensionId, row.packageName);
			requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) return editOrToggle();
		if (isPlainSearchInput(data)) {
			ui.search += data;
			ui.selected = 0;
			clamp();
			requestRender();
		}
	}

	function render(width: number): string[] {
		clamp();
		const layout = getLayout();
		const safeWidth = Math.max(1, width);
		const bodyWidth = frameContentWidth(safeWidth);
		const visible = filtered().slice(ui.scroll, ui.scroll + layout.listRows);
		const lines: string[] = [];
		const searchLine = ui.editing
			? theme.bg("toolPendingBg", pad(` ${theme.fg("dim", "Editing inline value")}`, bodyWidth))
			: theme.bg("toolPendingBg", pad(` > ${ui.search}${theme.inverse(" ")}`, bodyWidth));
		const footer = ui.editing
			? `${theme.fg("dim", "editing value · ")}${ansiYellow("←/→")} ${theme.fg("dim", "move · ")}${ansiYellow("alt+←/→")} ${theme.fg("dim", "word · ")}${ansiYellow("enter")} ${theme.fg("dim", "save · ")}${ansiYellow("esc")} ${theme.fg("dim", "cancel · ")}${ansiYellow("backspace/delete")} ${theme.fg("dim", "delete · ")}${ansiYellow("ctrl+u")} ${theme.fg("dim", "clear")}`
			: `${ansiYellow("tab")} ${theme.fg("dim", "switch extension tabs · ")}${ansiYellow("-/=")} ${theme.fg("dim", "page · ")}${ansiYellow("enter")} ${theme.fg("dim", "edit/toggle · ")}${ansiYellow("delete")} ${theme.fg("dim", "reset setting · ")}${ansiYellow("ctrl+x")} ${theme.fg("dim", "reset extension · ")}${ansiYellow("backspace")} ${theme.fg("dim", "clear · ")}${ansiYellow("esc")} ${theme.fg("dim", "close")}`;
		lines.push(renderTabBar(tabs, ui.tab, bodyWidth, theme));
		lines.push("");
		lines.push(searchLine);
		lines.push("");
		lines.push(divider(bodyWidth, theme));
		if (visible.length === 0) {
			lines.push(theme.fg("muted", "No matching settings."));
			lines.push(divider(bodyWidth, theme), ...wrapLine(footer, bodyWidth));
			return frame(lines, safeWidth, theme, layout.innerRows, "Extension Settings");
		}
		let lastPackage = "";
		for (const [visibleIndex, row] of visible.entries()) {
			const index = ui.scroll + visibleIndex;
			if (row.packageName !== lastPackage) {
				if (lastPackage) lines.push("");
				lines.push(managerEntityTitle(theme, row.packageName));
				lastPackage = row.packageName;
			}
			const selected = index === ui.selected;
			const config = getConfigValue(inventory, row.extensionId, row.schema);
			const itemPad = " ";
			const labelText = truncateToWidth(row.schema.label ?? row.schema.key, 34, "…");
			const label = selected ? theme.fg("text", labelText) : labelText;
			const isEditing = ui.editing?.rowId === row.id;
			const value = isEditing && ui.editing ? renderInlineEditValue(ui.editing) : formatSettingValue(row.schema, config.value);
			const valueText = theme.fg(isEditing ? "accent" : config.explicit ? "success" : selected ? "text" : "muted", value);
			const rowText = truncateToWidth(`${itemPad}${label}${" ".repeat(Math.max(1, 36 - visibleWidth(labelText)))}${valueText}`, bodyWidth, "…");
			lines.push(selected ? managerSelectedLine(theme, rowText, bodyWidth) : rowText);
			if (selected && !isEditing && row.schema.description) lines.push(...wrapDescription(row.schema.description, bodyWidth, theme, "    "));
		}
		const moreBefore = ui.scroll > 0 ? `↑ ${ui.scroll}` : "";
		const moreAfter = ui.scroll + layout.listRows < filtered().length ? `↓ ${filtered().length - ui.scroll - layout.listRows}` : "";
		if (moreBefore || moreAfter) lines.push("", theme.fg("dim", [moreBefore, moreAfter].filter(Boolean).join(" · ")));
		lines.push(divider(bodyWidth, theme), ...wrapLine(footer, bodyWidth));
		return frame(lines, safeWidth, theme, layout.innerRows, "Extension Settings");
	}

	return { handleInput, invalidate() {}, render };
}

function resolveQuickSettingsTab(tabs: ManagerTab[], hint: string): TopTab | undefined {
	const needle = hint.trim().toLowerCase();
	if (!needle) return undefined;
	if (needle === "all") return TAB_ALL;
	for (const tab of tabs) {
		if (tab.id === TAB_ALL) continue;
		const pkg = (tab.packageName ?? "").toLowerCase();
		const label = tab.label.toLowerCase();
		if (tab.id.toLowerCase() === needle || pkg === needle || label === needle) return tab.id;
	}
	for (const tab of tabs) {
		if (tab.id === TAB_ALL) continue;
		const pkg = (tab.packageName ?? "").toLowerCase();
		const label = tab.label.toLowerCase();
		if (pkg.includes(needle) || label.includes(needle)) return tab.id;
	}
	return undefined;
}

function quickSettingsCompletions(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, prefix: string): AutocompleteItem[] | null {
	try {
		const inventory = buildInventory(pi, ctx as ExtensionContext);
		const tabs = quickSettingsTabs(quickSettingRows(inventory));
		const query = prefix.trim().toLowerCase();
		const items: AutocompleteItem[] = tabs
			.filter((tab) => tab.id !== TAB_ALL && tab.packageName)
			.map((tab) => ({
				value: tab.packageName!,
				label: tab.label,
				description: `Open ${tab.label} settings`,
			}));
		const filtered = query
			? items.filter((item) => item.value.toLowerCase().includes(query) || (item.label ?? item.value).toLowerCase().includes(query))
			: items;
		return filtered.length > 0 ? filtered : null;
	} catch {
		return null;
	}
}

async function openQuickSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, initialTabHint?: string): Promise<void> {
	const inventory = buildInventory(pi, ctx as ExtensionContext);
	if (settingPackages(inventory).length === 0) {
		ctx.ui.notify("No vstack extension settings are declared by installed packages.", "info");
		return;
	}
	let initialTab: TopTab = TAB_ALL;
	if (initialTabHint && initialTabHint.trim()) {
		const tabs = quickSettingsTabs(quickSettingRows(inventory));
		const resolved = resolveQuickSettingsTab(tabs, initialTabHint);
		if (resolved) initialTab = resolved;
		else ctx.ui.notify(`No settings tab matches "${initialTabHint}". Showing All.`, "warning");
	}
	const ui: QuickSettingsUiState = { scroll: 0, search: "", selected: 0, tab: initialTab };
	const releaseModalLock = acquireVstackModalLock();
	try {
		await ctx.ui.custom<QuickSettingsAction>(
			(tui, theme, _keybindings, done) => createQuickSettingsComponent(pi, ctx, inventory, ui, theme, () => tui.requestRender(), () => quickSettingsLayout(tui.terminal.rows), done),
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: DEFAULT_MAX_HEIGHT, width: DEFAULT_WIDTH_PERCENT } },
		);
	} finally {
		releaseModalLock();
	}
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export default function extensionManager(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	const projectPiDir = findProjectPiDir(process.cwd());
	const loadConfig = mergedManagerState([
		{ baseDir: userPiDir(), exists: existsSync(join(userPiDir(), "settings.json")), json: readJsonObject(join(userPiDir(), "settings.json")).json, path: join(userPiDir(), "settings.json"), scope: "user" },
		{ baseDir: projectPiDir, exists: existsSync(join(projectPiDir, "settings.json")), json: readJsonObject(join(projectPiDir, "settings.json")).json, path: join(projectPiDir, "settings.json"), scope: "project" },
	]);

	if (loadConfig.config[MANAGER_ID]?.enabled === false) {
		const enableRecovery = async (ctx: ExtensionCommandContext) => {
			const files = loadSettingsFiles(ctx as ExtensionContext);
			const scope = defaultWriteScope(undefined, files, mergedManagerState(files));
			const file = findSettingsFile(files, scope);
			updateManagerState(file, (state) => {
				state.config[MANAGER_ID] = { ...(state.config[MANAGER_ID] ?? {}), enabled: true };
			});
			ctx.ui.notify("Extension manager enabled. Run /reload to restore the full UI.", "info");
		};
		pi.registerCommand("extensions", {
			description: "Extension manager recovery command.",
			handler: async (args, ctx) => {
				if (args.trim().toLowerCase() !== "enable") {
					ctx.ui.notify("Extension manager UI is disabled. Run /extensions:enable, then /reload, to restore it.", "warning");
					return;
				}
				await enableRecovery(ctx);
			},
		});
		pi.registerCommand("extensions:enable", {
			description: "Re-enable the extension manager UI",
			handler: async (_args, ctx) => enableRecovery(ctx),
		});
		return;
	}

	pi.registerCommand("extensions", {
		description: "Browse, toggle, inspect, and configure Pi extension-like resources.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();
			if (lower === "settings") {
				await openQuickSettings(pi, ctx);
				return;
			}
			if (lower.startsWith("settings ")) {
				await openQuickSettings(pi, ctx, trimmed.slice("settings ".length));
				return;
			}
			await openManager(pi, ctx, TAB_ALL);
		},
	});

	let activeCtx: ExtensionContext | undefined;
	pi.registerCommand("extensions:settings", {
		description: "Open the quick extension settings editor (optional package name jumps to that tab)",
		getArgumentCompletions: (prefix: string) => activeCtx ? quickSettingsCompletions(pi, activeCtx, prefix) : null,
		handler: async (args, ctx) => openQuickSettings(pi, ctx, args),
	});

	(globalThis as unknown as Record<PropertyKey, unknown>)[VSTACK_OPEN_QUICK_SETTINGS_SYMBOL] = async (ctx: ExtensionCommandContext | ExtensionContext, hint?: string) => openQuickSettings(pi, ctx, hint);

	const openManagerPopup = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		await openManager(pi, ctx, TAB_ALL);
	};
	const openSettingsPopup = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		await openQuickSettings(pi, ctx);
	};

	pi.registerShortcut("alt+shift+e" as any, {
		description: "Open the extension manager popup",
		handler: async (ctx) => openManagerPopup(ctx as ExtensionContext),
	});
	pi.registerShortcut("f11" as any, {
		description: "Open the extension manager popup",
		handler: async (ctx) => openManagerPopup(ctx as ExtensionContext),
	});

	pi.registerShortcut("alt+shift+s" as any, {
		description: "Open the extension manager settings popup",
		handler: async (ctx) => openSettingsPopup(ctx as ExtensionContext),
	});
	pi.registerShortcut("f12" as any, {
		description: "Open the extension manager settings popup",
		handler: async (ctx) => openSettingsPopup(ctx as ExtensionContext),
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		const inventory = buildInventory(pi, ctx);
		const disabledTools = new Set(
			inventory.items.filter((item) => item.kind === "tool" && item.state === "disabled").map((item) => item.displayName),
		);
		if (disabledTools.size > 0) {
			const active = safeActiveTools(pi).filter((tool) => !disabledTools.has(tool));
			pi.setActiveTools?.(active);
		}

		const hasUI = (ctx as { hasUI?: boolean }).hasUI;
		const configEnabled = inventory.managerState.config[MANAGER_ID]?.notifyOnUpdates;
		const notifyEnabled = configEnabled !== false;
		const pkgs = inventory.items.filter((item) => item.kind === "package" && item.state !== "shadowed");

		const npmCandidates = npmCandidatesFromInventory(inventory);
		if (npmCandidates.length > 0) {
			kickNpmUpdateCheck(npmCandidates, () => {});
		}

		if (hasUI && notifyEnabled) {
			const withUpdates = pkgs.filter((item) => item.updateAvailable);
			if (withUpdates.length > 0) {
				let message: string;
				if (withUpdates.length === 1) {
					const p = withUpdates[0];
					const cmd = p.updateCommand ?? "";
					message = `${p.packageName}: update available ${p.installedVersion ?? "?"} → ${p.latestVersion}${cmd ? `. Run: ${cmd}` : ""}`;
				} else {
					const names = withUpdates.slice(0, 3).map((p) => `${p.packageName} → ${p.latestVersion}`).join(", ");
					const suffix = withUpdates.length > 3 ? `, +${withUpdates.length - 3} more` : "";
					message = `${withUpdates.length} extension updates available: ${names}${suffix}. Run /extensions for update commands.`;
				}
				(ctx as ExtensionContext).ui?.notify(message, "warning");
			}
		}
	});
}
