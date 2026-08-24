export interface CdpSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
	removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export type CdpEventHandler = (params: Record<string, unknown>) => void;
export type CdpSocketFactory = (url: string) => CdpSocket | Promise<CdpSocket>;
export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

// Node 20 needs this fallback before its WebSocket client can connect.
export function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((pass, fail) => {
		resolve = pass;
		reject = fail;
	});
	return { promise, resolve, reject };
}


interface Pending {
	resolve(value: unknown): void;
	reject(reason?: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code?: number; message?: string };
	sessionId?: string;
}

interface WsModule {
	WebSocket?: new (url: string) => CdpSocket;
	default?: new (url: string) => CdpSocket;
}


const OPEN = 1;
const DEFAULT_TIMEOUT = 30_000;

export class CdpClient {
	readonly #socket: CdpSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #handlers = new Map<string, Set<CdpEventHandler>>();
	#nextId = 1;
	#closed = false;

	constructor(socket: CdpSocket) {
		this.#socket = socket;
		socket.addEventListener("message", this.#onMessage);
		socket.addEventListener("close", this.#onClose);
		socket.addEventListener("error", this.#onError);
	}

	static async connect(url: string, factory: CdpSocketFactory = makeSocket, timeoutMs = DEFAULT_TIMEOUT): Promise<CdpClient> {
		const socket = await factory(url);
		if (socket.readyState !== OPEN) await waitForOpen(socket, timeoutMs);
		return new CdpClient(socket);
	}

	send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = DEFAULT_TIMEOUT,
	): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("CDP connection is closed"));
		const id = this.#nextId++;
		const { promise, resolve, reject } = deferred<T>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pending.set(id, {
			resolve: value => resolve(value as T),
			reject,
			timer,
		});
		try {
			this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	on(method: string, handler: CdpEventHandler, sessionId?: string): () => void {
		const key = eventKey(method, sessionId);
		let handlers = this.#handlers.get(key);
		if (!handlers) {
			handlers = new Set();
			this.#handlers.set(key, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#handlers.delete(key);
		};
	}

	waitFor(method: string, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
		const { promise, resolve, reject } = deferred<Record<string, unknown>>();
		const off = this.on(method, params => {
			clearTimeout(timer);
			off();
			resolve(params);
		}, sessionId);
		const timer = setTimeout(() => {
			off();
			reject(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		return promise;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.close();
		this.#dropPending(new Error("CDP connection closed"));
	}

	readonly #onMessage = (event: unknown): void => {
		void readMessage(event)
			.then(text => this.#route(JSON.parse(text) as CdpMessage))
			.catch(error => this.#dropPending(error instanceof Error ? error : new Error(String(error))));
	};

	readonly #onClose = (): void => {
		this.#closed = true;
		this.#dropPending(new Error("CDP connection closed"));
	};

	readonly #onError = (): void => {
		this.#dropPending(new Error("CDP WebSocket error"));
	};

	#route(message: CdpMessage): void {
		if (message.id !== undefined) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`CDP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (!message.method) return;
		const exact = this.#handlers.get(eventKey(message.method, message.sessionId));
		const broad = this.#handlers.get(eventKey(message.method));
		for (const handler of exact ?? []) handler(message.params ?? {});
		if (broad !== exact) for (const handler of broad ?? []) handler(message.params ?? {});
	}

	#dropPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function eventKey(method: string, sessionId?: string): string {
	return `${sessionId ?? "*"}:${method}`;
}

async function makeSocket(url: string): Promise<CdpSocket> {
	if (typeof globalThis.WebSocket === "function") return new globalThis.WebSocket(url) as CdpSocket;
	// Node before 22 has no global WebSocket, so ws must stay optional.
	const packageName = "ws";
	const loaded = (await import(packageName)) as WsModule;
	const WebSocketClass = loaded.WebSocket ?? loaded.default;
	if (!WebSocketClass) throw new Error("The optional ws package did not export WebSocket");
	return new WebSocketClass(url);
}

function waitForOpen(socket: CdpSocket, timeoutMs: number): Promise<void> {
	const { promise, resolve, reject } = deferred<void>();
	const done = (): void => {
		clearTimeout(timer);
		socket.removeEventListener?.("open", open);
		socket.removeEventListener?.("error", fail);
	};
	const open = (): void => {
		done();
		resolve();
	};
	const fail = (): void => {
		done();
		reject(new Error("Could not open CDP WebSocket"));
	};
	const timer = setTimeout(() => {
		done();
		reject(new Error(`CDP WebSocket open timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	socket.addEventListener("open", open);
	socket.addEventListener("error", fail);
	return promise;
}

async function readMessage(event: unknown): Promise<string> {
	let data = event;
	if (typeof event === "object" && event !== null && "data" in event) data = event.data;
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
	return String(data);
}
