import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import {
	CdpClient,
	classifySelector,
	compactAxTree,
	discoverBrowserExecutable,
	discoverObscuraExecutable,
	executeBrowser,
	formatAriaSnapshot,
	KEY_MAP,
	registerBrowser,
	runBrowserCode,
	type AxNode,
	type CdpSocket,
} from "../packages/omp-tools-core/index.ts";

class MockSocket implements CdpSocket {
	readonly readyState = 1;
	readonly sent: string[] = [];
	readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

	send(data: string): void {
		this.sent.push(data);
		const request = JSON.parse(data) as { id: number };
		queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: request.id, result: { ok: true } }) }));
	}

	close(): void {
		this.emit("close", {});
	}

	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
		let listeners = this.#listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

const AX_NODES: AxNode[] = [
	{
		nodeId: "1",
		role: { value: "RootWebArea" },
		name: { value: "Demo" },
		backendDOMNodeId: 1,
		childIds: ["2", "3"],
	},
	{
		nodeId: "2",
		parentId: "1",
		role: { value: "button" },
		name: { value: "Save" },
		backendDOMNodeId: 42,
	},
	{
		nodeId: "3",
		parentId: "1",
		role: { value: "textbox" },
		name: { value: "Email" },
		value: { value: "a@example.com" },
		backendDOMNodeId: 43,
	},
];

test("browser selector kinds and key map", () => {
	assert.deepEqual(classifySelector("button.primary"), { kind: "css", value: "button.primary" });
	assert.deepEqual(classifySelector("e12"), { kind: "ref", id: 12 });
	assert.deepEqual(classifySelector("aria-ref=e3"), { kind: "ref", id: 3 });
	assert.deepEqual(classifySelector("xpath///button"), { kind: "xpath", value: "//button" });
	assert.deepEqual(classifySelector("text/Continue"), { kind: "text", value: "Continue" });
	assert.deepEqual(KEY_MAP.Enter, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	assert.equal(KEY_MAP.ArrowDown?.windowsVirtualKeyCode, 40);
});

test("browser run scope compiles an async body in a worker", async () => {
	const tab = { value: async () => 4 };
	const result = await runBrowserCode(
		"const v = await tab.value(); display(v); let tries = 0; const ready = await wait(() => ++tries === 2, { timeout: 500 }); assert(ready, 'not ready'); return v + 3;",
		{ tab },
	);
	assert.deepEqual(result.displays, [4]);
	assert.equal(result.returnValue, 7);
	await assert.rejects(() => runBrowserCode("assert(false, 'boom')", { tab }), /boom/);
});

test("browser run hard-terminates hung and busy-looping code", { timeout: 20_000 }, async () => {
	const tab = {};
	await assert.rejects(
		() => runBrowserCode("await new Promise(() => {})", { tab, timeoutMs: 750 }),
		/timed out after 0\.75s/,
	);
	const start = Date.now();
	await assert.rejects(() => runBrowserCode("while (true) {}", { tab, timeoutMs: 750 }), /timed out after 0\.75s/);
	assert.ok(Date.now() - start < 10_000, "busy loop must not block termination");
});

test("CDP client frames commands and routes session events", async () => {
	const socket = new MockSocket();
	const client = new CdpClient(socket);
	const response = await client.send<{ ok: boolean }>("Runtime.enable", { test: 1 }, "session-7");
	assert.deepEqual(response, { ok: true });
	assert.deepEqual(JSON.parse(socket.sent[0] as string), {
		id: 1,
		method: "Runtime.enable",
		params: { test: 1 },
		sessionId: "session-7",
	});
	const event = client.waitFor("Page.loadEventFired", "session-7");
	socket.emit("message", {
		data: JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 12 }, sessionId: "session-7" }),
	});
	assert.deepEqual(await event, { timestamp: 12 });
	client.close();
});

