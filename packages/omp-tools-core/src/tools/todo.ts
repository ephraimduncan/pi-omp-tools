import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { sessionId, ToolError, textResult, type PiApi, type ToolCtx, type ToolResult } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "dropped" | "blocked";
export type TodoOp = "init" | "start" | "done" | "drop" | "block" | "unblock" | "rm" | "append" | "view";

export interface TodoTask {
	content: string;
	status: TodoStatus;
	reason?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoParams {
	op: TodoOp;
	list?: Array<{ phase: string; items: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
}

interface TodoCounts {
	total: number;
	completed: number;
	dropped: number;
	open: number;
	blocked: number;
}

interface TodoState {
	phases: TodoPhase[];
	loaded: boolean;
	file?: string;
}

export const TODO_DESCRIPTION = `**Tasks are referenced by their verbatim content string, NEVER an auto-generated ID.** No "task-1" or "task-N" exists. Pass the content text in the \`task\` field.

On each completion, the earliest still-open task in phase order auto-promotes to \`in_progress\`. Completing tasks out of phase order can move this pointer back to an earlier phase. This is expected; completed tasks never revert.

## Operations

| \`op\` | Required fields | Effect |
|---|---|---|
| \`init\` | \`list: [{phase, items: string[]}]\` | Initialize the full list and replace the old one |
| \`init\` | \`items: string[]\` | Initialize one implicit phase |
| \`start\` | \`task\` | Mark a task in progress |
| \`done\` | \`task\` or \`phase\` | Mark a task or every task in a phase completed |
| \`drop\` | \`task\` or \`phase\` | Mark a task or every task in a phase dropped |
| \`block\` | \`task\` or \`phase\`, optional \`reason\` | Mark open work blocked; blocked tasks stay tracked but do not count in the stop reminder |
| \`unblock\` | \`task\` or \`phase\` | Return blocked work to pending |
| \`rm\` | optional \`task\` or \`phase\` | Remove a task or phase; omit both to clear the list |
| \`append\` | \`phase\`, \`items: string[]\` | Append tasks and lazily create the phase |
| \`view\` | none | Echo the list without changing it |

## Anatomy

- **Task content**: 5–10 words that say what, not how. It is a unique identifier.
- **Phase name**: short, unique noun phrase such as \`Foundation\`, \`Auth\`, or \`Verification\`. NEVER prefix it with \`1.\`, \`A)\`, or \`Phase 1:\`.

## Rules

- Mark tasks done as soon as they finish. Complete phases in order.
- NEVER make a todo call the only tool call in a turn. Batch it with the real work: \`init\` with the first reads or edits, and each \`done\` or \`start\` with the next action.
- Block work that waits on input you cannot obtain now. Unblock it when it becomes actionable. If you can resolve the blocker yourself, append that work instead.
- Keep task and phase strings stable once introduced.
- If you lose the exact task text, use \`view\`. NEVER guess from memory.

<critical>
When the user gives a multi-item plan, phased list, numbered or bulleted checklist, or "N bugs/items/tasks", you MUST initialize EVERY item as its own task before working. Enumerate all items. NEVER summarize them into fewer tasks, sample only some, drop items, or track the rest from memory.
</critical>`;

const TODO_KEY = Symbol.for("omp-tools.todo.v2");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[TODO_KEY] ??= new Map<string, TodoState>();
// This key is process-owned and initialized to the session-state map above.
const states = globals[TODO_KEY] as Map<string, TodoState>;

/**
 * One list per session. Hosts that expose a session id also get a per-session
 * snapshot file, so resuming that session in a new process recovers its list
 * while other sessions and later sessions in the same cwd stay untouched.
 * Without a session id the list lives in memory only.
 */
function stateFor(key: string | undefined): TodoState {
	let state = states.get(key ?? "");
	if (state) return state;
	state = { phases: [], loaded: false };
	if (key) {
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		state.file = path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), `pi-omp-todo-${hash}.json`);
	}
	states.set(key ?? "", state);
	return state;
}

export async function executeTodo(params: TodoParams, ctx?: ToolCtx, _signal?: AbortSignal): Promise<ToolResult> {
	const state = stateFor(sessionId(ctx));
	await load(state);
	const old = clone(state.phases);
	if (params.op === "view") return result(old, true);

	const next = apply(old, params, state.phases);
	promote(next);
	state.phases = clone(next);
	await save(state);
	return result(next, false);
}

