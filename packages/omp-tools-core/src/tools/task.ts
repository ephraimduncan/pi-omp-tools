/**
 * `task` — fan out subagents in parallel, optionally workspace-isolated,
 * replicating oh-my-pi's task tool contract in host-CLI form:
 *
 *  - Batch shape `{ context, tasks[] }`: one subagent per item, all items run
 *    concurrently in a bounded pool; the flat single shape `{ task, agent? }`
 *    is folded into a one-item batch by prepareArguments.
 *  - Each subagent is a fresh `pi`/`prime-agent` process in `--mode json -p
 *    --no-session`, so it gets an isolated context window while inheriting
 *    the host's tools and extensions.
 *  - `agent` selects a named agent definition (markdown + frontmatter) from
 *    the project or user agent directories — model, tools, and system prompt.
 *  - `isolated: true` runs the item in a detached git worktree; its diff is
 *    captured as a patch artifact and applied back to the parent checkout
 *    (retained on apply failure), mirroring omp's isolation runner.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { textResult, ToolError, type PiApi, type ToolCtx, type ToolResult, type ToolUpdate } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { loadRenderSupport, taskRenderers } from "../render.ts";

const MAX_CONCURRENCY = Math.max(1, Number(process.env.OMP_TOOLS_TASK_CONCURRENCY) || 4);
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export const TASK_DESCRIPTION = `Fan out subagents in parallel, optionally workspace-isolated. Pass items in a \`tasks[]\` batch; execution blocks until all items finish and returns each agent's final report.

# Task Design
- Subagents start blank — no conversation history. Each \`task\` must be complete, self-contained instructions with acceptance criteria. One-liners are PROHIBITED.
- \`context\` carries shared project state, constraints, and cross-task contracts once; do not duplicate it into individual tasks.
- Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in \`context\`, not left for agents to negotiate.
- Each task MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end yourself.

# Inputs
- \`tasks[]\`: array of subagents to spawn.
  - \`name\`: stable CamelCase identifier (≤32 chars); generated automatically if omitted.
  - \`agent\`: named agent definition (from \`.pi/agents/*.md\` or the user agents dir); omit for the general-purpose worker.
  - \`task\`: complete instructions. Format: \`# Target\` (exact files/symbols; non-goals) / \`# Change\` (step-by-step) / \`# Acceptance\` (observable result).
  - \`isolated\`: run in a dedicated git worktree; successful changes are applied to the parent checkout, or retained as a patch artifact when applying fails.
  - \`cwd\`: working directory for this item.
- \`context\`: shared background prepended to every assignment. Format: \`# Goal\` / \`# Constraints\` / \`# Contract\`.

\`completed\` means the subagent exited cleanly, not artifact acceptance. Verify claimed changes.`;

export interface TaskItem {
	name?: string;
	agent?: string;
	task?: string;
	isolated?: boolean;
	cwd?: string;
}

export interface TaskParams {
	context?: string;
	tasks?: TaskItem[];
	// Flat single form (folded into tasks[] by prepareArguments).
	name?: string;
	agent?: string;
	task?: string;
	isolated?: boolean;
	cwd?: string;
}

export interface AgentDefinition {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	source: string;
}

/* ------------------------------ agent files ----------------------------- */

/** Parse `--- key: value ---` frontmatter + body from an agent markdown file. */
export function parseAgentFile(name: string, source: string, raw: string): AgentDefinition {
	const def: AgentDefinition = { name, source };
	let body = raw;
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (match) {
		body = raw.slice(match[0].length);
		for (const line of match[1]!.split(/\r?\n/)) {
			const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
			if (!kv) continue;
			const key = kv[1]!.toLowerCase();
			const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
			if (key === "name" && value) def.name = value;
			else if (key === "description") def.description = value;
			else if (key === "model") def.model = value;
			else if (key === "tools" && value) def.tools = value.split(",").map(part => part.trim()).filter(Boolean);
		}
	}
	const prompt = body.trim();
	if (prompt) def.systemPrompt = prompt;
	return def;
}

function agentDirs(cwd: string): string[] {
	const home = os.homedir();
	return [
		path.join(cwd, ".pi", "agents"),
		path.join(cwd, ".prime", "agents"),
		path.join(cwd, ".agents", "agents"),
		path.join(home, ".pi", "agent", "agents"),
		path.join(home, ".prime", "agent", "agents"),
	];
}

