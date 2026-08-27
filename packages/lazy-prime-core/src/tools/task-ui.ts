import { sessionId, type ToolCtx } from "../host.ts";
import { renderTaskWorkerCard, type TaskCardRender, type TaskViewStyle } from "../task-view.ts";
import { taskActivitySource, type TaskActivitySource, type TaskBatchActivity, type TaskWorkerActivity } from "./task-activity.ts";

// biome-ignore lint/suspicious/noExplicitAny: host TUI modules are optional and structurally typed
type Any = any;

export interface TaskMouseEvent {
	button: number;
	x: number;
	y: number;
	press: boolean;
	motion: boolean;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export interface TaskTuiDeps {
	Key: Record<string, Any>;
	matchesKey(data: string, key: Any): boolean;
	isMouseSequence(data: string): boolean;
	parseMouseEvent(data: string): TaskMouseEvent | null;
	isWheelUp(event: TaskMouseEvent): boolean;
	isWheelDown(event: TaskMouseEvent): boolean;
	visibleWidth?: (text: string) => number;
	truncateToWidth?: (text: string, width: number, ellipsis?: string) => string;
}

export interface TaskTerminal {
	rows: number;
	columns: number;
	mouseTrackingActive?: boolean;
	setMouseTracking?(enabled: boolean): void;
	write?(data: string): void;
}

export interface TaskTui {
	terminal: TaskTerminal;
	mode?: "regular" | "fullscreen";
	requestRender(): void;
}

interface TaskCustomUi {
	custom<T>(
		factory: (tui: TaskTui, theme: Any, keybindings: Any, done: (value: T) => void) => TaskActivityView,
		options?: {
			overlay?: boolean;
			overlayOptions?: Record<string, unknown>;
			onHandle?: (handle: unknown) => void;
		},
	): Promise<T | undefined>;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

interface TaskCardRange {
	workerId: string;
	startRow: number;
	endRow: number;
}

interface TaskCardMetric {
	total: number;
	maxScrollOffset: number;
}

export interface TaskActivityView {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	handleTerminalInput(data: string): boolean;
	dispose(): void;
}

export interface TaskActivityViewOptions {
	tui: TaskTui;
	theme: Any;
	deps: TaskTuiDeps;
	source: TaskActivitySource;
	sessionKey: string;
	initialBatches: TaskBatchActivity[];
	done(): void;
}

export function isTaskMouseSequence(data: string): boolean {
	return data.startsWith("\x1b[<") || data.startsWith("\x1b[M");
}

const SGR_MOUSE_RE = new RegExp(String.raw`^\u001b\[<(\d+);(\d+);(\d+)([Mm])$`);

function mouseEvent(raw: number, x: number, y: number, press: boolean): TaskMouseEvent {
	return {
		button: raw & ~(4 | 8 | 16 | 32),
		x,
		y,
		press,
		motion: (raw & 32) !== 0,
		shift: (raw & 4) !== 0,
		alt: (raw & 8) !== 0,
		ctrl: (raw & 16) !== 0,
	};
}

export function parseTaskMouseEvent(data: string): TaskMouseEvent | null {
	const match = SGR_MOUSE_RE.exec(data);
	if (match) return mouseEvent(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "M");
	if (!data.startsWith("\x1b[M") || data.length < 6) return null;
	const raw = data.charCodeAt(3) - 32;
	const x = data.charCodeAt(4) - 32;
	const y = data.charCodeAt(5) - 32;
	if (raw < 0 || x < 1 || y < 1) return null;
	return mouseEvent(raw, x, y, (raw & 3) !== 3 || (raw & 64) !== 0);
}

let taskTuiDepsPromise: Promise<TaskTuiDeps | null> | undefined;
function loadTaskTuiDeps(): Promise<TaskTuiDeps | null> {
	taskTuiDepsPromise ??= (async () => {
		try {
			// @ts-ignore -- host-only module, resolved at runtime
			const tui = (await import("@earendil-works/pi-tui")) as Any;
			if (!tui?.Key || typeof tui.matchesKey !== "function") return null;
			return {
				Key: tui.Key,
				matchesKey: tui.matchesKey,
				isMouseSequence: typeof tui.isMouseSequence === "function" ? tui.isMouseSequence : isTaskMouseSequence,
				parseMouseEvent: data => tui.parseSgrMouseEvent?.(data) ?? parseTaskMouseEvent(data),
				isWheelUp: typeof tui.isWheelUp === "function" ? tui.isWheelUp : event => event.press && event.button === 64,
				isWheelDown: typeof tui.isWheelDown === "function" ? tui.isWheelDown : event => event.press && event.button === 65,
				visibleWidth: tui.visibleWidth,
				truncateToWidth: tui.truncateToWidth,
			};
		} catch {
			return null;
		}
	})();
	return taskTuiDepsPromise;
}

const ACTIVE_TASK_VIEWS_KEY = Symbol.for("omp-tools.active-task-views.v1");
const taskUiGlobals = globalThis as Record<PropertyKey, unknown>;
taskUiGlobals[ACTIVE_TASK_VIEWS_KEY] ??= new Map<string, Set<() => void>>();
const activeTaskViews = taskUiGlobals[ACTIVE_TASK_VIEWS_KEY] as Map<string, Set<() => void>>;

function registerActiveTaskView(sessionKey: string, close: () => void): () => void {
	const views = activeTaskViews.get(sessionKey) ?? new Set<() => void>();
	views.add(close);
	activeTaskViews.set(sessionKey, views);
	return () => {
		views.delete(close);
		if (views.size === 0) activeTaskViews.delete(sessionKey);
	};
}

export function closeTaskAgentViews(sessionKey: string): void {
	for (const close of activeTaskViews.get(sessionKey)?.values() ?? []) close();
}

function uiOf(ctx: ToolCtx): TaskCustomUi | undefined {
	if (ctx.hasUI === false || !ctx.ui || typeof ctx.ui !== "object") return undefined;
	const candidate = ctx.ui as Partial<TaskCustomUi>;
	if (typeof candidate.custom !== "function" || typeof candidate.onTerminalInput !== "function") return undefined;
	return candidate as TaskCustomUi;
}

function flattenWorkers(batches: readonly TaskBatchActivity[]): TaskWorkerActivity[] {
	return batches.flatMap(batch => batch.workers);
}

const ANSI_STYLE_RE = new RegExp(String.raw`\u001b\[[0-9;:]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_STYLE_RE, "");
}

export function createTaskActivityView(options: TaskActivityViewOptions): TaskActivityView {
	let batches = options.initialBatches;
	let active = true;
	let focused = false;
	let disposed = false;
	let cardRanges: TaskCardRange[] = [];
	let selectedId = flattenWorkers(batches)[0]?.id;
	const scrollOffsets = new Map<string, number>();
	const cardMetrics = new Map<string, TaskCardMetric>();

	const style: TaskViewStyle = {
		fg(color, text) {
			try {
				return options.theme.fg(color, text);
			} catch {
				return text;
			}
		},
		bold(text) {
			try {
				return options.theme.bold(text);
			} catch {
				return text;
			}
		},
		visibleWidth(text) {
			try {
				return options.deps.visibleWidth?.(text) ?? stripAnsi(text).length;
			} catch {
				return stripAnsi(text).length;
			}
		},
		fit(text, width) {
			if (width <= 0) return "";
			if (style.visibleWidth(text) <= width) return text;
			try {
				if (options.deps.truncateToWidth) return options.deps.truncateToWidth(text, width, "…");
			} catch {
				/* fall through */
			}
			const plain = stripAnsi(text);
			return plain.length <= width ? plain : `${plain.slice(0, Math.max(0, width - 1))}…`;
		},
	};

	const workers = (): TaskWorkerActivity[] => flattenWorkers(batches);
	const selectedWorker = (): TaskWorkerActivity | undefined => {
		const all = workers();
		return all.find(worker => worker.id === selectedId) ?? all[0];
	};
	const refresh = (): void => options.tui.requestRender();
	const ensureSelection = (): void => {
		const all = workers();
		if (!all.some(worker => worker.id === selectedId)) selectedId = all[0]?.id;
	};
	const moveSelection = (delta: number): void => {
		const all = workers();
		if (all.length === 0) return;
		const current = Math.max(0, all.findIndex(worker => worker.id === selectedId));
		selectedId = all[(current + delta + all.length) % all.length]!.id;
		scrollOffsets.set(selectedId, 0);
		refresh();
	};
	const scrollWorker = (workerId: string, delta: number): void => {
		const metric = cardMetrics.get(workerId);
		if (!metric) return;
		const next = Math.max(0, Math.min(metric.maxScrollOffset, (scrollOffsets.get(workerId) ?? 0) + delta));
		scrollOffsets.set(workerId, next);
		refresh();
	};
	const renderCard = (worker: TaskWorkerActivity, width: number, bodyLines: number, isFocused: boolean): TaskCardRender => {
		let offset = scrollOffsets.get(worker.id) ?? 0;
		let rendered = renderTaskWorkerCard(style, worker, width, {
			bodyLines,
			scrollOffset: offset,
			selected: !isFocused && worker.id === selectedId,
			focused: isFocused,
		});
		const previous = cardMetrics.get(worker.id);
		if (offset > 0 && previous && rendered.totalActivityLines > previous.total) {
			offset += rendered.totalActivityLines - previous.total;
			scrollOffsets.set(worker.id, offset);
			rendered = renderTaskWorkerCard(style, worker, width, {
				bodyLines,
				scrollOffset: offset,
				selected: !isFocused && worker.id === selectedId,
				focused: isFocused,
			});
		}
		cardMetrics.set(worker.id, { total: rendered.totalActivityLines, maxScrollOffset: rendered.maxScrollOffset });
		return rendered;
	};

	const unsubscribe = options.source.subscribe(options.sessionKey, () => {
		const next = options.source.snapshot(options.sessionKey);
		if (next.length > 0) {
			batches = next;
			active = true;
		} else {
			active = false;
		}
		ensureSelection();
		refresh();
	});

	function render(width: number): string[] {
		ensureSelection();
		const all = workers();
		const w = Math.max(40, width);
		const rows = Math.max(12, options.tui.terminal.rows || 40);
		cardRanges = [];
		if (focused) {
			const worker = selectedWorker();
			if (!worker) return [style.fg("muted", "No task agents are running.")];
			const bodyLines = Math.max(3, rows - 6);
			const lines = [
				`${style.fg("dim", "Task agents /")} ${style.bold(worker.name)} ${style.fg("accent", `(${Math.max(1, all.indexOf(worker) + 1)}/${all.length})`)}`,
				`${style.fg("accent", "Esc")} ${style.fg("muted", "All workers")}  ${style.fg("accent", "←/→")} ${style.fg("muted", "Switch")}  ${style.fg("accent", "Wheel · ↑/↓ · PgUp/PgDn")} ${style.fg("muted", "Scroll")}  ${style.fg("accent", "q")} ${style.fg("muted", "Close")}`,
				"",
			];
			const startRow = lines.length;
			const card = renderCard(worker, w, bodyLines, true);
			lines.push(...card.lines);
			cardRanges.push({ workerId: worker.id, startRow, endRow: lines.length });
			return lines;
		}

		const completed = all.filter(worker => worker.status === "completed").length;
		const running = all.filter(worker => worker.status === "running" || worker.status === "starting").length;
		const queued = all.filter(worker => worker.status === "queued").length;
		const meta = [
			`${all.length} worker${all.length === 1 ? "" : "s"}`,
			`${running} running`,
			`${completed} completed`,
			...(queued > 0 ? [`${queued} queued`] : []),
			...(!active ? ["finished"] : []),
		].join(" · ");
		const lines = [
			`${style.fg("accent", active ? "⟳" : "✔")} ${style.bold("Task agents")} ${style.fg("muted", meta)}`,
			`${style.fg("accent", "Click")} ${style.fg("muted", "Select; click again to focus")}  ${style.fg("accent", "Wheel")} ${style.fg("muted", "Scroll card")}  ${style.fg("accent", "↑/↓ · Enter")} ${style.fg("muted", "Keyboard")}  ${style.fg("accent", "Esc/q")} ${style.fg("muted", "Close")}`,
			"",
		];
		const availableRows = Math.max(0, rows - lines.length);
		const ultraCompact = availableRows < all.length * 2;
		const showGaps = !ultraCompact && availableRows >= all.length * 2 + Math.max(0, all.length - 1);
		const gapRows = showGaps ? Math.max(0, all.length - 1) : 0;
		const bodyLines = ultraCompact
			? 0
			: Math.max(0, Math.min(8, Math.floor((availableRows - gapRows) / Math.max(1, all.length)) - 2));
		for (const [index, worker] of all.entries()) {
			const startRow = lines.length;
			const card = renderCard(worker, w, bodyLines, false);
			lines.push(...(ultraCompact ? card.lines.slice(0, 1) : card.lines));
			cardRanges.push({ workerId: worker.id, startRow, endRow: lines.length });
			if (showGaps && index < all.length - 1) lines.push("");
		}
		return lines;
	}

	function handleInput(data: string): void {
		const { Key, matchesKey } = options.deps;
		if (data === "q") {
			options.done();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (focused) {
				focused = false;
				refresh();
			} else {
				options.done();
			}
			return;
		}
		if (data >= "1" && data <= "9" && !focused) {
			const worker = workers()[Number(data) - 1];
			if (worker) selectedId = worker.id;
			refresh();
			return;
		}
		if (focused) {
			if (matchesKey(data, Key.left)) moveSelection(-1);
			else if (matchesKey(data, Key.right)) moveSelection(1);
			else if (matchesKey(data, Key.up)) scrollWorker(selectedId ?? "", 1);
			else if (matchesKey(data, Key.down)) scrollWorker(selectedId ?? "", -1);
			else if (matchesKey(data, Key.pageUp)) scrollWorker(selectedId ?? "", 8);
			else if (matchesKey(data, Key.pageDown)) scrollWorker(selectedId ?? "", -8);
			else if (matchesKey(data, Key.home)) scrollWorker(selectedId ?? "", Number.MAX_SAFE_INTEGER);
			else if (matchesKey(data, Key.end)) {
				scrollOffsets.set(selectedId ?? "", 0);
				refresh();
			}
			return;
		}
		if (matchesKey(data, Key.up)) moveSelection(-1);
		else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) moveSelection(1);
		else if (matchesKey(data, Key.pageUp)) scrollWorker(selectedId ?? "", 8);
		else if (matchesKey(data, Key.pageDown)) scrollWorker(selectedId ?? "", -8);
		else if (matchesKey(data, Key.enter) && selectedId) {
			focused = true;
			refresh();
		}
	}

	function handleTerminalInput(data: string): boolean {
		if (!options.deps.isMouseSequence(data)) return false;
		const event = options.deps.parseMouseEvent(data);
		if (!event) return true;
		const localRow = event.y - 1;
		const range = cardRanges.find(candidate => localRow >= candidate.startRow && localRow < candidate.endRow);
		if (options.deps.isWheelUp(event) || options.deps.isWheelDown(event)) {
			const workerId = focused ? selectedId : range?.workerId;
			if (workerId) {
				selectedId = workerId;
				scrollWorker(workerId, options.deps.isWheelUp(event) ? 3 : -3);
			}
			return true;
		}
		if (!event.press || event.motion || event.button !== 0 || event.shift || event.alt || event.ctrl || focused || !range) return true;
		if (selectedId === range.workerId) focused = true;
		else selectedId = range.workerId;
		refresh();
		return true;
	}

	return {
		render,
		invalidate(): void {},
		handleInput,
		handleTerminalInput,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
		},
	};
}

export async function openTaskAgents(ctx: ToolCtx): Promise<boolean> {
	const ui = uiOf(ctx);
	if (!ui) return false;
	const deps = await loadTaskTuiDeps();
	if (!deps) return false;
	const sessionKey = sessionId(ctx) ?? "";
	const initialBatches = taskActivitySource.snapshot(sessionKey);
	if (initialBatches.length === 0) {
		ui.notify?.("No task agents are running.", "info");
		return false;
	}
	closeTaskAgentViews(sessionKey);
	let activeTui: TaskTui | undefined;
	let mouseTrackingOwner: "managed" | "raw" | undefined;
	let unregisterActiveView = () => {};
	const result = await ui.custom<boolean>(
		(tui, theme, _keybindings, done) => {
			activeTui = tui;
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				done(true);
			};
			const view = createTaskActivityView({
				tui,
				theme,
				deps,
				source: taskActivitySource,
				sessionKey,
				initialBatches,
				done: close,
			});
			unregisterActiveView = registerActiveTaskView(sessionKey, close);
			const unsubscribeMouse = ui.onTerminalInput(data => (view.handleTerminalInput(data) ? { consume: true } : undefined));
			const disposeView = view.dispose.bind(view);
			view.dispose = () => {
				unregisterActiveView();
				unsubscribeMouse();
				if (mouseTrackingOwner === "managed") tui.terminal.setMouseTracking?.(false);
				else if (mouseTrackingOwner === "raw") tui.terminal.write?.("\x1b[?1006l\x1b[?1002l");
				disposeView();
			};
			return view;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0, scrollback: false },
			onHandle: () => {
				if (!activeTui) return;
				const terminal = activeTui.terminal;
				if (typeof terminal.setMouseTracking === "function" && terminal.mouseTrackingActive !== true) {
					terminal.setMouseTracking(true);
					mouseTrackingOwner = "managed";
				} else if (terminal.mouseTrackingActive !== true && activeTui.mode !== "fullscreen" && typeof terminal.write === "function") {
					terminal.write("\x1b[?1002h\x1b[?1006h");
					mouseTrackingOwner = "raw";
				}
			},
		},
	);
	return result === true;
}
