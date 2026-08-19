/**
 * In-process heartbeat emulation for the prime-omp launcher.
 *
 * Daemon-hosted sessions get heartbeats from the daemon's cron scheduler;
 * `InProcessAgentConnection` stubs every heartbeat entry point with
 * "Heartbeats require daemon mode". This module runs prime's own machinery
 * inside the terminal process instead: `AgentCronJobStore` persisted in the
 * session's artifact dir, `AgentCronScheduler` for timers, and
 * `session.promptHeartbeat` for delivery — the same calls the daemon makes.
 * `session.setRlmHeartbeatController` (added upstream for exactly this
 * "session created outside the daemon" case) exposes the rlm-heartbeat skill
 * to the kernel.
 *
 * Semantics vs daemon mode:
 * - `/heartbeat`, the heartbeat manager UI, and the rlm-heartbeat skill work.
 * - Jobs persist in `<session-artifacts>/scheduled-jobs.json`; reopening the
 *   session (in prime-omp or under the daemon) revives them via
 *   `rebindSessionJobs`, so nothing is lost across restarts.
 * - Heartbeats only fire while this terminal process is open — the honest
 *   scope of an in-process session's lifetime.
 * - Cron job creation stays daemon-only, but already-persisted cron jobs that
 *   come due while the session is open still run (queued as follow-ups).
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export async function installInProcessHeartbeats(primeRoot) {
	const distImport = (relPath) => import(pathToFileURL(path.join(primeRoot, "dist", relPath)).href);
	const [cron, sessionManagerModule, connectionModule] = await Promise.all([
		distImport("core/cron-jobs.js"),
		distImport("core/session-manager.js"),
		distImport("modes/agent-connection/in-process-agent-connection.js"),
	]);
	const {
		AgentCronJobStore,
		AgentCronScheduler,
		DEFAULT_HEARTBEAT_SCHEDULE,
		isHeartbeatCronJob,
		normalizeHeartbeatDeliveryMode,
		normalizeHeartbeatSchedule,
		resolveHeartbeatStreamingBehavior,
		shouldDeferHeartbeatCronJob,
	} = cron;
	const { getSessionArtifactPathForFile } = sessionManagerModule;
	const { InProcessAgentConnection } = connectionModule;
	const proto = InProcessAgentConnection?.prototype;
	if (
		typeof proto?.bindCurrentSessionEvents !== "function" ||
		typeof proto?.dispose !== "function" ||
		typeof AgentCronJobStore?.forSessionArtifacts !== "function" ||
		typeof AgentCronScheduler !== "function" ||
		typeof getSessionArtifactPathForFile !== "function"
	) {
		throw new Error("prime-agent module shape changed; in-process heartbeats unavailable");
	}

	const installedMarker = Symbol.for("prime-omp.in-process-heartbeats.v1");
	if (proto[installedMarker]) {
		return;
	}
	proto[installedMarker] = true;

	/** connection -> { session, activeSessionId, store, scheduler, offHeartbeatChange } */
	const states = new WeakMap();
	const heartbeatQueueKey = (job) => `heartbeat:${job.id}`;

	function teardown(connection) {
		const state = states.get(connection);
		if (!state) return;
		state.scheduler.stop();
		state.offHeartbeatChange();
		states.delete(connection);
	}

	function bindSession(connection) {
		const session = connection.session;
		if (states.get(connection)?.session === session) return;
		teardown(connection);
		if (
			typeof session?.setRlmHeartbeatController !== "function" ||
			typeof session?.promptHeartbeat !== "function" ||
			typeof session?.removeQueuedFollowUp !== "function"
		) {
			return;
		}
		const store = AgentCronJobStore.forSessionArtifacts();
		const state = {
			session,
			// Daemon-local ids never exist in-process; mint one per session bind so
			// store rows stay keyed the way every AgentCronJobStore API expects.
			activeSessionId: `omp-inproc-${randomUUID()}`,
			store,
			scheduler: new AgentCronScheduler(store, {
				runJob: (job) => runDueJob(connection, state, job),
			}),
			offHeartbeatChange: store.onHeartbeatChange(() => {
				void connection.emit({ type: "heartbeats_changed" });
			}),
		};
		const sessionFile = session.sessionFile;
		if (sessionFile) {
			store.registerSessionArtifact(
				session.sessionId,
				getSessionArtifactPathForFile(path.resolve(sessionFile), session.sessionId),
			);
			store.rebindSessionJobs({
				activeSessionId: state.activeSessionId,
				sessionId: session.sessionId,
				sessionFile,
				cwd: session.sessionManager.getCwd(),
			});
		}
		states.set(connection, state);
		session.setRlmHeartbeatController(createRlmController(state));
		state.scheduler.start();
	}

	async function runDueJob(connection, state, job) {
		if (states.get(connection) !== state || job.activeSessionId !== state.activeSessionId) {
			return "skipped";
		}
		const session = state.session;
		const runnable = state.store.getClaimedJob(job.id) ?? state.store.getDueJob(job.id);
		if (!runnable) return "skipped";
		if (shouldDeferHeartbeatCronJob(runnable, session)) return "skipped";
		if (isHeartbeatCronJob(runnable)) {
			await session.promptHeartbeat(runnable, {
				streamingBehavior: resolveHeartbeatStreamingBehavior(runnable.deliveryMode),
				followUpQueueKey: heartbeatQueueKey(runnable),
				source: "rpc",
			});
			return;
		}
		await session.followUp(runnable.prompt, undefined, { resumeIfIdle: true });
	}

	function createRlmController(state) {
		return {
			listRlmHeartbeats: (options) => state.store.listRlmHeartbeats(state.activeSessionId, options),
			createRlmHeartbeat: (input) => {
				if (!state.session.sessionFile) {
					throw new Error("RLM heartbeats require a persisted session file");
				}
				const job = state.store.createRlmHeartbeat({
					activeSessionId: state.activeSessionId,
					sessionId: state.session.sessionId,
					sessionFile: state.session.sessionFile,
					cwd: state.session.sessionManager.getCwd(),
					runtimeKind: "top-level",
					label: input.label,
					scheduleText: normalizeHeartbeatSchedule(input.interval ?? DEFAULT_HEARTBEAT_SCHEDULE),
					prompt: input.instruction,
					deliveryMode: input.deliveryMode,
				});
				state.scheduler.wake();
				return job;
			},
			updateRlmHeartbeat: (input) => {
				const job = state.store.updateRlmHeartbeat(state.activeSessionId, input.id, {
					label: input.label,
					prompt: input.instruction,
					scheduleText: input.interval ? normalizeHeartbeatSchedule(input.interval) : undefined,
					status: input.status,
					deliveryMode: input.deliveryMode,
				});
				if (job) {
					if (
						input.instruction !== undefined ||
						input.interval !== undefined ||
						input.status === "pause" ||
						input.deliveryMode !== undefined
					) {
						state.session.removeQueuedFollowUp(heartbeatQueueKey(job));
					}
					state.scheduler.wake();
				}
				return job;
			},
			deleteRlmHeartbeat: (id) => {
				const job = state.store.deleteRlmHeartbeat(state.activeSessionId, id);
				if (job) {
					state.session.removeQueuedFollowUp(heartbeatQueueKey(job));
					state.scheduler.wake();
				}
				return job;
			},
		};
	}

	function requireState(connection) {
		const state = states.get(connection);
		if (!state) {
			throw new Error("Heartbeats are not available for this session");
		}
		return state;
	}

	proto.listHeartbeats = async function () {
		const state = states.get(this);
		if (!state) return [];
		return state.store
			.list()
			.filter((job) => isHeartbeatCronJob(job) && (job.status === "active" || job.status === "paused"))
			.map((job) => ({ job }));
	};
	proto.manageHeartbeat = async function (activeSessionId, jobId, action) {
		const state = requireState(this);
		const job = state.store.manageHeartbeat(activeSessionId, jobId, action);
		if (!job) {
			throw new Error(`No active heartbeat found: ${jobId}`);
		}
		if (action !== "resume") state.session.removeQueuedFollowUp(heartbeatQueueKey(job));
		state.scheduler.wake();
		return job;
	};
	proto.getHeartbeat = async function () {
		const state = states.get(this);
		return state ? (state.store.getHeartbeat(state.activeSessionId) ?? undefined) : undefined;
	};
	proto.setHeartbeat = async function (schedule, instruction, deliveryMode) {
		const state = requireState(this);
		const session = state.session;
		if (!session.sessionFile) {
			throw new Error("Heartbeats require a persisted session file");
		}
		const previous = state.store.getHeartbeat(state.activeSessionId);
		const job = state.store.createHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: session.sessionManager.getCwd(),
			runtimeKind: "top-level",
			scheduleText: normalizeHeartbeatSchedule(schedule),
			prompt: instruction,
			deliveryMode: normalizeHeartbeatDeliveryMode(deliveryMode) ?? previous?.deliveryMode,
		});
		if (previous) session.removeQueuedFollowUp(heartbeatQueueKey(previous));
		state.scheduler.wake();
		return job;
	};
	proto.updateHeartbeat = async function (action) {
		const state = requireState(this);
		const job =
			action === "pause"
				? state.store.pauseHeartbeat(state.activeSessionId)
				: action === "resume"
					? state.store.resumeHeartbeat(state.activeSessionId)
					: state.store.clearHeartbeat(state.activeSessionId);
		if (job && action !== "resume") state.session.removeQueuedFollowUp(heartbeatQueueKey(job));
		state.scheduler.wake();
		return job ?? undefined;
	};

	const originalBind = proto.bindCurrentSessionEvents;
	proto.bindCurrentSessionEvents = function () {
		originalBind.call(this);
		try {
			bindSession(this);
		} catch {
			/* heartbeats stay unavailable for this session */
		}
	};
	const originalDispose = proto.dispose;
	proto.dispose = async function () {
		teardown(this);
		return originalDispose.call(this);
	};
}
