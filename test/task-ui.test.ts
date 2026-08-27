import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTaskActivityView,
	isTaskMouseSequence,
	parseTaskMouseEvent,
	type TaskTuiDeps,
} from "../packages/lazy-prime-core/src/tools/task-ui.ts";
import {
	beginTaskActivity,
	clearTaskActivity,
	taskActivitySource,
	type TaskActivitySource,
	type TaskBatchActivity,
	type TaskWorkerActivity,
} from "../packages/lazy-prime-core/src/tools/task-activity.ts";
import { sanitizeTaskText } from "../packages/lazy-prime-core/src/task-view.ts";

function worker(id: string, name: string): TaskWorkerActivity {
	return {
		id,
		index: Number(id.slice(-1)),
		name,
		agent: "task",
		status: "running",
		turns: 4,
		tools: 7,
		isolated: false,
		activity: Array.from({ length: 20 }, (_, index) => ({
			id: `${id}:activity:${index}`,
			kind: "assistant" as const,
			at: Date.UTC(2026, 0, 1, 12, 0, index),
			text: `${name} activity line ${index + 1}`,
			status: "completed" as const,
		})),
	};
}

function deps(): TaskTuiDeps {
	const Key = {
		escape: "escape",
		enter: "enter",
		tab: "tab",
		up: "up",
		down: "down",
		left: "left",
		right: "right",
		pageUp: "pageUp",
		pageDown: "pageDown",
		home: "home",
		end: "end",
	};
	const sequences: Record<string, string> = {
		escape: "\x1b",
		enter: "\r",
		tab: "\t",
		up: "\x1b[A",
		down: "\x1b[B",
		left: "\x1b[D",
		right: "\x1b[C",
		pageUp: "\x1b[5~",
		pageDown: "\x1b[6~",
		home: "\x1b[H",
		end: "\x1b[F",
	};
	return {
		Key,
		matchesKey: (data, key) => data === sequences[String(key)],
		isMouseSequence: isTaskMouseSequence,
		parseMouseEvent: parseTaskMouseEvent,
		isWheelUp: event => event.press && event.button === 64,
		isWheelDown: event => event.press && event.button === 65,
		visibleWidth: text => text.length,
		truncateToWidth: (text, width, ellipsis = "…") => `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`,
	};
}

test("task view: mouse selects and focuses cards while wheel scroll stays local", () => {
	const initialBatches: TaskBatchActivity[] = [{
		id: "batch-1",
		sessionKey: "session-1",
		startedAt: 1,
		updatedAt: 1,
		workers: [worker("worker-0", "FirstWorker"), worker("worker-1", "SecondWorker")],
	}];
	const source: TaskActivitySource = {
		snapshot: () => initialBatches,
		subscribe: () => () => {},
	};
	let renders = 0;
	let closed = 0;
	const view = createTaskActivityView({
		tui: {
			terminal: { rows: 24, columns: 80, mouseTrackingActive: true, setMouseTracking: () => {} },
			requestRender: () => {
				renders++;
			},
		},
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		deps: deps(),
		source,
		sessionKey: "session-1",
		initialBatches,
		done: () => {
			closed++;
		},
	});

	let lines = view.render(80);
	const secondCardRow = lines.findIndex(line => line.includes("SecondWorker"));
	assert.ok(secondCardRow > 0);
	assert.equal(view.handleTerminalInput(`\x1b[<0;2;${secondCardRow + 1}M`), true);
	lines = view.render(80);
	assert.ok(lines.some(line => line.includes("› ● SecondWorker")), "first click selects the hovered worker");

	assert.equal(view.handleTerminalInput(`\x1b[<0;2;${secondCardRow + 1}M`), true);
	lines = view.render(80);
	assert.match(lines[0] ?? "", /Task agents \/ SecondWorker/);

	assert.equal(view.handleTerminalInput("\x1b[<64;2;5M"), true, "wheel input is consumed by the view");
	lines = view.render(80);
	assert.ok(lines.some(line => line.includes("1–18/20")), "wheel up shows older lines inside the focused stream");
	assert.equal(view.handleTerminalInput("\x1b[<65;2;5M"), true);
	lines = view.render(80);
	assert.ok(lines.some(line => line.includes("3–20/20")), "wheel down returns to the live tail");
	assert.equal(view.handleTerminalInput("x"), false, "non-mouse input remains available to the focused component");

	view.handleInput("\x1b");
	assert.match(view.render(80)[0] ?? "", /Task agents 2 workers/);
	view.handleInput("\x1b");
	assert.equal(closed, 1);
	assert.ok(renders >= 5);
	view.dispose();
});

