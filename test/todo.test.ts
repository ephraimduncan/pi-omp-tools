import { createHash } from "node:crypto";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { executeTodo, ToolError, type ToolResult } from "../packages/lazy-prime-core/index.ts";

interface TodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "dropped" | "blocked";
	reason?: string;
}

interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

interface TodoDetails {
	phases: TodoPhase[];
	counts: {
		total: number;
		completed: number;
		dropped: number;
		open: number;
		blocked: number;
	};
}

function details(result: ToolResult): TodoDetails {
	assert.ok(result.details);
	assert.ok(Array.isArray(result.details.phases));
	assert.ok(result.details.counts && typeof result.details.counts === "object");
	// These checks guard the test's typed view of the public result.
	const value = result.details as unknown as TodoDetails;
	return value;
}

function task(result: ToolResult, content: string): TodoTask {
	const found = details(result).phases.flatMap(phase => phase.tasks).find(item => item.content === content);
	assert.ok(found, `missing task ${content}`);
	return found;
}

test("todo: phased init promotes the first task", { concurrency: false }, async () => {
	const result = await executeTodo({
		op: "init",
		list: [
			{ phase: "Foundation", items: ["Read the current implementation", "Port the mutation model"] },
			{ phase: "Verification", items: ["Run the focused todo tests"] },
		],
	});

	assert.equal(task(result, "Read the current implementation").status, "in_progress");
	assert.equal(task(result, "Port the mutation model").status, "pending");
	assert.deepEqual(details(result).counts, { total: 3, completed: 0, dropped: 0, open: 3, blocked: 0 });
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Foundation:/);
});

test("todo: done by content promotes the next task", { concurrency: false }, async () => {
	await executeTodo({ op: "init", items: ["Finish the first task", "Continue with the second task"] });
	const result = await executeTodo({ op: "done", task: "Finish the first task" });

	assert.equal(task(result, "Finish the first task").status, "completed");
	assert.equal(task(result, "Continue with the second task").status, "in_progress");
});

test("todo: out-of-order completion moves the pointer back", { concurrency: false }, async () => {
	await executeTodo({
		op: "init",
		items: ["Complete the earliest open task", "Complete the middle open task", "Complete the later task first"],
	});
	await executeTodo({ op: "start", task: "Complete the later task first" });
	const result = await executeTodo({ op: "done", task: "Complete the later task first" });

	assert.equal(task(result, "Complete the later task first").status, "completed");
	assert.equal(task(result, "Complete the earliest open task").status, "in_progress");
	assert.equal(task(result, "Complete the middle open task").status, "pending");
});

test("todo: blocked tasks leave the open count until unblocked", { concurrency: false }, async () => {
	await executeTodo({ op: "init", items: ["Wait for the external answer", "Continue independent implementation work"] });
	const blocked = await executeTodo({
		op: "block",
		task: "Wait for the external answer",
		reason: "waiting   on\nreview",
	});

	assert.deepEqual(task(blocked, "Wait for the external answer"), {
		content: "Wait for the external answer",
		status: "blocked",
		reason: "waiting on review",
	});
	assert.equal(details(blocked).counts.open, 1);
	assert.equal(details(blocked).counts.blocked, 1);

	const unblocked = await executeTodo({ op: "unblock", task: "Wait for the external answer" });
	assert.equal(task(unblocked, "Wait for the external answer").status, "pending");
	assert.equal(details(unblocked).counts.open, 2);
	assert.equal(details(unblocked).counts.blocked, 0);
});

test("todo: append lazily creates a phase", { concurrency: false }, async () => {
	await executeTodo({ op: "rm" });
	const result = await executeTodo({ op: "append", phase: "Release", items: ["Publish the finished package"] });

	assert.deepEqual(details(result).phases, [
		{ name: "Release", tasks: [{ content: "Publish the finished package", status: "in_progress" }] },
	]);
});

