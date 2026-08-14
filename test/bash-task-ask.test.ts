import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
	clampBashTimeout,
	discoverAgents,
	executeAsk,
	executeBash,
	executeTask,
	generateAgentName,
	parseAgentFile,
	registerAsk,
	registerBash,
	registerTask,
	resolveHostCli,
	ToolError,
	type AskUi,
	type ToolResult,
} from "../packages/omp-tools-core/index.ts";
function text(result: ToolResult): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n");
}

/* --------------------------------- bash --------------------------------- */

test("bash: runs a command and reports exit 0", async () => {
	const result = await executeBash({ command: "echo hello" });
	assert.equal(text(result), "hello");
	assert.equal(result.details?.exitCode, 0);
	assert.equal(result.details?.timedOut, false);
});

test("bash: non-zero exit is a result, not a thrown error", async () => {
	const result = await executeBash({ command: "echo boom >&2; exit 3" });
	assert.match(text(result), /boom/);
	assert.match(text(result), /\(exit 3\)/);
	assert.equal(result.details?.exitCode, 3);
});

test("bash: cwd and env params apply", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-bash-test-"));
	const result = await executeBash({ command: "pwd; echo $OMP_TOOLS_TEST_VALUE", cwd: dir, env: { OMP_TOOLS_TEST_VALUE: "marker-42" } });
	const lines = text(result).split("\n");
	assert.equal(fs.realpathSync(lines[0]!), fs.realpathSync(dir));
	assert.equal(lines[1], "marker-42");
});

test("bash: timeout kills the command and marks timedOut", async () => {
	const started = Date.now();
	const result = await executeBash({ command: "sleep 30", timeout: 1 });
	assert.ok(Date.now() - started < 10_000, "timeout must fire well before the sleep finishes");
	assert.equal(result.details?.timedOut, true);
	assert.match(text(result), /timed out after 1 seconds/);
});

test("bash: clamp helper mirrors omp's rules", () => {
	assert.equal(clampBashTimeout(undefined), 300);
	assert.equal(clampBashTimeout(0), undefined);
	assert.equal(clampBashTimeout(999_999), 3600);
	assert.equal(clampBashTimeout(0.2), 1);
});

test("bash: missing command without op throws", async () => {
	await assert.rejects(() => executeBash({}), ToolError);
});

test("bash: async dispatch returns a job id and wait settles it", async () => {
	const start = await executeBash({ command: "sleep 0.2; echo settled-output", async: true });
	assert.match(text(start), /Backgrounded as job (b\d+)/);
	const jobId = /job (b\d+)/.exec(text(start))?.[1];
	assert.ok(jobId);

	const jobs = await executeBash({ op: "jobs" });
	assert.match(text(jobs), new RegExp(jobId!));

	const waited = await executeBash({ op: "wait", job: jobId });
	assert.match(text(waited), /settled-output/);
	assert.equal(waited.details?.exitCode, 0);
});

test("bash: op kill stops a running job", async () => {
	const start = await executeBash({ command: "sleep 60", async: true });
	const jobId = /job (b\d+)/.exec(text(start))?.[1];
	assert.ok(jobId);
	const killed = await executeBash({ op: "kill", job: jobId });
	assert.match(text(killed), /SIGTERM/);
	const waited = await executeBash({ op: "wait", job: jobId, timeout: 30 });
	assert.match(text(waited), /Command killed/);
});

test("bash: auto-background converts a slow foreground command", async () => {
	process.env.OMP_TOOLS_BASH_AUTOBG_MS = "300";
	try {
		let delivered: string | undefined;
		const deliveredPromise = new Promise<void>(resolve => {
			void resolve;
		});
		void deliveredPromise;
		const result = await executeBash({ command: "sleep 1; echo late-output" }, undefined, undefined, undefined, textOut => {
			delivered = textOut;
		});
		assert.match(text(result), /Backgrounded as job/);
		// The settled result auto-delivers.
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.ok(delivered, "expected background delivery");
		assert.match(delivered!, /late-output/);
		assert.match(delivered!, /<background-job id="b\d+" status="completed"/);
	} finally {
		delete process.env.OMP_TOOLS_BASH_AUTOBG_MS;
	}
});

test("bash: large output is truncated inline with a log file", async () => {
	const result = await executeBash({ command: "seq 1 20000" });
	assert.match(text(result), /truncated: \d+ bytes total/);
	assert.match(text(result), /20000$/);
	const logFile = result.details?.logFile;
	assert.ok(typeof logFile === "string" && fs.existsSync(logFile));
	const full = fs.readFileSync(logFile as string, "utf8");
	assert.match(full, /^1\n2\n3\n/);
});

/* --------------------------------- task --------------------------------- */

test("task: generated names are unique AdjectiveNoun identifiers", () => {
	const taken = new Set<string>();
	for (let index = 0; index < 40; index++) {
		const name = generateAgentName(taken);
		assert.match(name, /^[A-Z][A-Za-z0-9]+$/);
	}
	assert.equal(taken.size, 40);
});