export function registerTodo(pi: PiApi): void {
	registeredTools.add("todo");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		promptSnippet: "Track phased session work by verbatim task content",
		promptGuidelines: [
			"Create a todo list for tasks with 3 or more steps, and mark each task done immediately when its work finishes.",
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("init"),
					Type.Literal("start"),
					Type.Literal("done"),
					Type.Literal("drop"),
					Type.Literal("block"),
					Type.Literal("unblock"),
					Type.Literal("rm"),
					Type.Literal("append"),
					Type.Literal("view"),
				],
				{ description: "operation to apply" },
			),
			list: Type.Optional(
				Type.Array(
					Type.Object({
						phase: Type.String({ description: "phase name" }),
						items: Type.Array(Type.String({ description: "task content" }), { minItems: 1 }),
					}),
					{ description: "phased task list for init" },
				),
			),
			task: Type.Optional(Type.String({ description: "verbatim task content" })),
			phase: Type.Optional(Type.String({ description: "verbatim phase name" })),
			items: Type.Optional(Type.Array(Type.String({ description: "task content" }), { description: "tasks for init or append" })),
			reason: Type.Optional(Type.String({ description: "blocker note for block" })),
		}),
		async execute(_id: string, call: TodoParams, signal?: AbortSignal, _onUpdate?: unknown, callCtx?: ToolCtx) {
			return executeTodo(call, callCtx, signal);
		},
	});
}

function apply(phases: TodoPhase[], params: TodoParams, current: TodoPhase[]): TodoPhase[] {
	switch (params.op) {
		case "init":
			return init(params, current);
		case "start": {
			const hit = getTask(phases, params.task, current);
			if (hit.task.status === "completed") fail(`Task ${JSON.stringify(hit.task.content)} is completed and cannot be restarted`, current);
			for (const phase of phases) {
				for (const task of phase.tasks) {
					if (task.status === "in_progress" && task !== hit.task) task.status = "pending";
				}
			}
			hit.task.status = "in_progress";
			delete hit.task.reason;
			return phases;
		}
		case "done":
			for (const task of targets(phases, params, current)) {
				task.status = "completed";
				delete task.reason;
			}
			return phases;
		case "drop":
			for (const task of targets(phases, params, current)) {
				task.status = "dropped";
				delete task.reason;
			}
			return phases;
		case "block": {
			if (!params.task && !params.phase) fail("block requires a task or phase target", current);
			const reason = params.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of targets(phases, params, current)) {
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				if (reason) task.reason = reason;
				else delete task.reason;
			}
			return phases;
		}
		case "unblock":
			if (!params.task && !params.phase) fail("unblock requires a task or phase target", current);
			for (const task of targets(phases, params, current)) {
				if (task.status !== "blocked") continue;
				task.status = "pending";
				delete task.reason;
			}
			return phases;
		case "rm":
			return remove(phases, params, current);
		case "append":
			return append(phases, params, current);
		case "view":
			return phases;
	}
}

function init(params: TodoParams, current: TodoPhase[]): TodoPhase[] {
	const list = params.list ?? (params.items?.length ? [{ phase: params.phase ?? "Tasks", items: params.items }] : undefined);
	if (!list) fail("Missing list for init operation", current);

	const names = new Set<string>();
	const tasks = new Set<string>();
	for (const entry of list) {
		if (names.has(entry.phase)) fail(`Duplicate phase ${JSON.stringify(entry.phase)} in init list`, current);
		names.add(entry.phase);
		for (const content of entry.items) {
			if (tasks.has(content)) fail(`Duplicate task ${JSON.stringify(content)} in init list`, current);
			tasks.add(content);
		}
	}
	return list.map(entry => ({
		name: entry.phase,
		tasks: entry.items.map(content => ({ content, status: "pending" })),
	}));
}

function append(phases: TodoPhase[], params: TodoParams, current: TodoPhase[]): TodoPhase[] {
	if (!params.phase) fail("Missing phase name for append operation", current);
	if (!params.items?.length) fail("Missing items for append operation", current);

	const items = new Set<string>();
	for (const content of params.items) {
		if (items.has(content) || findTask(phases, content)) fail(`Task ${JSON.stringify(content)} already exists`, current);
		items.add(content);
	}
	let phase = phases.find(item => item.name === params.phase);
	if (!phase) {
		phase = { name: params.phase, tasks: [] };
		phases.push(phase);
	}
	for (const content of params.items) phase.tasks.push({ content, status: "pending" });
	return phases;
}

function remove(phases: TodoPhase[], params: TodoParams, current: TodoPhase[]): TodoPhase[] {
	if (params.task) {
		const hit = getTask(phases, params.task, current);
		hit.phase.tasks = hit.phase.tasks.filter(task => task !== hit.task);
		return phases;
	}
	if (params.phase) {
		getPhase(phases, params.phase, current);
		return phases.filter(phase => phase.name !== params.phase);
	}
	return [];
}

function targets(phases: TodoPhase[], params: TodoParams, current: TodoPhase[]): TodoTask[] {
	if (params.task) return [getTask(phases, params.task, current).task];
	if (params.phase) return [...getPhase(phases, params.phase, current).tasks];
	return phases.flatMap(phase => phase.tasks);
}

function getTask(phases: TodoPhase[], content: string | undefined, current: TodoPhase[]): { task: TodoTask; phase: TodoPhase } {
	if (!content) fail("Missing task content", current);
	const hit = findTask(phases, content);
	if (!hit) fail(`Task ${JSON.stringify(content)} not found`, current);
	return hit;
}