test("todo: rm removes a task, a phase, or the full list", { concurrency: false }, async () => {
	await executeTodo({
		op: "init",
		list: [
			{ phase: "Build", items: ["Keep this build task", "Remove this build task"] },
			{ phase: "Ship", items: ["Remove the whole ship phase"] },
		],
	});
	const withoutTask = await executeTodo({ op: "rm", task: "Remove this build task" });
	assert.equal(details(withoutTask).phases[0]?.tasks.length, 1);

	const withoutPhase = await executeTodo({ op: "rm", phase: "Ship" });
	assert.deepEqual(details(withoutPhase).phases.map(phase => phase.name), ["Build"]);

	const empty = await executeTodo({ op: "rm" });
	assert.deepEqual(details(empty).phases, []);
	assert.equal(details(empty).counts.total, 0);
});

test("todo: unknown content errors with the current list", { concurrency: false }, async () => {
	await executeTodo({ op: "init", items: ["Use this exact known task text"] });

	await assert.rejects(
		executeTodo({ op: "done", task: "Guessed task text" }),
		error =>
			error instanceof ToolError &&
			error.message.includes('Task "Guessed task text" not found') &&
			error.message.includes("Use this exact known task text"),
	);
	await assert.rejects(
		executeTodo({ op: "done", phase: "Unknown" }),
		error => error instanceof ToolError && error.message.includes('Phase "Unknown" not found') && error.message.includes("Tasks:"),
	);
});

test("todo: view does not mutate state", { concurrency: false }, async () => {
	const initialized = await executeTodo({ op: "init", items: ["Preserve this current todo state", "Preserve this pending todo state"] });
	const before = structuredClone(details(initialized));
	const viewed = await executeTodo({ op: "view" });

	assert.deepEqual(details(viewed), before);
	assert.match(viewed.content[0]?.type === "text" ? viewed.content[0].text : "", /Overall: 0\/2 done, 2 open\./);
});

test("todo: state is scoped and persisted per session id", { concurrency: false }, async () => {
	const ids = { a: `todo-test-a-${process.pid}-${Date.now()}`, b: `todo-test-b-${process.pid}-${Date.now()}` };
	const session = (id: string) => ({ cwd: process.cwd(), sessionManager: { getSessionId: () => id } });

	await executeTodo({ op: "init", items: ["Session A task"] }, session(ids.a));
	const other = await executeTodo({ op: "view" }, session(ids.b));
	assert.deepEqual(details(other).phases, []);

	// Simulate a process restart for session A: drop its in-memory state, keep the snapshot file.
	const globals = globalThis as Record<PropertyKey, unknown>;
	// Shape owned by todo.ts: session id -> state.
	const states = globals[Symbol.for("lazy-prime.todo.v2")] as Map<string, unknown>;
	states.delete(ids.a);
	const recovered = await executeTodo({ op: "view" }, session(ids.a));
	assert.equal(details(recovered).phases[0]?.tasks[0]?.content, "Session A task");

	// A ctx without a session manager never touches session state.
	const fallback = await executeTodo({ op: "view" }, { cwd: process.cwd() });
	assert.ok(!details(fallback).phases.some(phase => phase.tasks.some(t => t.content === "Session A task")));
});

test("todo: legacy snapshot names migrate into Lazy Prime state", { concurrency: false }, async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lazy-prime-todo-migrate-"));
	const id = `todo-migrate-${process.pid}-${Date.now()}`;
	const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
	const previousScratch = process.env.PI_SCRATCH_DIR;
	process.env.PI_SCRATCH_DIR = dir;
	try {
		await fs.writeFile(path.join(dir, `legacy-todo-${hash}.json`), JSON.stringify({
			phases: [{ name: "Migrated", tasks: [{ content: "Recover the prior todo snapshot", status: "in_progress" }] }],
		}), "utf8");
		const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => id } };
		const recovered = await executeTodo({ op: "view" }, ctx);
		assert.equal(details(recovered).phases[0]?.tasks[0]?.content, "Recover the prior todo snapshot");
		assert.match(await fs.readFile(path.join(dir, `lazy-prime-todo-${hash}.json`), "utf8"), /Recover the prior todo snapshot/);
	} finally {
		if (previousScratch === undefined) delete process.env.PI_SCRATCH_DIR;
		else process.env.PI_SCRATCH_DIR = previousScratch;
		await fs.rm(dir, { recursive: true, force: true });
	}
});