test("task: agent frontmatter parses name/model/tools and prompt body", () => {
	const def = parseAgentFile("scout", "/tmp/scout.md", "---\nname: scout\nmodel: gpt-5\ntools: read, search\ndescription: read-only researcher\n---\nYou are a read-only scout.\n");
	assert.equal(def.name, "scout");
	assert.equal(def.model, "gpt-5");
	assert.deepEqual(def.tools, ["read", "search"]);
	assert.equal(def.description, "read-only researcher");
	assert.match(def.systemPrompt ?? "", /read-only scout/);
});

test("task: discoverAgents reads project agent dirs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-task-agents-"));
	fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "agents", "reviewer.md"), "---\ndescription: reviews diffs\n---\nReview carefully.");
	const agents = await discoverAgents(dir);
	const reviewer = agents.get("reviewer");
	assert.ok(reviewer);
	assert.equal(reviewer?.description, "reviews diffs");
});

test("task: resolveHostCli honors OMP_TOOLS_TASK_CLI", () => {
	process.env.OMP_TOOLS_TASK_CLI = "node /tmp/fake-agent.js";
	try {
		const cli = resolveHostCli();
		assert.equal(cli.command, "node");
		assert.deepEqual(cli.args, ["/tmp/fake-agent.js"]);
	} finally {
		delete process.env.OMP_TOOLS_TASK_CLI;
	}
});

function writeFakeAgent(dir: string, options: { writeFile?: string; failing?: boolean } = {}): string {
	const script = path.join(dir, "fake-agent.mjs");
	const body = `
import * as fs from "node:fs";
const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
${options.writeFile ? `fs.writeFileSync(${JSON.stringify(options.writeFile)}, "written by fake agent\\n");` : ""}
const message = {
	role: "assistant",
	model: "fake-1",
	usage: { input: 100, output: 20, cost: { total: 0.001 } },
	content: [{ type: "text", text: "Report for: " + prompt.split("\\n")[0] }],
};
console.log(JSON.stringify({ type: "message_end", message }));
process.exit(${options.failing ? 2 : 0});
`;
	fs.writeFileSync(script, body);
	return script;
}

test("task: batch fans out and merges per-task reports", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-task-run-"));
	const script = writeFakeAgent(dir);
	process.env.OMP_TOOLS_TASK_CLI = `node ${script}`;
	try {
		const result = await executeTask(
			{
				context: "# Goal\nTest run",
				tasks: [
					{ name: "AlphaWorker", task: "# Target\nDo alpha work with a full brief." },
					{ name: "BetaWorker", task: "# Target\nDo beta work with a full brief." },
				],
			},
			{ cwd: dir },
		);
		const body = text(result);
		assert.match(body, /2 subagents: 2 completed, 0 failed/);
		assert.match(body, /## AlphaWorker \(task\) — completed/);
		assert.match(body, /## BetaWorker \(task\) — completed/);
		assert.match(body, /Report for: # Context/);
		const tasks = result.details?.tasks as Array<{ usage: { input: number }; model?: string }>;
		assert.equal(tasks.length, 2);
		assert.equal(tasks[0]?.usage.input, 100);
		assert.equal(tasks[0]?.model, "fake-1");
	} finally {
		delete process.env.OMP_TOOLS_TASK_CLI;
	}
});

test("task: failing subagent is reported, not thrown", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-task-fail-"));
	const script = writeFakeAgent(dir, { failing: true });
	process.env.OMP_TOOLS_TASK_CLI = `node ${script}`;
	try {
		const result = await executeTask({ tasks: [{ task: "# Target\nFail on purpose with a full brief." }] }, { cwd: dir });
		assert.match(text(result), /1 subagent: 0 completed, 1 failed/);
		assert.match(text(result), /FAILED \(exit 2\)/);
	} finally {
		delete process.env.OMP_TOOLS_TASK_CLI;
	}
});

test("task: isolated item runs in a worktree and applies the patch back", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-task-iso-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
	const script = writeFakeAgent(repo, { writeFile: "agent-output.txt" });
	process.env.OMP_TOOLS_TASK_CLI = `node ${script}`;
	try {
		const result = await executeTask(
			{ tasks: [{ name: "IsoWorker", task: "# Target\nWrite agent-output.txt with a full brief.", isolated: true }] },
			{ cwd: repo },
		);
		const body = text(result);
		assert.match(body, /IsoWorker \(task\) — completed/);
		assert.match(body, /isolated: changes applied to parent checkout/);
		assert.equal(fs.readFileSync(path.join(repo, "agent-output.txt"), "utf8"), "written by fake agent\n");
		const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
		assert.equal(worktrees.trim().split("\n").length, 1, "isolation worktree must be removed");
	} finally {
		delete process.env.OMP_TOOLS_TASK_CLI;
	}
});

test("task: empty batch and unknown agent fail fast", async () => {
	await assert.rejects(() => executeTask({ tasks: [] }), ToolError);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-omp-task-agents-none-"));
	await assert.rejects(
		() => executeTask({ tasks: [{ task: "# Target\nWork.", agent: "no-such-agent" }] }, { cwd: dir }),
		/Unknown agent "no-such-agent"/,
	);
});

