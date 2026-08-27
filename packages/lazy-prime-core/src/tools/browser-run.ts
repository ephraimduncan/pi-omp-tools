/**
 * Isolated executor for browser `run` code.
 *
 * The model-authored function body executes inside a worker thread, never on
 * the host event loop: `worker.terminate()` preempts both hung promises
 * (`await new Promise(() => {})`) and synchronous busy loops (`while(true)`),
 * so the tool `timeout` is a hard bound. Inside the worker, `tab` and `cdp`
 * are proxies that post method calls back here, where the real BrowserTab
 * and CDP client live. Function arguments cross as source text and are only
 * ever forwarded to `tab.evaluate` (page context); element results cross as
 * numbered handles.
 */
import { Worker } from "node:worker_threads";
import { ToolError } from "../host.ts";
import { deferred } from "./browser-cdp.ts";
import { BrowserElement, BrowserTab } from "./browser-tab.ts";

export interface RunScope {
	tab: unknown;
	cdp?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
	onDisplay?(value: unknown): void;
}

export interface BrowserRunResult {
	displays: unknown[];
	returnValue: unknown;
}

const DEFAULT_TIMEOUT = 30_000;

const TAB_METHODS = [
	"goto",
	"evaluate",
	"click",
	"clickNode",
	"scrollIntoView",
	"fill",
	"fillNode",
	"type",
	"typeNode",
	"press",
	"select",
	"scroll",
	"waitFor",
	"waitForSelector",
	"waitForUrl",
	"waitForNavigation",
	"screenshot",
	"observe",
	"ariaSnapshot",
	"id",
	"ref",
];

const HANDLE_METHODS = ["click", "type", "fill"];

interface WorkerCall {
	kind: "call";
	id: number;
	target: "tab" | "cdp" | "handle";
	method: string;
	handleId?: number;
	args: unknown[];
}

type WorkerMessage =
	| WorkerCall
	| { kind: "display"; value: unknown }
	| { kind: "done"; value: unknown }
	| { kind: "error"; message: string; stack?: string };

export async function runBrowserCode(code: string, scope: RunScope): Promise<BrowserRunResult> {
	const timeoutMs = scope.timeoutMs ?? DEFAULT_TIMEOUT;
	const displays: unknown[] = [];
	const handles = new Map<number, BrowserElement>();
	let nextHandle = 1;
	const unsubscribe: Array<() => void> = [];
	const settled = deferred<unknown>();
	let timedOut = false;

	const worker = new Worker(WORKER_BOOTSTRAP, { eval: true, workerData: { code, timeoutMs } });
	const timer = setTimeout(() => {
		timedOut = true;
		void worker.terminate();
	}, timeoutMs);
	const onAbort = (): void => {
		void worker.terminate();
	};
	scope.signal?.addEventListener("abort", onAbort, { once: true });

	const reply = (id: number, value: unknown, error?: unknown): void => {
		const payload = error
			? { kind: "reply", id, error: describeError(error) }
			: { kind: "reply", id, value: marshalResult(value, handles, () => nextHandle++) };
		try {
			worker.postMessage(payload);
		} catch {
			worker.postMessage({ kind: "reply", id, error: { message: "result was not transferable" } });
		}
	};

	worker.on("message", (message: WorkerMessage) => {
		if (message.kind === "display") {
			displays.push(message.value);
			scope.onDisplay?.(message.value);
			return;
		}
		if (message.kind === "done") {
			settled.resolve(message.value);
			return;
		}
		if (message.kind === "error") {
			const error = new Error(message.message);
			if (message.stack) error.stack = message.stack;
			settled.reject(error);
			return;
		}
		dispatch(message, scope, handles, unsubscribe, worker).then(
			value => reply(message.id, value),
			error => reply(message.id, undefined, error),
		);
	});
	worker.on("error", error => settled.reject(error));
	worker.on("exit", () => {
		if (timedOut) {
			settled.reject(new ToolError(`browser run timed out after ${timeoutMs / 1000}s; the run worker was terminated`));
		} else if (scope.signal?.aborted) {
			settled.reject(scope.signal.reason ?? new Error("Browser run aborted"));
		} else {
			settled.reject(new Error("browser run worker exited before returning"));
		}
	});

	try {
		const returnValue = await settled.promise;
		return { displays, returnValue };
	} finally {
		clearTimeout(timer);
		scope.signal?.removeEventListener("abort", onAbort);
		for (const off of unsubscribe) off();
		handles.clear();
		void worker.terminate();
	}
}

async function dispatch(
	call: WorkerCall,
	scope: RunScope,
	handles: Map<number, BrowserElement>,
	unsubscribe: Array<() => void>,
	worker: Worker,
): Promise<unknown> {
	if (call.target === "cdp") return dispatchCdp(call, scope, unsubscribe, worker);
	const target = call.target === "handle" ? handles.get(call.handleId ?? 0) : scope.tab;
	if (!target || typeof target !== "object") {
		throw new Error(call.target === "handle" ? "stale element handle; re-observe" : "tab is unavailable");
	}
	const allowed = call.target === "handle" ? HANDLE_METHODS : TAB_METHODS;
	// Real tabs only expose the documented surface; test stubs may use any name.
	if ((target instanceof BrowserTab || target instanceof BrowserElement) && !allowed.includes(call.method)) {
		throw new Error(`tab.${call.method} is not a browser method`);
	}
	// Dynamic dispatch over a runtime-validated method table.
	const methods = target as Record<string, unknown>;
	const method = methods[call.method];
	if (typeof method !== "function") throw new Error(`tab.${call.method} is not a function`);
	const args = call.args.map(argument => reviveArg(argument, call.method));
	return await method.apply(target, args);
}

