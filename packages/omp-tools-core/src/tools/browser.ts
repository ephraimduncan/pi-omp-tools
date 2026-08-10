import * as path from "node:path";
import { Type } from "typebox";
import { sessionId, ToolError, textResult, type PiApi, type ToolCtx, type ToolResult } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { browserRenderers, loadRenderSupport } from "../render.ts";
import { CdpClient } from "./browser-cdp.ts";
import { launchBrowser, resolveCdpUrl, type BrowserProcess } from "./browser-launch.ts";
import { runBrowserCode } from "./browser-run.ts";
import { BrowserTab, type DialogMode, type WaitUntil } from "./browser-tab.ts";

export const BROWSER_DESCRIPTION = `Drives a real browser tab over the Chrome DevTools Protocol (CDP).

<instruction>
- Static content? Use read for the URL. Browser is for JavaScript execution, authentication, and interactive actions.
- If Obscura is installed, the tool uses Obscura. If not, the tool uses Chrome or Chromium. Set OMP_TOOLS_BROWSER_ENGINE=obscura|chrome to control the automatic search.
- Call open before run. Named tabs survive tool calls; open each name once and reuse it.
- run scope: tab, cdp, display, assert, and wait. wait(fn) polls until truthy. Code runs in an isolated worker; timeout (default 30s) hard-terminates it.
- tab helpers: goto, evaluate, click, fill, type, press, select, scroll, scrollIntoView, waitFor, waitForSelector, waitForUrl, waitForNavigation, screenshot, observe, ariaSnapshot, id, ref.
- tab.ref("e5") and tab.id(5) return handles with click(), type(), and fill(). Snapshot refs also work as selectors: tab.click("e5") equals tab.click("aria-ref=e5").
- Selectors support CSS, aria-ref/eN, text/..., and xpath/....
- tab.fill never works for <select>; use tab.select. waitForNavigation must be called before the click that navigates. Navigation and re-renders invalidate refs; re-observe and act in the same run.
- screenshot({ selector?, fullPage? }) writes a PNG under the OS temp directory and returns its path. It never accepts a path.
- cdp.send(method, params) and cdp.on(event, fn) are the raw escape hatch. This replaces omp's Puppeteer page escape hatch.
- load and domcontentloaded map to their CDP events. networkidle0/networkidle2 wait for load, then no more than 0/2 active requests for 500ms.
- app.path starts that browser binary visibly. app.cdp_url accepts a browser WebSocket URL or an HTTP endpoint with /json/version. app.target picks an existing page whose URL or title contains the text.
</instruction>

<critical>
- MUST open before run. Prefer observe() for structure and screenshot() only for appearance.
</critical>`;

export interface BrowserParams {
	action: "open" | "run" | "close";
	name?: string;
	url?: string;
	code?: string;
	viewport?: { width: number; height: number; scale?: number };
	wait_until?: WaitUntil;
	timeout?: number;
	dialogs?: DialogMode;
	all?: boolean;
	kill?: boolean;
	app?: { cdp_url?: string; path?: string; args?: string[]; target?: string };
}

interface BrowserEntry {
	name: string;
	client: CdpClient;
	tab: BrowserTab;
	targetId: string;
	ownTarget: boolean;
	process?: BrowserProcess;
}


const TABS_KEY = Symbol.for("omp-tools.browser.v2");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[TABS_KEY] ??= new Map<string, Map<string, BrowserEntry>>();
// This key is process-owned: session id -> tab name -> entry, so daemon
// sessions can never run or close each other's tabs.
const sessions = globals[TABS_KEY] as Map<string, Map<string, BrowserEntry>>;

function tabsFor(ctx?: ToolCtx): Map<string, BrowserEntry> {
	const key = sessionId(ctx) ?? "";
	let bucket = sessions.get(key);
	if (!bucket) {
		bucket = new Map();
		sessions.set(key, bucket);
	}
	return bucket;
}

export async function executeBrowser(params: BrowserParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const name = params.name ?? "main";
	const timeoutMs = Math.max(100, (params.timeout ?? 30) * 1000);
	const tabs = tabsFor(ctx);
	if (params.action === "open") return openTab(tabs, name, params, ctx, signal, timeoutMs);
	if (params.action === "run") return runTab(tabs, name, params, signal, timeoutMs);
	if (params.action === "close") return closeTabs(tabs, name, params.kill === true, params.all === true);
	throw new ToolError(`Unsupported browser action: ${String(params.action)}`);
}


