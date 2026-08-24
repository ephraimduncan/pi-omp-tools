import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "../host.ts";
import { CdpClient, deferred, type CdpEventHandler } from "./browser-cdp.ts";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export type DialogMode = "accept" | "dismiss";

export interface AxValue {
	value?: unknown;
}

export interface AxNode {
	nodeId: string;
	ignored?: boolean;
	role?: AxValue;
	name?: AxValue;
	value?: AxValue;
	backendDOMNodeId?: number;
	childIds?: string[];
	parentId?: string;
}

export interface ObservationEntry {
	id: number;
	role: string;
	name: string;
	value?: string;
}

export interface Observation {
	elements: ObservationEntry[];
}

export type SelectorKind =
	| { kind: "ref"; id: number }
	| { kind: "xpath"; value: string }
	| { kind: "text"; value: string }
	| { kind: "css"; value: string };

export interface KeyInfo {
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
}

export const KEY_MAP: Record<string, KeyInfo> = {
	Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
	Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
	Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
	Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
};

interface RemoteValue {
	type?: string;
	subtype?: string;
	value?: unknown;
	description?: string;
	objectId?: string;
}

interface CallResult {
	result: RemoteValue;
	exceptionDetails?: { text?: string; exception?: RemoteValue };
}

interface BoxModel {
	model: { content: number[]; border: number[] };
}

interface TabOptions {
	name: string;
	timeoutMs?: number;
	dialogs?: DialogMode;
	viewport?: { width: number; height: number; scale?: number };
}

export function classifySelector(selector: string): SelectorKind {
	const ref = /^(?:aria-ref=)?e(\d+)$/.exec(selector);
	if (ref) return { kind: "ref", id: Number(ref[1]) };
	if (selector.startsWith("xpath/")) return { kind: "xpath", value: selector.slice(6) };
	if (selector.startsWith("text/")) return { kind: "text", value: selector.slice(5) };
	return { kind: "css", value: selector };
}

export function compactAxTree(nodes: AxNode[]): Observation {
	return buildObservation(nodes).observation;
}

export function formatAriaSnapshot(nodes: AxNode[]): string {
	const { ids } = buildObservation(nodes);
	const byId = new Map(nodes.map(node => [node.nodeId, node]));
	const roots = nodes.filter(node => !node.parentId || !byId.has(node.parentId));
	const lines: string[] = [];
	const walk = (node: AxNode, depth: number): void => {
		if (node.ignored) return;
		const role = axText(node.role) || "node";
		const name = axText(node.name);
		const ref = ids.get(node.backendDOMNodeId ?? -1);
		lines.push(`${"  ".repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ""}${ref ? ` [ref=e${ref}]` : ""}`);
		for (const childId of node.childIds ?? []) {
			const child = byId.get(childId);
			if (child) walk(child, depth + 1);
		}
	};
	for (const root of roots) walk(root, 0);
	return lines.join("\n");
}

export class BrowserElement {
	readonly #tab: BrowserTab;
	readonly #backendNodeId: number;

	constructor(tab: BrowserTab, backendNodeId: number) {
		this.#tab = tab;
		this.#backendNodeId = backendNodeId;
	}

	click(): Promise<void> {
		return this.#tab.clickNode(this.#backendNodeId);
	}

	type(text: string): Promise<void> {
		return this.#tab.typeNode(this.#backendNodeId, text);
	}

	fill(text: string): Promise<void> {
		return this.#tab.fillNode(this.#backendNodeId, text);
	}
}

export class BrowserTab {
	readonly #client: CdpClient;
	readonly #sessionId: string;
	readonly #name: string;
	readonly #timeoutMs: number;
	readonly #dialogs: DialogMode;
	readonly #refs = new Map<number, number>();
	readonly #requests = new Set<string>();