async function dispatchCdp(
	call: WorkerCall,
	scope: RunScope,
	unsubscribe: Array<() => void>,
	worker: Worker,
): Promise<unknown> {
	const cdp = scope.cdp;
	if (!cdp || typeof cdp !== "object") throw new Error("cdp is unavailable");
	if (call.method === "send") {
		if (!("send" in cdp) || typeof cdp.send !== "function") throw new Error("cdp.send is unavailable");
		return await cdp.send.apply(cdp, call.args);
	}
	if (call.method === "sub") {
		if (!("on" in cdp) || typeof cdp.on !== "function") throw new Error("cdp.on is unavailable");
		const event = String(call.args[0]);
		const off = cdp.on.call(cdp, event, (params: unknown) => {
			try {
				worker.postMessage({ kind: "event", event, params });
			} catch {
				// Non-transferable event payloads are dropped.
			}
		});
		if (typeof off === "function") unsubscribe.push(off);
		return undefined;
	}
	throw new Error(`cdp.${call.method} is not supported`);
}

/** Function args only ever travel onward to the page via tab.evaluate. */
function reviveArg(value: unknown, method: string): unknown {
	if (!value || typeof value !== "object" || !("__pifn" in value) || typeof value.__pifn !== "string") return value;
	if (method !== "evaluate") throw new Error(`function arguments are only supported for tab.evaluate, not tab.${method}`);
	const source = value.__pifn;
	// Reconstructed only so BrowserTab.evaluate can stringify it back for the page.
	const factory = new Function(`return (${source});`) as () => unknown;
	return factory();
}

function marshalResult(value: unknown, handles: Map<number, BrowserElement>, allocate: () => number): unknown {
	if (value instanceof BrowserElement) {
		const id = allocate();
		handles.set(id, value);
		return { __pihandle: id };
	}
	return value;
}

function describeError(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) return { message: error.message, stack: error.stack };
	return { message: String(error) };
}

const WORKER_BOOTSTRAP = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const port = parentPort;
let nextId = 1;
const pending = new Map();
const eventHandlers = new Map();

function marshalArg(value) {
	if (typeof value === "function") return { __pifn: String(value) };
	return value;
}

function reviveResult(value) {
	if (value && typeof value === "object" && typeof value.__pihandle === "number") {
		const handleId = value.__pihandle;
		return {
			click: () => rpc("handle", "click", [], handleId),
			type: (text) => rpc("handle", "type", [text], handleId),
			fill: (text) => rpc("handle", "fill", [text], handleId),
		};
	}
	return value;
}

function rpc(target, method, args, handleId) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const id = nextId++;
	pending.set(id, { resolve, reject });
	port.postMessage({ kind: "call", id, target, method, handleId, args: args.map(marshalArg) });
	return promise;
}

port.on("message", (message) => {
	if (message.kind === "reply") {
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.error) {
			const error = new Error(message.error.message);
			if (message.error.stack) error.stack = message.error.stack;
			entry.reject(error);
		} else {
			entry.resolve(reviveResult(message.value));
		}
		return;
	}
	if (message.kind === "event") {
		const handlers = eventHandlers.get(message.event);
		if (!handlers) return;
		for (const handler of [...handlers]) {
			try { handler(message.params); } catch {}
		}
	}
});

const sleep = (ms) => {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
};

async function poll(fn, timeoutMs) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const found = await fn();
		if (found) return found;
		await sleep(50);
	}
	throw new Error("wait timed out after " + timeoutMs + "ms");
}

const tab = new Proxy({}, {
	get(_target, prop) {
		if (typeof prop !== "string" || prop === "then") return undefined;
		if (prop === "waitFor") {
			return (value, options) =>
				typeof value === "function"
					? poll(value, (options && options.timeout) || workerData.timeoutMs)
					: rpc("tab", "waitFor", [value, options]);
		}
		return (...args) => rpc("tab", prop, args);
	},
});

const cdp = {
	send: (method, params) => rpc("cdp", "send", [method, params]),
	on: (event, handler) => {
		let handlers = eventHandlers.get(event);
		if (!handlers) {
			handlers = new Set();
			eventHandlers.set(event, handlers);
			rpc("cdp", "sub", [event]).catch(() => {});
		}
		handlers.add(handler);
		return () => handlers.delete(handler);
	},
};

const display = (value) => {
	try {
		port.postMessage({ kind: "display", value });
	} catch {
		port.postMessage({ kind: "display", value: String(value) });
	}
};

const assert = (condition, message) => {
	if (!condition) throw new Error(message || "Assertion failed");
};

const wait = async (value, options) => {
	if (typeof value === "number") {
		await sleep(value);
		return true;
	}
	return poll(value, (options && options.timeout) || workerData.timeoutMs);
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
Promise.resolve()
	.then(() => new AsyncFunction("tab", "cdp", "display", "assert", "wait", workerData.code)(tab, cdp, display, assert, wait))
	.then((value) => {
		try {
			port.postMessage({ kind: "done", value });
		} catch {
			port.postMessage({ kind: "done", value: String(value) });
		}
	})
	.catch((error) => {
		port.postMessage({
			kind: "error",
			message: error && error.message !== undefined ? String(error.message) : String(error),
			stack: error && error.stack ? String(error.stack) : undefined,
		});
	});
`;