export async function discoverAgents(cwd: string): Promise<Map<string, AgentDefinition>> {
	const agents = new Map<string, AgentDefinition>();
	for (const dir of agentDirs(cwd)) {
		let entries: string[];
		try {
			entries = await fsp.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const file = path.join(dir, entry);
			try {
				const raw = await fsp.readFile(file, "utf8");
				const def = parseAgentFile(entry.slice(0, -3), file, raw);
				// First hit wins: project dirs shadow user dirs.
				if (!agents.has(def.name)) agents.set(def.name, def);
			} catch {
				/* unreadable agent file — skip */
			}
		}
	}
	return agents;
}

/* ------------------------------ name pool ------------------------------- */

const ADJECTIVES = [
	"Amber", "Bold", "Brisk", "Calm", "Clever", "Coral", "Crisp", "Deft",
	"Eager", "Fleet", "Golden", "Keen", "Lucid", "Mellow", "Nimble", "Quiet",
	"Rapid", "Sage", "Silver", "Solid", "Swift", "Tidy", "Vivid", "Witty",
] as const;
const NOUNS = [
	"Badger", "Condor", "Falcon", "Fox", "Heron", "Ibex", "Jay", "Koala",
	"Lark", "Lynx", "Marten", "Otter", "Owl", "Panda", "Puffin", "Raven",
	"Robin", "Sable", "Sparrow", "Stoat", "Swift", "Tern", "Wolf", "Wren",
] as const;

export function generateAgentName(taken: Set<string>): string {
	for (let attempt = 0; attempt < 64; attempt++) {
		const name =
			ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]! + NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
		if (!taken.has(name)) {
			taken.add(name);
			return name;
		}
	}
	let index = 1;
	while (taken.has(`Agent${index}`)) index++;
	const fallback = `Agent${index}`;
	taken.add(fallback);
	return fallback;
}

/* ------------------------------- host CLI -------------------------------- */

/** Resolve the host CLI to spawn for subagents (same trick as pi's subagent example). */
export function resolveHostCli(): { command: string; args: string[] } {
	const override = process.env.OMP_TOOLS_TASK_CLI;
	if (override?.trim()) {
		const parts = override.trim().split(/\s+/);
		return { command: parts[0]!, args: parts.slice(1) };
	}
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args: [] };
	return { command: "pi", args: [] };
}

/* -------------------------------- git ----------------------------------- */

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", data => {
			stdout += data.toString();
		});
		proc.stderr.on("data", data => {
			stderr += data.toString();
		});
		proc.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on("error", error => resolve({ code: 127, stdout: "", stderr: error.message }));
	});
}

interface Isolation {
	repoRoot: string;
	baseSha: string;
	worktree: string;
	/** Where the subagent runs: the task cwd remapped into the worktree. */
	runCwd: string;
}

async function prepareIsolation(taskCwd: string, name: string): Promise<Isolation | string> {
	const root = await git(taskCwd, ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return "isolation unavailable (not a git repository); ran in place";
	const repoRoot = root.stdout.trim();
	const head = await git(repoRoot, ["rev-parse", "HEAD"]);
	if (head.code !== 0) return "isolation unavailable (no commits yet); ran in place";
	const baseSha = head.stdout.trim();
	const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), `pi-omp-task-${name.toLowerCase()}-`));
	const added = await git(repoRoot, ["worktree", "add", "--detach", worktree, baseSha]);
	if (added.code !== 0) {
		await fsp.rm(worktree, { recursive: true, force: true }).catch(() => {});
		return `isolation unavailable (${added.stderr.trim() || "git worktree add failed"}); ran in place`;
	}
	const rel = path.relative(repoRoot, taskCwd);
	const runCwd = rel && !rel.startsWith("..") ? path.join(worktree, rel) : worktree;
	return { repoRoot, baseSha, worktree, runCwd };
}

interface IsolationOutcome {
	patchPath?: string;
	applied?: boolean;
	notice?: string;
}

async function captureAndMerge(iso: Isolation, name: string): Promise<IsolationOutcome> {
	try {
		await git(iso.worktree, ["add", "-A"]);
		const diff = await git(iso.worktree, ["diff", "--binary", "--cached", iso.baseSha]);
		if (diff.code !== 0) return { notice: `isolated diff capture failed: ${diff.stderr.trim()}` };
		if (!diff.stdout.trim()) return { notice: "isolated run produced no changes" };
		const artifacts = path.join(os.tmpdir(), "pi-omp-task-artifacts");
		await fsp.mkdir(artifacts, { recursive: true });
		const patchPath = path.join(artifacts, `${name}.patch`);
		await fsp.writeFile(patchPath, diff.stdout.endsWith("\n") ? diff.stdout : `${diff.stdout}\n`);
		if (process.env.OMP_TOOLS_TASK_NO_APPLY === "1") {
			return { patchPath, applied: false, notice: `patch retained (apply disabled): ${patchPath}` };
		}
		const apply = await git(iso.repoRoot, ["apply", "--3way", patchPath]);
		if (apply.code !== 0) {
			return { patchPath, applied: false, notice: `patch apply failed (${apply.stderr.trim().split("\n")[0]}); retained at ${patchPath}` };
		}
		return { patchPath, applied: true };
	} finally {
		await git(iso.repoRoot, ["worktree", "remove", "--force", iso.worktree]);
		await fsp.rm(iso.worktree, { recursive: true, force: true }).catch(() => {});
	}
}

