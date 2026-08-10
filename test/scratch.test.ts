/**
 * Tests for pi-tmp-scratch (per-session /tmp scratch dir + prompt steering).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import tmpScratch, { SCRATCH_MARKER, scratchRoot } from "../packages/pi-tmp-scratch/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeFakePi(): {
	pi: { on: (event: string, handler: Handler) => void; registerCommand: (name: string, options: { handler: Handler }) => void };
	handlers: Map<string, Handler[]>;
	commands: Map<string, Handler>;
} {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Handler>();
	return {
		pi: {
			on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerCommand: (name, options) => commands.set(name, options.handler),
		},
		handlers,
		commands,
	};
}

const SESSION_ID = `omp-tools-scratch-test-${process.pid}`;
const ctx = (notifications?: string[]) => ({
	sessionManager: { getSessionId: () => SESSION_ID },
	ui: { notify: (message: string) => notifications?.push(message) },
});
const expectedDir = path.join(scratchRoot(), "pi-scratch", SESSION_ID);

test("scratch: session_start creates the dir and exports PI_SCRATCH_DIR", async () => {
	await fs.rm(expectedDir, { recursive: true, force: true });
	const { pi, handlers } = makeFakePi();
	tmpScratch(pi as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx());
	const stat = await fs.stat(expectedDir);
	assert.ok(stat.isDirectory());
	assert.equal(process.env.PI_SCRATCH_DIR, expectedDir);
});

test("scratch: before_agent_start appends the prompt block once", async () => {
	const { pi, handlers } = makeFakePi();
	tmpScratch(pi as never);
	const handler = (handlers.get("before_agent_start") ?? [])[0];
	assert.ok(handler, "before_agent_start handler registered");

	const outcome = (await handler({ systemPrompt: "BASE PROMPT" }, ctx())) as { systemPrompt: string };
	assert.match(outcome.systemPrompt, /^BASE PROMPT/);
	assert.ok(outcome.systemPrompt.includes(SCRATCH_MARKER));
	assert.ok(outcome.systemPrompt.includes(expectedDir));
	assert.match(outcome.systemPrompt, /NEVER create temporary or scratch files inside the repository/);

	// Already-steered prompt is left alone (other packages may chain).
	const again = await handler({ systemPrompt: outcome.systemPrompt }, ctx());
	assert.equal(again, undefined);
	// Non-string prompt (defensive) is a no-op.
	assert.equal(await handler({}, ctx()), undefined);
});

test("scratch: /scratch shows contents, /scratch clean empties the dir", async () => {
	const { pi, commands } = makeFakePi();
	tmpScratch(pi as never);
	const command = commands.get("scratch");
	assert.ok(command, "/scratch command registered");

	await fs.mkdir(expectedDir, { recursive: true });
	await fs.writeFile(path.join(expectedDir, "probe.py"), "print('scratch')\n");

	const shown: string[] = [];
	await command("", ctx(shown));
	assert.equal(shown.length, 1);
	assert.ok(shown[0]?.includes(expectedDir));
	assert.match(shown[0] ?? "", /1 entry/);

	const cleaned: string[] = [];
	await command("clean", ctx(cleaned));
	assert.match(cleaned[0] ?? "", /cleaned/);
	assert.deepEqual(await fs.readdir(expectedDir), []);

	await fs.rm(expectedDir, { recursive: true, force: true });
});

test("scratch: falls back to pid slug without a session manager", async () => {
	const { pi, handlers } = makeFakePi();
	tmpScratch(pi as never);
	const handler = (handlers.get("before_agent_start") ?? [])[0];
	const outcome = (await handler?.({ systemPrompt: "P" }, {})) as { systemPrompt: string };
	const pidDir = path.join(scratchRoot(), "pi-scratch", `pid-${process.pid}`);
	assert.ok(outcome.systemPrompt.includes(pidDir));
	await fs.rm(pidDir, { recursive: true, force: true });
});