test("task view: every worker border uses the full available width", () => {
	const initialBatches: TaskBatchActivity[] = [{
		id: "batch-1",
		sessionKey: "session-1",
		startedAt: 1,
		updatedAt: 1,
		workers: [worker("worker-0", "FirstWorker"), worker("worker-1", "SecondWorker")],
	}];
	const view = createTaskActivityView({
		tui: {
			terminal: { rows: 24, columns: 80, mouseTrackingActive: true, setMouseTracking: () => {} },
			requestRender: () => {},
		},
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		deps: deps(),
		source: { snapshot: () => initialBatches, subscribe: () => () => {} },
		sessionKey: "session-1",
		initialBatches,
		done: () => {},
	});
	const borders = view.render(80).filter(line => line.startsWith("╭") || line.startsWith("╰"));
	assert.equal(borders.length, 4);
	for (const border of borders) assert.equal(border.length, 80);
	view.dispose();
});

test("task view: compact mode keeps six workers visible in a short terminal", () => {
	const initialBatches: TaskBatchActivity[] = [{
		id: "batch-compact",
		sessionKey: "session-compact",
		startedAt: 1,
		updatedAt: 1,
		workers: Array.from({ length: 6 }, (_, index) => worker(`worker-${index}`, `Worker${index + 1}`)),
	}];
	const view = createTaskActivityView({
		tui: {
			terminal: { rows: 24, columns: 80, mouseTrackingActive: true, setMouseTracking: () => {} },
			requestRender: () => {},
		},
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		deps: deps(),
		source: { snapshot: () => initialBatches, subscribe: () => () => {} },
		sessionKey: "session-compact",
		initialBatches,
		done: () => {},
	});
	const lines = view.render(80);
	for (let index = 1; index <= 6; index++) assert.ok(lines.some(line => line.includes(`Worker${index}`)));
	assert.ok(lines.length <= 24);
	view.dispose();
});

test("task activity: an old controller cannot delete a replacement session map", () => {
	const sessionKey = "task-activity-replacement";
	clearTaskActivity(sessionKey);
	const oldController = beginTaskActivity({
		id: "old",
		sessionKey,
		startedAt: 1,
		updatedAt: 1,
		workers: [worker("old-0", "OldWorker")],
	});
	clearTaskActivity(sessionKey);
	const newController = beginTaskActivity({
		id: "new",
		sessionKey,
		startedAt: 2,
		updatedAt: 2,
		workers: [worker("new-0", "NewWorker")],
	});
	oldController.finish();
	assert.equal(taskActivitySource.snapshot(sessionKey)[0]?.id, "new");
	newController.finish();
});

test("task view: streamed text strips CSI and OSC terminal controls", () => {
	const unsafe = "before\x1b[2Jafter\x1b]0;owned\x07done\x1bPpayload\x1b\\safe";
	const clean = sanitizeTaskText(unsafe);
	assert.equal(clean, "beforeafterdonesafe");
	assert.equal(clean.includes("\x1b"), false);
});

test("task mouse parser: legacy X10 wheel reports decode", () => {
	const wheelUp = `\x1b[M${String.fromCharCode(32 + 64, 32 + 10, 32 + 5)}`;
	assert.deepEqual(parseTaskMouseEvent(wheelUp), {
		button: 64,
		x: 10,
		y: 5,
		press: true,
		motion: false,
		shift: false,
		alt: false,
		ctrl: false,
	});
});