function findTask(phases: TodoPhase[], content: string): { task: TodoTask; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(item => item.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function getPhase(phases: TodoPhase[], name: string | undefined, current: TodoPhase[]): TodoPhase {
	if (!name) fail("Missing phase name", current);
	const phase = phases.find(item => item.name === name);
	if (!phase) fail(`Phase ${JSON.stringify(name)} not found`, current);
	return phase;
}

function promote(phases: TodoPhase[]): void {
	const tasks = phases.flatMap(phase => phase.tasks);
	const active = tasks.filter(task => task.status === "in_progress");
	for (const task of active.slice(1)) task.status = "pending";
	if (active.length > 0) return;
	const next = tasks.find(task => task.status === "pending");
	if (next) next.status = "in_progress";
}

function result(phases: TodoPhase[], readOnly: boolean): ToolResult {
	const snapshot = clone(phases);
	return textResult(render(snapshot, readOnly), { phases: snapshot, counts: count(snapshot) });
}

function render(phases: TodoPhase[], readOnly: boolean): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return readOnly ? "Todo list is empty." : "Todo list cleared.";

	const open = phases.flatMap(phase =>
		phase.tasks
			.filter(task => task.status === "pending" || task.status === "in_progress")
			.map(task => ({ task, phase: phase.name })),
	);
	let active = phases.findIndex(phase => phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"));
	if (active === -1) active = phases.length - 1;
	const phase = phases[active];
	const phaseDone = phase.tasks.filter(task => task.status === "completed" || task.status === "dropped").length;
	const counts = count(phases);
	const lines: string[] = [];
	if (open.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${open.length}):`);
		for (const item of open) lines.push(`  - ${item.task.content} [${item.task.status}] (${item.phase})`);
	}
	lines.push(`Overall: ${counts.completed + counts.dropped}/${counts.total} done, ${counts.open} open${counts.blocked ? `, ${counts.blocked} blocked` : ""}.`);
	lines.push(`Active phase ${active + 1}/${phases.length} ${JSON.stringify(phase.name)} (${phaseDone}/${phase.tasks.length}).`);
	for (const item of phases) {
		lines.push(`  ${item.name}:`);
		for (const task of item.tasks) lines.push(`    - ${taskLine(task)}`);
	}
	return lines.join("\n");
}

function taskLine(task: TodoTask): string {
	const mark = task.status === "completed" ? "[X]" : "[ ]";
	if (task.status === "in_progress") return `${mark} ${task.content} (in progress)`;
	if (task.status === "dropped") return `${mark} ${task.content} (dropped)`;
	if (task.status === "blocked") return `${mark} ${task.content}${task.reason ? ` (blocked: ${task.reason})` : " (blocked)"}`;
	return `${mark} ${task.content}`;
}

function count(phases: TodoPhase[]): TodoCounts {
	const tasks = phases.flatMap(phase => phase.tasks);
	return {
		total: tasks.length,
		completed: tasks.filter(task => task.status === "completed").length,
		dropped: tasks.filter(task => task.status === "dropped").length,
		open: tasks.filter(task => task.status === "pending" || task.status === "in_progress").length,
		blocked: tasks.filter(task => task.status === "blocked").length,
	};
}

function clone(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => (task.reason === undefined ? { content: task.content, status: task.status } : { ...task })),
	}));
}

function fail(message: string, phases: TodoPhase[]): never {
	throw new ToolError(`${message}\n\n${render(phases, true)}`);
}

async function load(state: TodoState): Promise<void> {
	if (state.loaded) return;
	state.loaded = true;
	if (!state.file || state.phases.length > 0) return;
	try {
		const raw: unknown = JSON.parse(await fs.readFile(state.file, "utf8"));
		const phases = readPhases(raw);
		if (phases) state.phases = phases;
	} catch {
		// Persistence must never stop todo work.
	}
}

async function save(state: TodoState): Promise<void> {
	if (!state.file) return;
	try {
		await fs.mkdir(path.dirname(state.file), { recursive: true });
		await fs.writeFile(state.file, JSON.stringify({ phases: state.phases }), "utf8");
	} catch {
		// Persistence must never stop todo work.
	}
}

function readPhases(value: unknown): TodoPhase[] | undefined {
	if (!value || typeof value !== "object" || !("phases" in value) || !Array.isArray(value.phases)) return undefined;
	if (!value.phases.every(isPhase)) return undefined;
	return clone(value.phases);
}

function isPhase(value: unknown): value is TodoPhase {
	if (!value || typeof value !== "object") return false;
	if (!("name" in value) || typeof value.name !== "string") return false;
	if (!("tasks" in value) || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(isTask);
}

function isTask(value: unknown): value is TodoTask {
	if (!value || typeof value !== "object") return false;
	if (!("content" in value) || typeof value.content !== "string") return false;
	if (!("status" in value) || !isStatus(value.status)) return false;
	return !("reason" in value) || value.reason === undefined || typeof value.reason === "string";
}

function isStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "dropped" || value === "blocked";
}
