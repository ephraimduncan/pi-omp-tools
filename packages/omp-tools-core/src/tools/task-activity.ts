export type TaskWorkerStatus = "queued" | "starting" | "running" | "completed" | "failed" | "aborted";

export interface TaskAssistantActivity {
	id: string;
	kind: "assistant";
	at: number;
	text: string;
	status: "streaming" | "completed";
}

export interface TaskToolActivity {
	id: string;
	kind: "tool";
	at: number;
	toolCallId: string;
	toolName: string;
	status: "running" | "completed" | "failed" | "interrupted";
	summary?: string;
	output?: string;
}

export type TaskActivityEntry = TaskAssistantActivity | TaskToolActivity;

export interface TaskWorkerActivity {
	id: string;
	index: number;
	name: string;
	agent: string;
	status: TaskWorkerStatus;
	turns: number;
	tools: number;
	isolated: boolean;
	startedAt?: number;
	endedAt?: number;
	activity: TaskActivityEntry[];
}

export interface TaskBatchActivity {
	id: string;
	sessionKey: string;
	startedAt: number;
	updatedAt: number;
	workers: TaskWorkerActivity[];
}

export interface TaskActivitySource {
	snapshot(sessionKey: string): TaskBatchActivity[];
	subscribe(sessionKey: string, listener: () => void): () => void;
}

export interface TaskActivityController {
	update(workers: readonly TaskWorkerActivity[]): void;
	finish(): void;
}

interface TaskActivityStore {
	batches: Map<string, Map<string, TaskBatchActivity>>;
	listeners: Map<string, Set<() => void>>;
	scheduled: Set<string>;
}

const TASK_ACTIVITY_KEY = Symbol.for("omp-tools.task-activity.v1");
const globalStore = globalThis as Record<PropertyKey, unknown>;
globalStore[TASK_ACTIVITY_KEY] ??= {
	batches: new Map(),
	listeners: new Map(),
	scheduled: new Set(),
} satisfies TaskActivityStore;
const store = globalStore[TASK_ACTIVITY_KEY] as TaskActivityStore;

function cloneEntry(entry: TaskActivityEntry): TaskActivityEntry {
	return { ...entry };
}

function cloneWorker(worker: TaskWorkerActivity): TaskWorkerActivity {
	return { ...worker, activity: worker.activity.map(cloneEntry) };
}

function cloneBatch(batch: TaskBatchActivity): TaskBatchActivity {
	return { ...batch, workers: batch.workers.map(cloneWorker) };
}

function notifyListeners(sessionKey: string): void {
	for (const listener of store.listeners.get(sessionKey) ?? []) listener();
}

function scheduleNotification(sessionKey: string): void {
	if (store.scheduled.has(sessionKey)) return;
	store.scheduled.add(sessionKey);
	queueMicrotask(() => {
		store.scheduled.delete(sessionKey);
		notifyListeners(sessionKey);
	});
}

export const taskActivitySource: TaskActivitySource = {
	snapshot(sessionKey) {
		return [...(store.batches.get(sessionKey)?.values() ?? [])]
			.sort((left, right) => left.startedAt - right.startedAt)
			.map(cloneBatch);
	},
	subscribe(sessionKey, listener) {
		const listeners = store.listeners.get(sessionKey) ?? new Set<() => void>();
		listeners.add(listener);
		store.listeners.set(sessionKey, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) store.listeners.delete(sessionKey);
		};
	},
};

export function beginTaskActivity(batch: TaskBatchActivity): TaskActivityController {
	const sessionBatches = store.batches.get(batch.sessionKey) ?? new Map<string, TaskBatchActivity>();
	sessionBatches.set(batch.id, cloneBatch(batch));
	store.batches.set(batch.sessionKey, sessionBatches);
	scheduleNotification(batch.sessionKey);
	let finished = false;
	return {
		update(workers) {
			if (finished) return;
			const current = sessionBatches.get(batch.id);
			if (!current) return;
			current.updatedAt = Date.now();
			current.workers = workers.map(cloneWorker);
			scheduleNotification(batch.sessionKey);
		},
		finish() {
			if (finished) return;
			finished = true;
			// Deliver the final worker statuses before removing the active batch.
			notifyListeners(batch.sessionKey);
			sessionBatches.delete(batch.id);
			if (sessionBatches.size === 0 && store.batches.get(batch.sessionKey) === sessionBatches) {
				store.batches.delete(batch.sessionKey);
			}
			scheduleNotification(batch.sessionKey);
		},
	};
}

export function clearTaskActivity(sessionKey: string): void {
	if (!store.batches.delete(sessionKey)) return;
	scheduleNotification(sessionKey);
}
