/**
 * Contract tests for the prime-omp in-process heartbeat emulation, run with
 * `node --test`. They exercise a real InProcessAgentConnection (from the
 * locally installed prime-agent) against a fake session, covering the
 * /heartbeat connection surface, the rlm-heartbeat controller, persistence in
 * the session artifact dir, and delivery of a due job via promptHeartbeat.
 * Skipped when prime-agent is not installed.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function findPrimeRoot(): string | undefined {
	if (process.env.PRIME_AGENT_ROOT) return process.env.PRIME_AGENT_ROOT;
	try {
		const probe = process.platform === "win32" ? "where" : "which";
		const binPath = execFileSync(probe, ["prime-agent"], { encoding: "utf8" }).trim().split("\n")[0];
		if (!binPath) return undefined;
		let dir = path.dirname(realpathSync(binPath));
		for (let i = 0; i < 6; i++) {
			if (path.basename(dir) === "prime-agent" && path.basename(path.dirname(dir)) === "node_modules") return dir;
			dir = path.dirname(dir);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

const primeRoot = findPrimeRoot();

type FakeSession = {
	sessionFile: string | undefined;
	sessionId: string;
	sessionManager: { getCwd: () => string };
	rlmController: any;
	heartbeatPrompts: Array<{ job: any; options: any }>;
	removedFollowUpKeys: string[];
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	hasPendingSessionWork: boolean;
	unfinishedActionCount: number;
	subscribe: () => () => void;
	setRlmHeartbeatController: (controller: any) => void;
	promptHeartbeat: (job: any, options: any) => Promise<void>;
	removeQueuedFollowUp: (key: string) => void;
	followUp: (prompt: string) => Promise<void>;
};

function makeFakeSession(dir: string, options: { sessionFile?: string | undefined } = {}): FakeSession {
	const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
	const session: FakeSession = {
		sessionFile: "sessionFile" in options ? options.sessionFile : path.join(dir, "sessions", `${sessionId}.jsonl`),
		sessionId,
		sessionManager: { getCwd: () => dir },
		rlmController: undefined,
		heartbeatPrompts: [],
		removedFollowUpKeys: [],
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		hasPendingSessionWork: false,
		unfinishedActionCount: 0,
		subscribe: () => () => {},
		setRlmHeartbeatController(controller: any) {
			session.rlmController = controller;
		},
		promptHeartbeat: async (job: any, opts: any) => {
			session.heartbeatPrompts.push({ job, options: opts });
		},
		removeQueuedFollowUp: (key: string) => {
			session.removedFollowUpKeys.push(key);
		},
		followUp: async () => {},
	};
	return session;
}

function makeRuntimeHost(session: FakeSession) {
	return {
		session,
		setRebindSession(callback: unknown) {
			(this as any).rebind = callback;
		},
		dispose: async () => {},
	};
}

async function setup() {
	assert.ok(primeRoot);
	const { installInProcessHeartbeats } = await import(
		pathToFileURL(path.join(import.meta.dirname, "..", "bin", "prime-omp-heartbeats.mjs")).href
	);
	await installInProcessHeartbeats(primeRoot);
	const { InProcessAgentConnection } = await import(
		pathToFileURL(path.join(primeRoot, "dist", "modes", "agent-connection", "in-process-agent-connection.js")).href
	);
	const { getSessionArtifactPathForFile } = await import(
		pathToFileURL(path.join(primeRoot, "dist", "core", "session-manager.js")).href
	);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-omp-heartbeats-"));
	return { InProcessAgentConnection, getSessionArtifactPathForFile, dir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	await waitForAsync(async () => predicate(), timeoutMs);
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, "timed out waiting for condition");
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

test("heartbeats: /heartbeat surface works in-process", { skip: !primeRoot }, async () => {
	const { InProcessAgentConnection, getSessionArtifactPathForFile, dir } = await setup();
	const session = makeFakeSession(dir);
	const connection = new InProcessAgentConnection(makeRuntimeHost(session)) as any;
	try {
		const events: any[] = [];
		connection.subscribe((event: any) => {
			events.push(event);
		});

		assert.equal(await connection.getHeartbeat(), undefined);
		const job = await connection.setHeartbeat("every 10s", "scan the logs", "steer");
		assert.equal(job.source, "heartbeat");
		assert.equal(job.status, "active");
		assert.equal(job.deliveryMode, "steer");
		assert.equal(job.prompt, "scan the logs");
		assert.equal(job.schedule.kind, "interval");
		assert.equal(job.schedule.intervalMs, 10_000);
		assert.equal(job.sessionId, session.sessionId);
		assert.ok(job.nextRunAt);

		const current = await connection.getHeartbeat();
		assert.equal(current?.id, job.id);
		const listed = await connection.listHeartbeats();
		assert.deepEqual(listed.map((entry: any) => entry.job.id), [job.id]);
		assert.ok(events.some(event => event.type === "heartbeats_changed"));

		const artifactFile = path.join(
			getSessionArtifactPathForFile(path.resolve(session.sessionFile!), session.sessionId),
			"scheduled-jobs.json",
		);
		assert.ok(existsSync(artifactFile));

		const paused = await connection.updateHeartbeat("pause");
		assert.equal(paused?.status, "paused");
		assert.deepEqual(session.removedFollowUpKeys, [`heartbeat:${job.id}`]);
		const resumed = await connection.updateHeartbeat("resume");
		assert.equal(resumed?.status, "active");
		const managed = await connection.manageHeartbeat(job.activeSessionId, job.id, "pause");
		assert.equal(managed.status, "paused");
		const cleared = await connection.updateHeartbeat("clear");
		assert.equal(cleared?.status, "cancelled");
		assert.equal(await connection.getHeartbeat(), undefined);
		assert.deepEqual(await connection.listHeartbeats(), []);
	} finally {
		await connection.dispose();
	}
});

test("heartbeats: rlm-heartbeat controller is attached and scoped", { skip: !primeRoot }, async () => {
	const { InProcessAgentConnection, dir } = await setup();
	const session = makeFakeSession(dir);
	const connection = new InProcessAgentConnection(makeRuntimeHost(session)) as any;
	try {
		const controller = session.rlmController;
		assert.ok(controller, "expected setRlmHeartbeatController to be called at bind");

		const job = controller.createRlmHeartbeat({
			instruction: "check test progress",
			interval: "30s",
			label: "tests",
			deliveryMode: "follow_up",
		});
		assert.equal(job.source, "rlm_heartbeat");
		assert.equal(job.label, "tests");
		assert.equal(job.deliveryMode, "follow_up");
		assert.equal(job.schedule.intervalMs, 30_000);
		assert.deepEqual(controller.listRlmHeartbeats({}).map((entry: any) => entry.id), [job.id]);

		const pausedJob = controller.updateRlmHeartbeat({ id: job.id, status: "pause" });
		assert.equal(pausedJob?.status, "paused");
		assert.deepEqual(session.removedFollowUpKeys, [`heartbeat:${job.id}`]);
		const deleted = controller.deleteRlmHeartbeat(job.id);
		assert.equal(deleted?.status, "cancelled");
		assert.deepEqual(controller.listRlmHeartbeats({}), []);

		// RLM heartbeats appear in the shared catalog too (heartbeat manager UI).
		const again = controller.createRlmHeartbeat({ instruction: "watch build" });
		const listed = await connection.listHeartbeats();
		assert.deepEqual(listed.map((entry: any) => entry.job.id), [again.id]);
	} finally {
		await connection.dispose();
	}
});

test("heartbeats: persisted due job is revived and delivered via promptHeartbeat", { skip: !primeRoot }, async () => {
	const { InProcessAgentConnection, getSessionArtifactPathForFile, dir } = await setup();
	const session = makeFakeSession(dir);
	const artifactDir = getSessionArtifactPathForFile(path.resolve(session.sessionFile!), session.sessionId);
	await fs.mkdir(artifactDir, { recursive: true });
	const now = new Date();
	const seeded = {
		id: "11111111-2222-3333-4444-555555555555",
		status: "active",
		source: "heartbeat",
		runtimeKind: "top-level",
		deliveryMode: "steer",
		activeSessionId: "omp-inproc-from-a-previous-run",
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: dir,
		prompt: "carry on",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		nextRunAt: new Date(now.getTime() - 1_000).toISOString(),
		runCount: 0,
	};
	await fs.writeFile(
		path.join(artifactDir, "scheduled-jobs.json"),
		`${JSON.stringify({ jobs: [seeded], dispatches: [] }, null, 2)}\n`,
	);

	const connection = new InProcessAgentConnection(makeRuntimeHost(session)) as any;
	try {
		await waitFor(() => session.heartbeatPrompts.length >= 1);
		const delivered = session.heartbeatPrompts[0]!;
		assert.equal(delivered.job.id, seeded.id);
		assert.equal(delivered.job.prompt, "carry on");
		assert.notEqual(delivered.job.activeSessionId, seeded.activeSessionId);
		assert.equal(delivered.options.streamingBehavior, "steer");
		assert.equal(delivered.options.followUpQueueKey, `heartbeat:${seeded.id}`);

		await waitForAsync(async () => (await connection.listHeartbeats())[0]?.job.runCount === 1);
	} finally {
		await connection.dispose();
	}
});

test("heartbeats: busy session defers delivery", { skip: !primeRoot }, async () => {
	const { InProcessAgentConnection, getSessionArtifactPathForFile, dir } = await setup();
	const session = makeFakeSession(dir);
	session.isBashRunning = true;
	const artifactDir = getSessionArtifactPathForFile(path.resolve(session.sessionFile!), session.sessionId);
	await fs.mkdir(artifactDir, { recursive: true });
	const now = new Date();
	await fs.writeFile(
		path.join(artifactDir, "scheduled-jobs.json"),
		`${
			JSON.stringify({
				jobs: [{
					id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					status: "active",
					source: "heartbeat",
					deliveryMode: "steer",
					activeSessionId: "omp-inproc-old",
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
					cwd: dir,
					prompt: "should wait",
					schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					nextRunAt: new Date(now.getTime() - 1_000).toISOString(),
					runCount: 0,
				}],
				dispatches: [],
			}, null, 2)
		}\n`,
	);

	const connection = new InProcessAgentConnection(makeRuntimeHost(session)) as any;
	try {
		await waitForAsync(async () => (await connection.listHeartbeats())[0]?.job.lastSkippedAt !== undefined);
		assert.equal(session.heartbeatPrompts.length, 0);
	} finally {
		await connection.dispose();
	}
});

test("heartbeats: sessions without a file get daemon-parity errors", { skip: !primeRoot }, async () => {
	const { InProcessAgentConnection, dir } = await setup();
	const session = makeFakeSession(dir, { sessionFile: undefined });
	const connection = new InProcessAgentConnection(makeRuntimeHost(session)) as any;
	try {
		assert.equal(await connection.getHeartbeat(), undefined);
		assert.deepEqual(await connection.listHeartbeats(), []);
		await assert.rejects(
			() => connection.setHeartbeat("every 10s", "x", undefined),
			/persisted session file/,
		);
		assert.throws(
			() => session.rlmController.createRlmHeartbeat({ instruction: "x" }),
			/persisted session file/,
		);
	} finally {
		await connection.dispose();
	}
});