export async function registerBrowser(pi: PiApi): Promise<void> {
	registeredTools.add("browser");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...browserRenderers(support) } : {}),
		name: "browser",
		label: "Browser",
		description: BROWSER_DESCRIPTION,
		promptSnippet: "Drive Chromium over raw CDP for JavaScript and interactive pages",
		promptGuidelines: [
			"Use browser only for JavaScript-requiring or interactive pages; prefer read for static content, and always open a named tab before run.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("open"), Type.Literal("run"), Type.Literal("close")], {
				description: "operation",
			}),
			name: Type.Optional(Type.String({ description: "tab id (default 'main')" })),
			url: Type.Optional(Type.String({ description: "url to open" })),
			code: Type.Optional(Type.String({ description: "js function body to run in tab" })),
			viewport: Type.Optional(
				Type.Object({
					width: Type.Number(),
					height: Type.Number(),
					scale: Type.Optional(Type.Number()),
				}),
			),
			wait_until: Type.Optional(
				Type.Union([
					Type.Literal("load"),
					Type.Literal("domcontentloaded"),
					Type.Literal("networkidle0"),
					Type.Literal("networkidle2"),
				], { description: "navigation wait condition" }),
			),
			timeout: Type.Optional(Type.Number({ description: "timeout in seconds" })),
			dialogs: Type.Optional(
				Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], { description: "auto-handle dialogs" }),
			),
			all: Type.Optional(Type.Boolean({ description: "close every tab" })),
			kill: Type.Optional(Type.Boolean({ description: "also SIGKILL spawned browsers" })),
			app: Type.Optional(
				Type.Object({
					cdp_url: Type.Optional(Type.String({ description: "existing CDP endpoint" })),
					path: Type.Optional(Type.String({ description: "browser binary path to spawn" })),
					args: Type.Optional(Type.Array(Type.String(), { description: "extra browser arguments" })),
					target: Type.Optional(Type.String({ description: "substring to pick an existing page" })),
				}),
			),
		}),
		async execute(_id: string, params: BrowserParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolCtx) {
			return executeBrowser(params, ctx, signal);
		},
	});
	if (typeof pi.on === "function") {
		// A session that ends must not leave its tabs or spawned Chromium running.
		pi.on("session_shutdown", async (...args: unknown[]) => {
			const ctx = args.find(arg => sessionId(arg) !== undefined);
			const bucket = sessions.get(sessionId(ctx) ?? "");
			if (!bucket) return;
			for (const entry of [...bucket.values()]) await closeEntry(bucket, entry, false);
		});
	}
}