/* ---------------------------------- ask ---------------------------------- */

function fakeUi(script: Array<{ select?: string; input?: string }>): AskUi {
	let step = 0;
	return {
		async select(_title, options) {
			const entry = script[step++];
			assert.ok(entry && "select" in entry, `unexpected select at step ${step}`);
			const wanted = entry.select;
			if (wanted === undefined) return undefined;
			const match = options.find(option => option === wanted || option.includes(wanted));
			assert.ok(match, `option ${wanted} not offered: ${JSON.stringify(options)}`);
			return match;
		},
		async input() {
			const entry = script[step++];
			assert.ok(entry && "input" in entry, `unexpected input at step ${step}`);
			return entry.input;
		},
	};
}

test("ask: fails without an interactive UI", async () => {
	await assert.rejects(
		() => executeAsk({ questions: [{ question: "Pick one", options: [{ label: "A" }] }] }),
		/interactive session/,
	);
});

test("ask: single select maps display labels back to option labels", async () => {
	const ui = fakeUi([{ select: "SQLite" }]);
	const result = await executeAsk(
		{
			questions: [
				{
					id: "db",
					question: "Which database?",
					options: [
						{ label: "SQLite", description: "zero-config" },
						{ label: "PostgreSQL", description: "managed" },
					],
					recommended: 0,
				},
			],
		},
		{ ui, hasUI: true },
	);
	const results = result.details?.results as Array<{ selectedOptions: string[] }>;
	assert.deepEqual(results[0]?.selectedOptions, ["SQLite"]);
	assert.match(text(result), /\*\*Which database\?\*\* → SQLite/);
});

test("ask: Other routes through text input", async () => {
	const ui = fakeUi([{ select: "Other (type your own)" }, { input: "use redis" }]);
	const result = await executeAsk(
		{ questions: [{ question: "Which cache?", options: [{ label: "In-memory" }] }] },
		{ ui, hasUI: true },
	);
	const results = result.details?.results as Array<{ customInput?: string }>;
	assert.equal(results[0]?.customInput, "use redis");
});

test("ask: multi select toggles then finishes on Done", async () => {
	const ui = fakeUi([{ select: "[ ] JWT" }, { select: "[ ] Session cookies" }, { select: "✓ Done" }]);
	const result = await executeAsk(
		{
			questions: [
				{ question: "Auth methods?", multi: true, options: [{ label: "JWT" }, { label: "Session cookies" }, { label: "OAuth" }] },
			],
		},
		{ ui, hasUI: true },
	);
	const results = result.details?.results as Array<{ selectedOptions: string[] }>;
	assert.deepEqual(results[0]?.selectedOptions, ["JWT", "Session cookies"]);
});

test("ask: chat redirect skips remaining questions", async () => {
	const ui = fakeUi([{ select: "Chat about this" }]);
	const result = await executeAsk(
		{
			questions: [
				{ question: "First?", options: [{ label: "A" }] },
				{ question: "Second?", options: [{ label: "B" }] },
			],
		},
		{ ui, hasUI: true },
	);
	assert.equal(result.details?.chatRedirect, true);
	assert.match(text(result), /discuss instead of answering/);
	const results = result.details?.results as Array<{ cancelled?: boolean }>;
	assert.equal(results.length, 2);
	assert.equal(results[1]?.cancelled, true);
});

test("ask: reserved option labels are rejected", async () => {
	await assert.rejects(
		() =>
			executeAsk(
				{ questions: [{ question: "Q", options: [{ label: "Other (type your own)" }] }] },
				{ ui: fakeUi([]), hasUI: true },
			),
		/reserved runtime label/,
	);
});

/* ------------------------------ registration ------------------------------ */

test("registration: bash/task/ask register with prompt integration", async () => {
	const tools: Array<{ name: string; promptGuidelines?: string[]; description?: string }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fakePi = {
		registerTool: (def: { name: string }) => tools.push(def as never),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	await registerBash(fakePi as never);
	await registerTask(fakePi as never);
	await registerAsk(fakePi as never);
	assert.deepEqual(tools.map(tool => tool.name).sort(), ["ask", "bash", "task"]);
	assert.ok(tools.every(tool => (tool.promptGuidelines?.length ?? 0) > 0));

	// The shared prompt contract advertises all three (registry is process-global,
	// so the handler may already be wired by another test file's registration).
	const beforeAgentStart = handlers.get("before_agent_start") ?? [];
	if (beforeAgentStart.length > 0) {
		const outcome = (await beforeAgentStart[0]?.({ systemPrompt: "BASE" }, {})) as { systemPrompt: string } | undefined;
		const prompt = outcome?.systemPrompt ?? "";
		assert.match(prompt, /bash — workspace shell with optional PTY and background-job dispatch/);
		assert.match(prompt, /task — fan out subagents in parallel, optionally workspace-isolated/);
		assert.match(prompt, /ask — structured follow-up questions for interactive runs/);
	}
});