/* ------------------------------ subprocess ------------------------------- */

interface SpawnUsage {
	turns: number;
	input: number;
	output: number;
	cost: number;
}

export interface TaskRunResult {
	name: string;
	agent: string;
	ok: boolean;
	exitCode: number;
	aborted?: boolean;
	finalText: string;
	stderr: string;
	usage: SpawnUsage;
	model?: string;
	wallTimeMs: number;
	isolated?: boolean;
	patchPath?: string;
	applied?: boolean;
	notice?: string;
}

function runSubagent(options: {
	prompt: string;
	cwd: string;
	agentDef?: AgentDefinition;
	signal?: AbortSignal;
	onEvent?: (kind: "turn" | "tool") => void;
}): Promise<{ exitCode: number; finalText: string; stderr: string; usage: SpawnUsage; model?: string; aborted: boolean }> {
	return new Promise(resolve => {
		const cli = resolveHostCli();
		const args = [...cli.args, "--mode", "json", "-p", "--no-session"];
		let promptFile: string | undefined;
		if (options.agentDef?.model) args.push("--model", options.agentDef.model);
		if (options.agentDef?.tools?.length) args.push("--tools", options.agentDef.tools.join(","));
		if (options.agentDef?.systemPrompt) {
			promptFile = path.join(os.tmpdir(), `pi-omp-agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
			fs.writeFileSync(promptFile, options.agentDef.systemPrompt);
			args.push("--append-system-prompt", promptFile);
		}
		args.push(options.prompt);

		const usage: SpawnUsage = { turns: 0, input: 0, output: 0, cost: 0 };
		let finalText = "";
		let stderr = "";
		let model: string | undefined;
		let aborted = false;
		let buffer = "";

		const proc = spawn(cli.command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, OMP_TOOLS_TASK_DEPTH: String(taskDepth() + 1) },
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: { role?: string; content?: unknown; usage?: Record<string, unknown>; model?: string } };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				usage.turns++;
				options.onEvent?.("turn");
				const messageUsage = event.message.usage as
					| { input?: number; output?: number; cost?: { total?: number } }
					| undefined;
				if (messageUsage) {
					usage.input += messageUsage.input ?? 0;
					usage.output += messageUsage.output ?? 0;
					usage.cost += messageUsage.cost?.total ?? 0;
				}
				if (!model && event.message.model) model = event.message.model;
				const content = event.message.content;
				const text = Array.isArray(content)
					? content
							.filter((part): part is { type: string; text: string } => {
								return !!part && typeof part === "object" && (part as { type?: string }).type === "text";
							})
							.map(part => part.text)
							.join("\n")
					: typeof content === "string"
						? content
						: "";
				if (text.trim()) finalText = text.trim();
			} else if (event.type === "tool_execution_start") {
				options.onEvent?.("tool");
			}
		};

		proc.stdout.on("data", data => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", data => {
			stderr += data.toString();
			if (stderr.length > PER_TASK_OUTPUT_CAP) stderr = stderr.slice(-PER_TASK_OUTPUT_CAP);
		});
		proc.on("close", code => {
			if (buffer.trim()) processLine(buffer);
			if (promptFile) fs.rmSync(promptFile, { force: true });
			resolve({ exitCode: code ?? 0, finalText, stderr, usage, model, aborted });
		});
		proc.on("error", error => {
			if (promptFile) fs.rmSync(promptFile, { force: true });
			stderr += error.message;
			resolve({ exitCode: 127, finalText, stderr, usage, model, aborted });
		});

		if (options.signal) {
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
			};
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/** Recursion guard: subagents may spawn sub-subagents only up to depth 2. */
function taskDepth(): number {
	const depth = Number(process.env.OMP_TOOLS_TASK_DEPTH);
	return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/* -------------------------------- execute -------------------------------- */

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatWall(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function taskStats(run: TaskRunResult): string {
	const parts = [formatWall(run.wallTimeMs)];
	if (run.usage.turns) parts.push(`${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}`);
	if (run.usage.input) parts.push(`↑${formatTokens(run.usage.input)}`);
	if (run.usage.output) parts.push(`↓${formatTokens(run.usage.output)}`);
	if (run.usage.cost) parts.push(`$${run.usage.cost.toFixed(4)}`);
	if (run.model) parts.push(run.model);
	return parts.join(" · ");
}

export async function executeTask(
	params: TaskParams,
	ctx?: ToolCtx,
	signal?: AbortSignal,
	onUpdate?: ToolUpdate,
): Promise<ToolResult> {
	const items = params.tasks ?? [];
	if (items.length === 0) throw new ToolError("`tasks` must contain at least one item");
	if (taskDepth() >= 2) throw new ToolError("Task recursion depth limit reached; do this work inline.");
	for (const item of items) {
		if (!item.task || !item.task.trim()) throw new ToolError("Every tasks[] item requires a non-empty `task`");
	}

	const cwd = ctx?.cwd ?? process.cwd();
	const agents = await discoverAgents(cwd);
	const taken = new Set<string>(items.map(item => item.name).filter((name): name is string => !!name));
	const batchStarted = Date.now();
	const statuses: string[] = [];
	/** Structured live progress for renderers: status kind + counters per agent. */
	const progress: Array<{ name: string; agent: string; status: string; turns: number; tools: number; isolated: boolean }> = [];
	const runs: Array<TaskRunResult | undefined> = Array.from({ length: items.length });

	const resolved = items.map((item, index) => {
		const name = item.name?.trim() || generateAgentName(taken);
		let agentDef: AgentDefinition | undefined;
		if (item.agent && item.agent !== "task") {
			agentDef = agents.get(item.agent);
			if (!agentDef) {
				const known = [...agents.keys()];
				throw new ToolError(
					`Unknown agent ${JSON.stringify(item.agent)}${known.length ? ` (available: ${known.join(", ")})` : " (no agent definitions found; omit \`agent\`)"}`,
				);
			}
		}
		statuses[index] = "queued";
		progress[index] = {
			name,
			agent: agentDef?.name ?? "task",
			status: "queued",
			turns: 0,
			tools: 0,
			isolated: item.isolated === true,
		};
		return { item, index, name, agentDef };
	});

	const pushUpdate = () => {
		if (!onUpdate) return;
		const rows = resolved.map(entry => `${entry.name} (${entry.agentDef?.name ?? "task"}): ${statuses[entry.index]}`);
		onUpdate({
			content: [{ type: "text", text: rows.join("\n") }],
			details: { running: true, rows, agents: progress.map(agent => ({ ...agent })), elapsedMs: Date.now() - batchStarted },
		});
	};
	pushUpdate();

	const runOne = async (entry: (typeof resolved)[number]): Promise<void> => {
		const started = Date.now();
		const taskCwd = entry.item.cwd ? path.resolve(cwd, entry.item.cwd) : cwd;
		let isolation: Isolation | undefined;
		let isolationNotice: string | undefined;
		statuses[entry.index] = "starting";
		progress[entry.index]!.status = "running";
		pushUpdate();

		if (entry.item.isolated === true) {
			const prepared = await prepareIsolation(taskCwd, entry.name);
			if (typeof prepared === "string") isolationNotice = prepared;
			else isolation = prepared;
		}

		const prompt = params.context?.trim()
			? `# Context\n${params.context.trim()}\n\n# Task\n${entry.item.task!.trim()}`
			: entry.item.task!.trim();

		let turns = 0;
		let tools = 0;
		const spawned = await runSubagent({
			prompt,
			cwd: isolation?.runCwd ?? taskCwd,
			agentDef: entry.agentDef,
			signal,
			onEvent: kind => {
				if (kind === "turn") turns++;
				else tools++;
				statuses[entry.index] = `running · ${turns} turn${turns === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}`;
				const live = progress[entry.index]!;
				live.status = "running";
				live.turns = turns;
				live.tools = tools;
				pushUpdate();
			},
		});

		let outcome: IsolationOutcome = {};
		if (isolation) outcome = await captureAndMerge(isolation, entry.name);

		const run: TaskRunResult = {
			name: entry.name,
			agent: entry.agentDef?.name ?? "task",
			ok: spawned.exitCode === 0 && !spawned.aborted,
			exitCode: spawned.exitCode,
			aborted: spawned.aborted,
			finalText: spawned.finalText.slice(0, PER_TASK_OUTPUT_CAP),
			stderr: spawned.stderr,
			usage: spawned.usage,
			model: spawned.model,
			wallTimeMs: Date.now() - started,
			isolated: entry.item.isolated === true,
			patchPath: outcome.patchPath,
			applied: outcome.applied,
			notice: outcome.notice ?? isolationNotice,
		};
		runs[entry.index] = run;
		statuses[entry.index] = run.ok ? `completed in ${formatWall(run.wallTimeMs)}` : spawned.aborted ? "aborted" : `failed (exit ${run.exitCode})`;
		progress[entry.index]!.status = run.ok ? `completed · ${formatWall(run.wallTimeMs)}` : spawned.aborted ? "aborted" : `failed: exit ${run.exitCode}`;
		pushUpdate();
	};

	// Bounded pool, preserving input order in the merged result.
	const queue = [...resolved];
	const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
		while (queue.length > 0) {
			if (signal?.aborted) return;
			const entry = queue.shift();
			if (!entry) return;
			await runOne(entry);
		}
	});
	await Promise.all(workers);

	if (signal?.aborted) throw new ToolError("Task batch aborted");

	const sections = resolved.map(entry => {
		const run = runs[entry.index];
		if (!run) return `## ${entry.name} — not started`;
		const header = `## ${run.name} (${run.agent}) — ${run.ok ? "completed" : `FAILED (exit ${run.exitCode})`} · ${taskStats(run)}`;
		const body = run.finalText || (run.ok ? "(no final report)" : run.stderr.split("\n").slice(-10).join("\n") || "(no output)");
		const extras: string[] = [];
		if (run.isolated) {
			if (run.applied) extras.push(`isolated: changes applied to parent checkout (patch: ${run.patchPath})`);
			else if (run.notice) extras.push(`isolated: ${run.notice}`);
		} else if (run.notice) {
			extras.push(run.notice);
		}
		return [header, body, ...extras.map(extra => `[${extra}]`)].join("\n");
	});

	const failed = runs.filter(run => run && !run.ok).length;
	const summaryLine = `${runs.length} subagent${runs.length === 1 ? "" : "s"}: ${runs.length - failed} completed, ${failed} failed`;
	return textResult([summaryLine, "", ...sections].join("\n"), {
		tasks: runs.filter((run): run is TaskRunResult => !!run),
		failed,
		wallTimeMs: Date.now() - batchStarted,
	});
}

/* -------------------------------- register ------------------------------- */

export async function registerTask(pi: PiApi): Promise<void> {
	registeredTools.add("task");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...taskRenderers(support) } : {}),
		name: "task",
		label: "Task",
		description: TASK_DESCRIPTION,
		promptSnippet: "Fan out subagents in parallel, optionally workspace-isolated",
		promptGuidelines: [
			"Use task to fan independent, self-contained work slices out to parallel subagents in one tasks[] batch; keep quick lookups and single edits inline.",
		],
		parameters: Type.Object({
			context: Type.Optional(
				Type.String({ description: "shared background for the whole batch (# Goal / # Constraints / # Contract)" }),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.Optional(Type.String({ description: "stable CamelCase identifier (≤32 chars)" })),
						agent: Type.Optional(Type.String({ description: "named agent definition; omit for the default worker" })),
						task: Type.String({ description: "complete, self-contained instructions (# Target / # Change / # Acceptance)" }),
						isolated: Type.Optional(Type.Boolean({ description: "run in a dedicated git worktree; changes are applied back or retained as a patch" })),
						cwd: Type.Optional(Type.String({ description: "working directory for this item" })),
					}),
					{ minItems: 1, description: "subagents to spawn (all items run in parallel)" },
				),
			),
			task: Type.Optional(Type.String({ description: "single-item form: the work (folded into tasks[])" })),
			agent: Type.Optional(Type.String({ description: "single-item form: agent name" })),
			name: Type.Optional(Type.String({ description: "single-item form: agent identifier" })),
			isolated: Type.Optional(Type.Boolean({ description: "single-item form: run isolated" })),
			cwd: Type.Optional(Type.String({ description: "single-item form: working directory" })),
		}),
		prepareArguments(args: unknown) {
			// Fold the flat single shape into a one-item batch.
			if (!args || typeof args !== "object") return args;
			const input = args as TaskParams;
			if (Array.isArray(input.tasks) && input.tasks.length > 0) return args;
			if (typeof input.task === "string" && input.task.trim()) {
				return {
					context: input.context,
					tasks: [{ name: input.name, agent: input.agent, task: input.task, isolated: input.isolated, cwd: input.cwd }],
				};
			}
			return args;
		},
		async execute(_id: string, call: TaskParams, signal?: AbortSignal, onUpdate?: ToolUpdate, callCtx?: ToolCtx) {
			return executeTask(call, callCtx, signal, onUpdate);
		},
	});
}