async function openTab(
	tabs: Map<string, BrowserEntry>,
	name: string,
	params: BrowserParams,
	ctx: ToolCtx | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ToolResult> {
	if (tabs.has(name)) throw new ToolError(`Tab ${JSON.stringify(name)} is already open; reuse it with action "run"`);
	let processHandle: BrowserProcess | undefined;
	let client: CdpClient | undefined;
	try {
		let wsUrl: string;
		if (params.app?.cdp_url) {
			wsUrl = await resolveCdpUrl(params.app.cdp_url, timeoutMs, signal);
		} else {
			const launched = await launchBrowser({
				path: params.app?.path ? path.resolve(ctx?.cwd ?? process.cwd(), params.app.path) : undefined,
				args: params.app?.args,
				viewport: params.viewport,
				timeoutMs,
				signal,
			});
			processHandle = launched.process;
			wsUrl = launched.wsUrl;
		}
		client = await CdpClient.connect(wsUrl, undefined, timeoutMs);
		const target = await pickTarget(client, params.app?.target, timeoutMs);
		const attached = await client.send<{ sessionId: string }>(
			"Target.attachToTarget",
			{ targetId: target.targetId, flatten: true },
			undefined,
			timeoutMs,
		);
		const tab = new BrowserTab(client, attached.sessionId, {
			name,
			timeoutMs,
			dialogs: params.dialogs,
			viewport: params.viewport,
		});
		await tab.init(params.viewport);
		if (params.url) await tab.goto(params.url, { waitUntil: params.wait_until, timeout: timeoutMs });
		const info = await tab.evaluate<{ url: string; title: string }>(() => ({ url: location.href, title: document.title }));
		tabs.set(name, {
			name,
			client,
			tab,
			targetId: target.targetId,
			ownTarget: target.ownTarget,
			process: processHandle,
		});
		const lines = [`Opened tab ${JSON.stringify(name)}`, `URL: ${info.url}`];
		if (info.title) lines.push(`Title: ${info.title}`);
		return textResult(lines.join("\n"), {
			action: "open",
			name,
			url: info.url,
			title: info.title,
			pid: processHandle?.child.pid,
		});
	} catch (error) {
		client?.close();
		await processHandle?.close(true);
		if (error instanceof ToolError) throw error;
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
}

async function runTab(
	tabs: Map<string, BrowserEntry>,
	name: string,
	params: BrowserParams,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ToolResult> {
	if (!params.code?.trim()) throw new ToolError("Missing required parameter 'code' for action 'run'.");
	const entry = tabs.get(name);
	if (!entry) throw new ToolError(`No tab named ${JSON.stringify(name)}; call browser open first`);
	const output: string[] = [];
	const off = entry.tab.on("Runtime.consoleAPICalled", event => {
		const args = Array.isArray(event.args) ? event.args : [];
		output.push(args.map(formatRemoteValue).join(" "));
	});
	try {
		const result = await runBrowserCode(params.code, {
			tab: entry.tab,
			cdp: entry.tab.cdp,
			timeoutMs,
			signal,
			onDisplay: value => output.push(formatValue(value)),
		});
		if (result.returnValue !== undefined) output.push(formatValue(result.returnValue));
		if (output.length === 0) output.push(`Ran code on tab ${JSON.stringify(name)}`);
		return textResult(output.join("\n"), {
			action: "run",
			name,
			displays: result.displays,
			returnValue: result.returnValue,
		});
	} catch (error) {
		throw new ToolError(formatError(error));
	} finally {
		off();
	}
}

async function closeTabs(tabs: Map<string, BrowserEntry>, name: string, kill: boolean, all: boolean): Promise<ToolResult> {
	if (all) {
		const entries = [...tabs.values()];
		for (const entry of entries) await closeEntry(tabs, entry, kill);
		return textResult(`Closed ${entries.length} tab(s)`, { action: "close", count: entries.length });
	}
	const entry = tabs.get(name);
	if (!entry) return textResult(`No tab named ${JSON.stringify(name)}`, { action: "close", name, closed: false });
	await closeEntry(tabs, entry, kill);
	return textResult(`Closed tab ${JSON.stringify(name)}`, { action: "close", name, closed: true });
}

async function closeEntry(tabs: Map<string, BrowserEntry>, entry: BrowserEntry, kill: boolean): Promise<void> {
	tabs.delete(entry.name);
	if (entry.ownTarget && !entry.process) {
		await entry.client.send("Target.closeTarget", { targetId: entry.targetId }).catch(() => undefined);
	}
	entry.client.close();
	await entry.process?.close(kill);
}

async function pickTarget(
	client: CdpClient,
	matcher: string | undefined,
	timeoutMs: number,
): Promise<{ targetId: string; ownTarget: boolean }> {
	if (matcher) {
		const result = await client.send<{
			targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
		}>("Target.getTargets", {}, undefined, timeoutMs);
		const found = result.targetInfos.find(
			target => target.type === "page" && (target.url.includes(matcher) || target.title.includes(matcher)),
		);
		if (!found) throw new ToolError(`No page target matches ${JSON.stringify(matcher)}`);
		return { targetId: found.targetId, ownTarget: false };
	}
	const made = await client.send<{ targetId: string }>(
		"Target.createTarget",
		{ url: "about:blank" },
		undefined,
		timeoutMs,
	);
	return { targetId: made.targetId, ownTarget: true };
}

function formatRemoteValue(value: unknown): string {
	if (typeof value !== "object" || value === null) return String(value);
	if ("value" in value && value.value !== undefined) return formatValue(value.value);
	if ("description" in value && typeof value.description === "string") return value.description;
	return String(value);
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value, null, 2);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