test("accessibility nodes compact and format with stable refs", () => {
	assert.deepEqual(compactAxTree(AX_NODES), {
		elements: [
			{ id: 1, role: "RootWebArea", name: "Demo" },
			{ id: 2, role: "button", name: "Save" },
			{ id: 3, role: "textbox", name: "Email", value: "a@example.com" },
		],
	});
	assert.equal(
		formatAriaSnapshot(AX_NODES),
		'- RootWebArea "Demo" [ref=e1]\n  - button "Save" [ref=e2]\n  - textbox "Email" [ref=e3]',
	);
});

test("browser drives a real headless browser and closes its process", { timeout: 45_000 }, async t => {
	const executable = await discoverObscuraExecutable() ?? await discoverBrowserExecutable();
	if (!executable) {
		t.skip("No supported browser is installed");
		return;
	}
	await executeBrowser({ action: "close", all: true, kill: true });
	const url = `data:text/html,${encodeURIComponent('<button id="b" onclick="this.textContent=\'Clicked\'">Push</button>')}`;
	let pid: number | undefined;
	try {
		const opened = await executeBrowser({
			action: "open",
			name: "integration",
			url,
			viewport: { width: 800, height: 600, scale: 1 },
		});
		pid = typeof opened.details?.pid === "number" ? opened.details.pid : undefined;
		assert.ok(pid);
		const sum = await executeBrowser({ action: "run", name: "integration", code: "return await tab.evaluate('1 + 1');" });
		assert.equal(sum.content[0]?.type, "text");
		assert.equal(sum.content[0]?.type === "text" ? sum.content[0].text : "", "2");
		const clicked = await executeBrowser({
			action: "run",
			name: "integration",
			code: "await tab.click('#b'); return await tab.evaluate('document.querySelector(\"#b\").textContent');",
		});
		assert.equal(clicked.content[0]?.type === "text" ? clicked.content[0].text : "", "Clicked");
		const shot = await executeBrowser({
			action: "run",
			name: "integration",
			code: "return await tab.screenshot({ selector: '#b' });",
		});
		const file = shot.content[0]?.type === "text" ? shot.content[0].text : "";
		assert.ok((await fs.stat(file)).size > 100);
		await fs.rm(file, { force: true });
	} finally {
		await executeBrowser({ action: "close", name: "integration", kill: true });
	}
	if (pid) assert.throws(() => process.kill(pid, 0));
});

test("browser tabs are scoped per session and closed on session shutdown", { timeout: 45_000 }, async t => {
	const executable = await discoverObscuraExecutable() ?? await discoverBrowserExecutable();
	if (!executable) {
		t.skip("No supported browser is installed");
		return;
	}
	const session = (id: string) => ({ cwd: process.cwd(), sessionManager: { getSessionId: () => id } });
	const a = session(`browser-a-${process.pid}-${Date.now()}`);
	const b = session(`browser-b-${process.pid}-${Date.now()}`);
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	await registerBrowser({
		registerTool() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
	});
	const url = `data:text/html,${encodeURIComponent("<p>iso</p>")}`;
	let pid: number | undefined;
	try {
		const opened = await executeBrowser({ action: "open", name: "main", url }, a);
		pid = typeof opened.details?.pid === "number" ? opened.details.pid : undefined;
		assert.ok(pid);
		const livePid = pid;

		// Another session closing "all" must not reach this session's tab.
		const foreign = await executeBrowser({ action: "close", all: true, kill: true }, b);
		assert.match(foreign.content[0]?.type === "text" ? foreign.content[0].text : "", /Closed 0 tab/);
		const alive = await executeBrowser({ action: "run", name: "main", code: "return await tab.evaluate('1 + 1');" }, a);
		assert.equal(alive.content[0]?.type === "text" ? alive.content[0].text : "", "2");

		// Session shutdown closes the session's tabs and its spawned browser.
		const shutdown = handlers.get("session_shutdown");
		assert.ok(shutdown, "registerBrowser must wire session_shutdown");
		await shutdown({ type: "session_shutdown", reason: "quit" }, a);
		assert.throws(() => process.kill(livePid, 0));
	} finally {
		await executeBrowser({ action: "close", all: true, kill: true }, a).catch(() => {});
	}
});