	constructor(client: CdpClient, sessionId: string, options: TabOptions) {
		this.#client = client;
		this.#sessionId = sessionId;
		this.#name = options.name;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
		this.#dialogs = options.dialogs ?? "dismiss";
		this.#client.on("Page.frameNavigated", () => this.#refs.clear(), sessionId);
		this.#client.on("Network.requestWillBeSent", params => {
			if (typeof params.requestId === "string") this.#requests.add(params.requestId);
		}, sessionId);
		const dropRequest = (params: Record<string, unknown>): void => {
			if (typeof params.requestId === "string") this.#requests.delete(params.requestId);
		};
		this.#client.on("Network.loadingFinished", dropRequest, sessionId);
		this.#client.on("Network.loadingFailed", dropRequest, sessionId);
		this.#client.on("Page.javascriptDialogOpening", () => {
			void this.send("Page.handleJavaScriptDialog", { accept: this.#dialogs === "accept" }).catch(() => undefined);
		}, sessionId);
	}

	async init(viewport?: { width: number; height: number; scale?: number }): Promise<void> {
		await Promise.all([
			this.send("Page.enable"),
			this.send("Runtime.enable"),
			this.send("DOM.enable"),
			this.send("Network.enable"),
		]);
		if (viewport) {
			await this.send("Emulation.setDeviceMetricsOverride", {
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: viewport.scale ?? 1,
				mobile: false,
			});
		}
	}

	readonly cdp = {
		send: <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
			this.send<T>(method, params),
		on: (event: string, handler: CdpEventHandler): (() => void) => this.#client.on(event, handler, this.#sessionId),
	};

	async goto(url: string, options: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
		const timeoutMs = options.timeout ?? this.#timeoutMs;
		const loaded = this.#load(options.waitUntil ?? "load", timeoutMs);
		const result = await this.send<{ errorText?: string }>("Page.navigate", { url }, timeoutMs);
		if (result.errorText) throw new ToolError(`Navigation failed: ${result.errorText}`);
		await loaded;
	}

	async evaluate<T = unknown>(fnOrExpression: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<T> {
		let result: CallResult;
		if (typeof fnOrExpression === "string") {
			result = await this.send<CallResult>("Runtime.evaluate", {
				expression: fnOrExpression,
				awaitPromise: true,
				returnByValue: true,
			});
		} else {
			const doc = await this.send<CallResult>("Runtime.evaluate", { expression: "document" });
			if (!doc.result.objectId) throw new ToolError("Could not access the page document");
			result = await this.send<CallResult>("Runtime.callFunctionOn", {
				objectId: doc.result.objectId,
				functionDeclaration: `function(...args) { return (${fnOrExpression.toString()})(...args); }`,
				arguments: args.map(value => ({ value })),
				awaitPromise: true,
				returnByValue: true,
			});
		}
		if (result.exceptionDetails) throw new ToolError(remoteError(result.exceptionDetails));
		return result.result.value as T;
	}

	async click(selector: string): Promise<void> {
		await this.clickNode(await this.#resolve(selector));
	}

	async clickNode(backendNodeId: number): Promise<void> {
		const { x, y } = await this.#center(backendNodeId);
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	}

	async scrollIntoView(selector: string): Promise<void> {
		await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: await this.#resolve(selector) });
	}

	async fill(selector: string, text: string): Promise<void> {
		await this.fillNode(await this.#resolve(selector), text);
	}

	async fillNode(backendNodeId: number, text: string): Promise<void> {
		const objectId = await this.#object(backendNodeId);
		const result = await this.send<CallResult>("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration:
				"function() { if (this instanceof HTMLSelectElement) throw new Error('tab.fill does not work for <select>; use tab.select'); this.focus(); if (typeof this.select === 'function') this.select(); else { const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); } }",
			awaitPromise: true,
		});
		if (result.exceptionDetails) throw new ToolError(remoteError(result.exceptionDetails));
		await this.send("Input.insertText", { text });
	}

	async type(selector: string, text: string): Promise<void> {
		await this.typeNode(await this.#resolve(selector), text);
	}

	async typeNode(backendNodeId: number, text: string): Promise<void> {
		await this.send("DOM.focus", { backendNodeId });
		for (const char of text) {
			await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
			await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
		}
	}

	async press(selector: string, key: string): Promise<void> {
		const info = KEY_MAP[key];
		if (!info) throw new ToolError(`Unsupported key: ${key}`);
		await this.send("DOM.focus", { backendNodeId: await this.#resolve(selector) });
		await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...info });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...info });
	}

	async select(selector: string, value: string): Promise<void> {
		const objectId = await this.#object(await this.#resolve(selector));
		const result = await this.send<CallResult>("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration:
				"function(value) { if (!(this instanceof HTMLSelectElement)) throw new Error('tab.select requires a <select>'); this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }",
			arguments: [{ value }],
			returnByValue: true,
		});
		if (result.exceptionDetails) throw new ToolError(remoteError(result.exceptionDetails));
	}

	async scroll(value: { x?: number; y?: number } | string): Promise<void> {
		if (typeof value === "string") {
			await this.scrollIntoView(value);
			return;
		}
		await this.evaluate(`window.scrollBy(${Number(value.x ?? 0)}, ${Number(value.y ?? 0)})`);
	}

	async waitFor(value: number | (() => unknown | Promise<unknown>), options: { timeout?: number } = {}): Promise<unknown> {
		if (typeof value === "number") {
			await delay(value);
			return true;
		}
		const timeoutMs = options.timeout ?? this.#timeoutMs;
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			const found = await value();
			if (found) return found;
			await delay(50);
		}
		throw new ToolError(`tab.waitFor timed out after ${timeoutMs}ms`);
	}

	async waitForSelector(selector: string, options: { timeout?: number } = {}): Promise<BrowserElement> {
		const timeoutMs = options.timeout ?? this.#timeoutMs;
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			try {
				return new BrowserElement(this, await this.#resolve(selector));
			} catch {
				await delay(50);
			}
		}
		throw new ToolError(`tab.waitForSelector(${JSON.stringify(selector)}) timed out after ${timeoutMs}ms`);
	}

	async waitForUrl(pattern: string | RegExp, options: { timeout?: number } = {}): Promise<string> {
		const timeoutMs = options.timeout ?? this.#timeoutMs;
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			const url = await this.evaluate<string>("location.href");
			if (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) return url;
			await delay(50);
		}
		throw new ToolError(`tab.waitForUrl timed out after ${timeoutMs}ms`);
	}

	waitForNavigation(options: { timeout?: number; waitUntil?: WaitUntil } = {}): Promise<void> {
		const timeoutMs = options.timeout ?? this.#timeoutMs;
		const frame = this.#client.waitFor("Page.frameNavigated", this.#sessionId, timeoutMs);
		const loaded = this.#load(options.waitUntil ?? "load", timeoutMs);
		return frame.then(() => loaded);
	}

	async screenshot(options: { selector?: string; fullPage?: boolean } = {}): Promise<string> {
		let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
		if (options.selector) {
			const backendNodeId = await this.#resolve(options.selector);
			await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
			const box = await this.send<BoxModel>("DOM.getBoxModel", { backendNodeId });
			clip = quadBox(box.model.border);
		} else if (options.fullPage) {
			const metrics = await this.send<{ cssContentSize: { x: number; y: number; width: number; height: number } }>(
				"Page.getLayoutMetrics",
			);
			clip = { ...metrics.cssContentSize, scale: 1 };
		}
		const result = await this.send<{ data: string }>("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: options.fullPage === true,
			...(clip ? { clip } : {}),
		});
		const dir = path.join(os.tmpdir(), "pi-browser");
		await fs.mkdir(dir, { recursive: true });
		const safeName = this.#name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
		const file = path.join(dir, `${safeName}-${Date.now()}.png`);
		await fs.writeFile(file, Buffer.from(result.data, "base64"));
		return file;
	}

	async observe(): Promise<Observation> {
		const result = await this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
		const built = buildObservation(result.nodes);
		this.#refs.clear();
		for (const [backendNodeId, id] of built.ids) this.#refs.set(id, backendNodeId);
		return built.observation;
	}

	async ariaSnapshot(): Promise<string> {
		const result = await this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
		const built = buildObservation(result.nodes);
		this.#refs.clear();
		for (const [backendNodeId, id] of built.ids) this.#refs.set(id, backendNodeId);
		return formatAriaSnapshot(result.nodes);
	}

	async id(id: number): Promise<BrowserElement> {
		const backendNodeId = this.#refs.get(id);
		if (!backendNodeId) throw new ToolError(`Unknown element id ${id}; call tab.observe() again`);
		return new BrowserElement(this, backendNodeId);
	}

	async ref(ref: string): Promise<BrowserElement> {
		const parsed = classifySelector(ref);
		if (parsed.kind !== "ref") throw new ToolError(`Invalid ARIA ref ${JSON.stringify(ref)}`);
		return this.id(parsed.id);
	}

	on(event: string, handler: CdpEventHandler): () => void {
		return this.#client.on(event, handler, this.#sessionId);
	}

	private send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs = this.#timeoutMs,
	): Promise<T> {
		return this.#client.send<T>(method, params, this.#sessionId, timeoutMs);
	}

	async #resolve(selector: string): Promise<number> {
		const parsed = classifySelector(selector);
		if (parsed.kind === "ref") {
			const backendNodeId = this.#refs.get(parsed.id);
			if (!backendNodeId) throw new ToolError(`ARIA ref e${parsed.id} is stale; call tab.observe() again`);
			return backendNodeId;
		}
		if (parsed.kind === "css") {
			const doc = await this.send<{ root: { nodeId: number } }>("DOM.getDocument");
			const match = await this.send<{ nodeId: number }>("DOM.querySelector", {
				nodeId: doc.root.nodeId,
				selector: parsed.value,
			});
			if (!match.nodeId) throw new ToolError(`Selector ${JSON.stringify(selector)} matched no element`);
			const node = await this.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId: match.nodeId });
			return node.node.backendNodeId;
		}
		const query = JSON.stringify(parsed.value);
		const expression =
			parsed.kind === "xpath"
				? `document.evaluate(${query}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
				: `Array.from(document.querySelectorAll('body *')).find(el => (el.textContent || '').includes(${query}) && !Array.from(el.children).some(child => (child.textContent || '').includes(${query})))`;
		const result = await this.send<CallResult>("Runtime.evaluate", { expression });
		if (!result.result.objectId || result.result.subtype === "null") {
			throw new ToolError(`Selector ${JSON.stringify(selector)} matched no element`);
		}
		const node = await this.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
			objectId: result.result.objectId,
		});
		await this.send("Runtime.releaseObject", { objectId: result.result.objectId });
		return node.node.backendNodeId;
	}

	async #object(backendNodeId: number): Promise<string> {
		const result = await this.send<{ object: RemoteValue }>("DOM.resolveNode", { backendNodeId });
		if (!result.object.objectId) throw new ToolError("Element is stale; call tab.observe() again");
		return result.object.objectId;
	}

	async #center(backendNodeId: number): Promise<{ x: number; y: number }> {
		try {
			await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
			const box = await this.send<BoxModel>("DOM.getBoxModel", { backendNodeId });
			const clip = quadBox(box.model.border);
			return { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 };
		} catch {
			throw new ToolError("Element is stale or not visible; call tab.observe() again");
		}
	}

	#load(waitUntil: WaitUntil, timeoutMs: number): Promise<void> {
		const event = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
		const loaded = this.#client.waitFor(event, this.#sessionId, timeoutMs).then(() => undefined);
		if (!waitUntil.startsWith("networkidle")) return loaded;
		const max = waitUntil === "networkidle0" ? 0 : 2;
		return loaded.then(() => this.#waitForIdle(max, timeoutMs));
	}

	async #waitForIdle(max: number, timeoutMs: number): Promise<void> {
		const end = Date.now() + timeoutMs;
		let quietSince = 0;
		while (Date.now() < end) {
			if (this.#requests.size <= max) {
				quietSince ||= Date.now();
				if (Date.now() - quietSince >= 500) return;
			} else {
				quietSince = 0;
			}
			await delay(50);
		}
		throw new ToolError(`Network did not become idle after ${timeoutMs}ms`);
	}
}

function buildObservation(nodes: AxNode[]): { observation: Observation; ids: Map<number, number> } {
	const elements: ObservationEntry[] = [];
	const ids = new Map<number, number>();
	for (const node of nodes) {
		if (node.ignored || !node.backendDOMNodeId) continue;
		const role = axText(node.role);
		const name = axText(node.name);
		if (!role || (role === "generic" && !name)) continue;
		const id = elements.length + 1;
		ids.set(node.backendDOMNodeId, id);
		const value = axText(node.value);
		elements.push({ id, role, name, ...(value ? { value } : {}) });
	}
	return { observation: { elements }, ids };
}

function axText(value?: AxValue): string {
	if (typeof value?.value === "string") return value.value;
	if (value?.value === undefined || value.value === null) return "";
	return String(value.value);
}

function quadBox(quad: number[]): { x: number; y: number; width: number; height: number; scale: number } {
	if (quad.length < 8) throw new ToolError("Element has no box");
	const xs = [quad[0] as number, quad[2] as number, quad[4] as number, quad[6] as number];
	const ys = [quad[1] as number, quad[3] as number, quad[5] as number, quad[7] as number];
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
}

function remoteError(details: { text?: string; exception?: RemoteValue }): string {
	return details.exception?.description ?? details.exception?.value?.toString() ?? details.text ?? "Page evaluation failed";
}

async function delay(ms: number): Promise<void> {
	const { promise, resolve } = deferred<void>();
	setTimeout(resolve, ms);
	await promise;
}
