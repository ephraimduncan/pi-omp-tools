/**
 * `bash` — workspace shell with optional PTY and background-job dispatch,
 * replicating oh-my-pi's Runtime bash tool contract:
 *
 *  - Commands run on omp's own embedded brush shell (`@oh-my-pi/pi-natives`,
 *    the published napi addon that vendors brush-core) when that optional
 *    dependency is installed: one persistent shell session per host session,
 *    so `cd`, exports, functions, and aliases survive across calls, plus a
 *    real PTY via the addon's portable-pty binding. Without the addon the
 *    tool falls back to a per-call system shell (`$SHELL -c`) and a
 *    `script`-based PTY.
 *  - `command` runs in the workspace (`cwd`/`env` params instead of `cd`/
 *    inline exports), with a clamped timeout (default 300s, 0 disables).
 *  - `async: true` dispatches the command as a background job: the call
 *    returns a job id immediately and the settled result is auto-delivered
 *    back into the conversation (hosts with `sendUserMessage`).
 *  - Long foreground commands auto-background after a threshold (omp's
 *    `bash.autoBackground`, default 60s) instead of blocking the turn.
 *  - Job dispatch ops fold omp's hub surface into the same tool:
 *    `op: "jobs" | "output" | "wait" | "kill"` with `job: "b1"`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { sessionId, textResult, ToolError, type PiApi, type ToolCtx, type ToolResult, type ToolUpdate } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { bashRenderers, loadRenderSupport } from "../render.ts";

export const BASH_TIMEOUTS = { default: 300, min: 1, max: 3600 } as const;
const AUTO_BACKGROUND_MS = 60_000;
const INLINE_CAP_BYTES = 50 * 1024;
const INLINE_HEAD_LINES = 15;
const TAIL_BUFFER_BYTES = 512 * 1024;
const SETTLED_JOB_CAP = 64;
const UPDATE_THROTTLE_MS = 250;
const PTY_COLS = 120;
const PTY_ROWS = 40;

export const BASH_DESCRIPTION = `Workspace shell with optional PTY and background-job dispatch. The shell session is persistent when the embedded brush shell is available (cwd, exports, functions survive across calls); otherwise each call runs in a fresh system shell.

<instruction>
- Set \`cwd\` instead of \`cd\`; use \`env: { NAME: "…" }\` for multiline/quote-heavy values.
- \`timeout\` is seconds (default ${BASH_TIMEOUTS.default}, clamped ${BASH_TIMEOUTS.min}-${BASH_TIMEOUTS.max}); \`0\` disables the deadline for long-running work.
- \`pty: true\` only for terminal interaction (\`sudo\`, \`ssh\`, TUIs).
- \`async: true\` dispatches a background job: you receive a job id immediately and the settled result is delivered automatically.
- Job dispatch: \`op: "jobs"\` lists jobs, \`op: "output"\` reads a job's current tail, \`op: "wait"\` blocks until it settles, \`op: "kill"\` stops it — all with \`job: "b1"\`.
- Order-dependent commands use \`&&\` in one call; independent calls may run concurrently.
- Long foreground calls may auto-background after ${AUTO_BACKGROUND_MS / 1000}s and deliver later. Need the result inline? Raise \`timeout\`.
</instruction>

Exit codes and timeouts are reported inline; a non-zero exit is a result, not a tool failure. No truncation footer means the displayed output is complete.`;

export interface BashParams {
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	pty?: boolean;
	async?: boolean;
	op?: "jobs" | "output" | "wait" | "kill";
	job?: string;
}

export type BashBackend = "brush" | "brush-pty" | "system" | "system-pty";

interface BashJob {
	id: string;
	command: string;
	backend: BashBackend;
	tail: string;
	bytesSeen: number;
	logFile?: string;
	logFd?: number;
	startedAt: number;
	settledAt?: number;
	exitCode?: number;
	timedOut?: boolean;
	killed?: boolean;
	error?: string;
	delivered?: boolean;
	background: boolean;
	timeoutSec?: number;
	waiters: Array<() => void>;
	/** Stop this job (SIGTERM/abort; escalates to SIGKILL for subprocesses). */
	kill?: () => void;
}

interface BashJobStore {
	seq: number;
	jobs: Map<string, BashJob>;
}

const JOBS_KEY = Symbol.for("omp-tools.bash-jobs.v1");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[JOBS_KEY] ??= { seq: 0, jobs: new Map<string, BashJob>() } satisfies BashJobStore;
const store = globals[JOBS_KEY] as BashJobStore;

/* ------------------------------ brush natives ---------------------------- */

interface NativeShellRunResult {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
	workingDir?: string;
}

type NativeChunkCallback = (error: Error | null, chunk: string) => void;

interface NativeShell {
	run(
		options: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: unknown },
		onChunk?: NativeChunkCallback,
	): Promise<NativeShellRunResult>;
	abort(): Promise<void>;
}

interface NativePtySession {
	start(
		options: {
			command: string;
			shell?: string;
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: unknown;
			cols?: number;
			rows?: number;
		},
		onChunk?: NativeChunkCallback,
	): Promise<{ exitCode?: number; cancelled: boolean; timedOut: boolean }>;
	kill(): void;
}

interface BrushNatives {
	Shell: new (options?: { sessionEnv?: Record<string, string> }) => NativeShell;
	PtySession: new () => NativePtySession;
}

let nativesPromise: Promise<BrushNatives | null> | undefined;

/**
 * Load omp's published native addon. The package's own entry uses Bun-only
 * APIs (`import.meta.dir`), so under Node we fall back to requiring the
 * platform leaf package's `.node` binary directly — N-API loads in both
 * runtimes. `OMP_TOOLS_BASH_NO_BRUSH=1` forces the system-shell path.
 */
export function loadBrushNatives(): Promise<BrushNatives | null> {
	nativesPromise ??= (async () => {
		if (process.env.OMP_TOOLS_BASH_NO_BRUSH === "1") return null;
		const install = (bindings: Record<string, unknown>): BrushNatives | null => {
			if (typeof bindings.Shell !== "function" || typeof bindings.PtySession !== "function") return null;
			if (typeof bindings.__ompInstallTokioRuntime === "function") {
				try {
					(bindings.__ompInstallTokioRuntime as () => void)();
				} catch {
					/* default napi runtime is fine */
				}
			}
			return bindings as unknown as BrushNatives;
		};
		try {
			// Bun (pi): the official entry works and handles variant selection.
			// @ts-ignore -- optional dependency, resolved at runtime only
			const mod = (await import("@oh-my-pi/pi-natives")) as Record<string, unknown>;
			const loaded = install(mod);
			if (loaded) return loaded;
		} catch {
			/* fall through to the leaf-package path */
		}
		try {
			// Node (prime-agent): require the platform binary directly.
			const tag = `${process.platform}-${process.arch}`;
			const require_ = createRequire(import.meta.url);
			const leafDir = path.dirname(require_.resolve(`@oh-my-pi/pi-natives-${tag}/package.json`));
			for (const name of [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`, `pi_natives.${tag}.node`]) {
				const candidate = path.join(leafDir, name);
				if (!fs.existsSync(candidate)) continue;
				try {
					return install(require_(candidate) as Record<string, unknown>);
				} catch {
					/* try the next variant */
				}
			}
		} catch {
			/* addon not installed */
		}
		return null;
	})();
	return nativesPromise;
}

/** Persistent brush shell per host session: cwd/env/functions survive calls. */
interface BrushSession {
	shell: NativeShell;
	/** Working directory after the last session-shell command. */
	cwd?: string;
	/** In-flight session-shell runs; overlapping calls get a throwaway shell. */
	busy: number;
}

const BRUSH_SESSIONS_KEY = Symbol.for("omp-tools.bash-brush-sessions.v1");
globals[BRUSH_SESSIONS_KEY] ??= new Map<string, BrushSession>();
const brushSessions = globals[BRUSH_SESSIONS_KEY] as Map<string, BrushSession>;

function brushSessionFor(natives: BrushNatives, key: string): BrushSession {
	let session = brushSessions.get(key);
	if (!session) {
		session = { shell: new natives.Shell(), busy: 0 };
		brushSessions.set(key, session);
	}
	return session;
}

/* ------------------------------ shared utils ----------------------------- */

function scratchDir(): string {
	const dir = process.env.PI_SCRATCH_DIR || os.tmpdir();
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		/* tmpdir always exists */
	}
	return dir;
}

/** POSIX shell for `-c` execution; honors $SHELL when it is a bourne-like shell. */
export function pickShell(): string {
	if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
	const fromEnv = process.env.SHELL;
	if (fromEnv && /(?:^|\/)(?:bash|zsh|sh|dash|ksh)$/.test(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return "sh";
}

let scriptBinaryChecked: boolean | undefined;
function hasScriptBinary(): boolean {
	if (scriptBinaryChecked !== undefined) return scriptBinaryChecked;
	try {
		const probe = spawnSync("script", process.platform === "darwin" ? ["-q", "/dev/null", "true"] : ["-qec", "true", "/dev/null"], {
			stdio: "ignore",
			timeout: 5000,
		});
		scriptBinaryChecked = probe.status === 0;
	} catch {
		scriptBinaryChecked = false;
	}
	return scriptBinaryChecked;
}

/** Build argv for the system-shell fallback, optionally PTY-wrapped via `script`. */
export function buildArgv(command: string, pty: boolean): { file: string; args: string[]; ptyActive: boolean } {
	const shell = pickShell();
	if (process.platform === "win32") return { file: shell, args: ["/c", command], ptyActive: false };
	if (pty && hasScriptBinary()) {
		if (process.platform === "darwin") {
			// BSD script: script [-q] file command...
			return { file: "script", args: ["-q", "/dev/null", shell, "-c", command], ptyActive: true };
		}
		// util-linux script: script -qec command file
		return { file: "script", args: ["-qec", command, "/dev/null"], ptyActive: true };
	}
	return { file: shell, args: ["-c", command], ptyActive: false };
}

export function clampBashTimeout(raw: number | undefined): number | undefined {
	const requested = raw ?? BASH_TIMEOUTS.default;
	if (requested === 0) return undefined;
	return Math.max(BASH_TIMEOUTS.min, Math.min(BASH_TIMEOUTS.max, requested));
}

function formatWallTime(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (proc.pid === undefined) return;
	try {
		process.kill(-proc.pid, signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			/* already gone */
		}
	}
}

function appendOutput(job: BashJob, chunk: string): void {
	job.bytesSeen += Buffer.byteLength(chunk);
	job.tail += chunk;
	if (job.tail.length > TAIL_BUFFER_BYTES) job.tail = job.tail.slice(job.tail.length - TAIL_BUFFER_BYTES);
	if (job.bytesSeen > INLINE_CAP_BYTES && job.logFd === undefined && !job.logFile) {
		job.logFile = path.join(scratchDir(), `pi-omp-bash-${job.id}.log`);
		try {
			// Synchronous writes: the log path is advertised in the result, so it
			// must be fully written by the time the tool returns (issue seen with
			// brush delivering one large burst into a not-yet-flushed stream).
			job.logFd = fs.openSync(job.logFile, "w");
			fs.writeSync(job.logFd, job.tail);
			return;
		} catch {
			job.logFile = undefined;
			job.logFd = undefined;
		}
	}
	if (job.logFd !== undefined) {
		try {
			fs.writeSync(job.logFd, chunk);
		} catch {
			/* log spill is best-effort */
		}
	}
}

function pruneSettledJobs(): void {
	const settled = [...store.jobs.values()].filter(job => job.settledAt !== undefined);
	if (settled.length <= SETTLED_JOB_CAP) return;
	settled.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
	for (const job of settled.slice(0, settled.length - SETTLED_JOB_CAP)) store.jobs.delete(job.id);
}

function createJob(command: string, backend: BashBackend, background: boolean, timeoutSec: number | undefined): BashJob {
	const job: BashJob = {
		id: `b${++store.seq}`,
		command,
		backend,
		tail: "",
		bytesSeen: 0,
		startedAt: Date.now(),
		background,
		timeoutSec,
		waiters: [],
	};
	store.jobs.set(job.id, job);
	pruneSettledJobs();
	return job;
}

function finishJob(job: BashJob, patch: { exitCode?: number; timedOut?: boolean; error?: string }): void {
	if (job.settledAt !== undefined) return;
	if (patch.timedOut) job.timedOut = true;
	if (patch.error) job.error = patch.error;
	job.exitCode = patch.exitCode ?? (job.timedOut || job.killed ? 130 : 0);
	job.settledAt = Date.now();
	if (job.logFd !== undefined) {
		try {
			fs.closeSync(job.logFd);
		} catch {
			/* already closed */
		}
		job.logFd = undefined;
	}
	for (const wake of job.waiters.splice(0)) wake();
}

/* -------------------------------- runners -------------------------------- */

interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutSec: number | undefined;
	onData?: () => void;
}

/** Run on the persistent (or throwaway) brush shell. */
function runOnBrush(job: BashJob, shell: NativeShell, options: RunOptions): Promise<void> {
	const controller = new AbortController();
	job.kill = () => {
		job.killed = true;
		controller.abort();
	};
	return shell
		.run(
			{
				command: job.command,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutSec !== undefined ? options.timeoutSec * 1000 : undefined,
				signal: controller.signal,
			},
			(error, chunk) => {
				if (chunk) {
					appendOutput(job, chunk);
					options.onData?.();
				}
				void error;
			},
		)
		.then(result => {
			if (result.cancelled) job.killed = true;
			finishJob(job, { exitCode: result.exitCode, timedOut: result.timedOut });
			return result.workingDir;
		})
		.then(workingDir => {
			(job as { workingDir?: string } & BashJob).workingDir = workingDir;
		})
		.catch(error => {
			finishJob(job, { exitCode: 127, error: error instanceof Error ? error.message : String(error) });
		});
}

/** Run under the addon's real PTY (portable-pty). */
function runOnBrushPty(job: BashJob, natives: BrushNatives, options: RunOptions): Promise<void> {
	const controller = new AbortController();
	const pty = new natives.PtySession();
	job.kill = () => {
		job.killed = true;
		controller.abort();
		try {
			pty.kill();
		} catch {
			/* already gone */
		}
	};
	return pty
		.start(
			{
				command: job.command,
				shell: pickShell(),
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutSec !== undefined ? options.timeoutSec * 1000 : undefined,
				signal: controller.signal,
				cols: PTY_COLS,
				rows: PTY_ROWS,
			},
			(error, chunk) => {
				if (chunk) {
					appendOutput(job, chunk);
					options.onData?.();
				}
				void error;
			},
		)
		.then(result => {
			if (result.cancelled) job.killed = true;
			finishJob(job, { exitCode: result.exitCode, timedOut: result.timedOut });
		})
		.catch(error => {
			finishJob(job, { exitCode: 127, error: error instanceof Error ? error.message : String(error) });
		});
}

/** System-shell fallback: spawn `$SHELL -c` (PTY via `script` when asked). */
function runOnSpawn(job: BashJob, pty: boolean, options: RunOptions): { settled: Promise<void>; ptyActive: boolean } {
	const { file, args, ptyActive } = buildArgv(job.command, pty);
	let proc: ChildProcess;
	try {
		proc = spawn(file, args, {
			cwd: options.cwd,
			env: { TERM: "xterm-256color", ...process.env, ...options.env },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		finishJob(job, { exitCode: 127, error: error instanceof Error ? error.message : String(error) });
		return { settled: Promise.resolve(), ptyActive };
	}

	job.kill = () => {
		job.killed = true;
		killTree(proc, "SIGTERM");
		setTimeout(() => killTree(proc, "SIGKILL"), 3000).unref?.();
	};

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutSec !== undefined) {
		timeoutTimer = setTimeout(() => {
			job.timedOut = true;
			killTree(proc, "SIGTERM");
			setTimeout(() => killTree(proc, "SIGKILL"), 3000).unref?.();
		}, options.timeoutSec * 1000);
		timeoutTimer.unref?.();
	}

	const onChunk = (data: Buffer) => {
		appendOutput(job, data.toString());
		options.onData?.();
	};
	proc.stdout?.on("data", onChunk);
	proc.stderr?.on("data", onChunk);

	const settled = new Promise<void>(resolve => {
		const finish = (code: number | null, error?: string) => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			finishJob(job, { exitCode: code ?? undefined, error });
			resolve();
		};
		proc.on("close", code => finish(code));
		proc.on("error", error => finish(127, error.message));
	});
	return { settled, ptyActive };
}

/* ------------------------------- rendering ------------------------------- */

/** Strip cooked-terminal artifacts from PTY output. */
function cleanPtyOutput(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/^\^D\x08\x08/gm, "")
		.replace(/\x1b\[\?1049[hl]/g, "");
}

function jobOutputText(job: BashJob): string {
	const raw = job.backend.endsWith("-pty") ? cleanPtyOutput(job.tail) : job.tail;
	const text = raw.replace(/\n+$/, "");
	if (job.bytesSeen <= INLINE_CAP_BYTES) return text;
	const lines = text.split("\n");
	const head = lines.slice(0, INLINE_HEAD_LINES);
	const budget = Math.max(0, INLINE_CAP_BYTES - head.join("\n").length);
	const tailText = text.slice(text.length - budget);
	const tailLines = tailText.slice(tailText.indexOf("\n") + 1);
	const where = job.logFile ? `; full output: ${job.logFile}` : "";
	return [...head, `… [truncated: ${job.bytesSeen} bytes total${where}]`, tailLines].join("\n");
}

function jobStatus(job: BashJob): string {
	if (job.settledAt === undefined) return "running";
	if (job.timedOut) return "timeout";
	if (job.killed) return "killed";
	return job.exitCode === 0 ? "completed" : `exit ${job.exitCode}`;
}

function settledResult(job: BashJob, notices: string[]): ToolResult {
	const lines: string[] = [];
	const output = jobOutputText(job);
	if (output) lines.push(output);
	if (job.timedOut) lines.push(`Command timed out after ${job.timeoutSec ?? "?"} seconds`);
	else if (job.killed) lines.push("Command killed");
	else if (job.error) lines.push(`Error: ${job.error}`);
	else if (job.settledAt !== undefined && job.exitCode !== undefined && job.exitCode !== 0) lines.push(`(exit ${job.exitCode})`);
	lines.push(...notices);
	const wallTimeMs = (job.settledAt ?? Date.now()) - job.startedAt;
	return textResult(lines.join("\n") || "(no output)", {
		exitCode: job.exitCode,
		timedOut: job.timedOut === true,
		wallTimeMs,
		jobId: job.background ? job.id : undefined,
		logFile: job.logFile,
		bytes: job.bytesSeen,
		backend: job.backend,
	});
}

function backgroundStartResult(job: BashJob, notices: string[]): ToolResult {
	const lines: string[] = [];
	const tail = jobOutputText(job);
	if (tail) lines.push(tail);
	lines.push(...notices);
	lines.push(`Backgrounded as job ${job.id}; result will be delivered automatically.`);
	return textResult(lines.join("\n"), {
		jobId: job.id,
		background: true,
		running: true,
		bytes: job.bytesSeen,
		backend: job.backend,
	});
}

/* --------------------------------- job ops -------------------------------- */

function requireJob(id: string | undefined): BashJob {
	if (!id) throw new ToolError(`op requires \`job\` (one of: ${[...store.jobs.keys()].join(", ") || "none"})`);
	const job = store.jobs.get(id);
	if (!job) throw new ToolError(`Unknown job ${id} (known: ${[...store.jobs.keys()].join(", ") || "none"})`);
	return job;
}

async function executeJobOp(params: BashParams, signal?: AbortSignal): Promise<ToolResult> {
	switch (params.op) {
		case "jobs": {
			if (store.jobs.size === 0) return textResult("No background jobs.", { jobs: [] });
			const rows = [...store.jobs.values()].map(job => {
				const wall = formatWallTime((job.settledAt ?? Date.now()) - job.startedAt);
				return `${job.id}  ${jobStatus(job)}  ${wall}  ${job.command.split("\n")[0]?.slice(0, 80)}`;
			});
			return textResult(rows.join("\n"), {
				jobs: [...store.jobs.values()].map(job => ({ id: job.id, status: jobStatus(job), command: job.command })),
			});
		}
		case "output": {
			const job = requireJob(params.job);
			const result = settledResult(job, job.settledAt === undefined ? ["(still running)"] : []);
			if (result.details) result.details.running = job.settledAt === undefined;
			return result;
		}
		case "wait": {
			const job = requireJob(params.job);
			if (job.settledAt === undefined) {
				const waitMs = (clampBashTimeout(params.timeout) ?? BASH_TIMEOUTS.default) * 1000;
				await new Promise<void>(resolve => {
					const timer = setTimeout(resolve, waitMs);
					timer.unref?.();
					const wake = () => {
						clearTimeout(timer);
						resolve();
					};
					job.waiters.push(wake);
					signal?.addEventListener("abort", wake, { once: true });
				});
			}
			if (signal?.aborted) throw new ToolError("Wait aborted");
			if (job.settledAt === undefined) {
				const result = settledResult(job, [`Job ${job.id} still running after wait window; it keeps running.`]);
				if (result.details) result.details.running = true;
				return result;
			}
			job.delivered = true;
			return settledResult(job, []);
		}
		case "kill": {
			const job = requireJob(params.job);
			if (job.settledAt !== undefined) return textResult(`Job ${job.id} already settled (${jobStatus(job)}).`);
			job.killed = true;
			job.kill?.();
			return textResult(`Sent kill to job ${job.id}.`, { jobId: job.id });
		}
		default:
			throw new ToolError(`Unknown op ${String(params.op)}`);
	}
}

/* --------------------------------- execute -------------------------------- */

/** Host hook for settled-job auto-delivery; wired by registerBash. */
type DeliverFn = (text: string) => void;

function deliverSettled(job: BashJob, deliver: DeliverFn | undefined): void {
	if (job.delivered || !deliver) return;
	job.delivered = true;
	const wall = formatWallTime((job.settledAt ?? Date.now()) - job.startedAt);
	const body = jobOutputText(job);
	const status = jobStatus(job);
	deliver(
		`<background-job id="${job.id}" status="${status}" wallTime="${wall}">\n` +
			`$ ${job.command}\n${body ? `${body}\n` : ""}</background-job>`,
	);
}

export async function executeBash(
	params: BashParams,
	ctx?: ToolCtx,
	signal?: AbortSignal,
	onUpdate?: ToolUpdate,
	deliver?: DeliverFn,
): Promise<ToolResult> {
	if (params.op) return executeJobOp(params, signal);
	const command = params.command;
	if (!command || !command.trim()) throw new ToolError("`command` is required (or pass `op` for job dispatch)");

	const notices: string[] = [];
	const timeoutSec = clampBashTimeout(params.timeout);
	if (params.timeout !== undefined && params.timeout !== 0 && timeoutSec !== params.timeout) {
		notices.push(`Timeout clamped to ${timeoutSec}s (requested ${params.timeout}s; allowed ${BASH_TIMEOUTS.min}-${BASH_TIMEOUTS.max}s).`);
	}

	const natives = await loadBrushNatives();
	const sessionKey = sessionId(ctx) ?? "";
	const brushSession = natives ? brushSessionFor(natives, sessionKey) : undefined;

	// Explicit cwd wins; otherwise continue in the persistent shell's cwd.
	const baseCwd = ctx?.cwd ?? process.cwd();
	const cwd = params.cwd ? path.resolve(baseCwd, params.cwd) : (brushSession?.cwd ?? baseCwd);
	if (!fs.existsSync(cwd)) throw new ToolError(`cwd does not exist: ${cwd}`);

	let lastUpdate = 0;
	const pushUpdate = (job: BashJob) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (now - lastUpdate < UPDATE_THROTTLE_MS) return;
		lastUpdate = now;
		const tail = job.tail.split("\n").slice(-12).join("\n");
		onUpdate({ content: [{ type: "text", text: tail }], details: { running: true, bytes: job.bytesSeen } });
	};

	const wantPty = params.pty === true;
	const background = params.async === true;
	const runOptions: RunOptions = { cwd, env: params.env, timeoutSec, onData: () => pushUpdate(job) };

	let job: BashJob;
	let settled: Promise<void>;
	if (natives && wantPty) {
		job = createJob(command, "brush-pty", background, timeoutSec);
		settled = runOnBrushPty(job, natives, runOptions);
	} else if (natives && brushSession) {
		job = createJob(command, "brush", background, timeoutSec);
		if (background || brushSession.busy > 0) {
			// Background jobs and overlapping foreground calls get their own
			// shell so they run concurrently and can be killed independently.
			settled = runOnBrush(job, new natives.Shell(), runOptions);
		} else {
			brushSession.busy++;
			settled = runOnBrush(job, brushSession.shell, runOptions).finally(() => {
				brushSession.busy--;
				const workingDir = (job as { workingDir?: string } & BashJob).workingDir;
				if (workingDir) brushSession.cwd = workingDir;
			});
		}
	} else {
		job = createJob(command, wantPty ? "system-pty" : "system", background, timeoutSec);
		const spawned = runOnSpawn(job, wantPty, runOptions);
		settled = spawned.settled;
		if (wantPty && !spawned.ptyActive) {
			job.backend = "system";
			notices.push("pty requested but no PTY backend is available; ran without a terminal.");
		}
	}

	const abort = () => {
		if (job.settledAt === undefined) job.kill?.();
	};

	if (background) {
		// Background dispatch: settle later, deliver automatically.
		void settled.then(() => deliverSettled(job, deliver));
		return backgroundStartResult(job, notices);
	}

	signal?.addEventListener("abort", abort, { once: true });
	try {
		const autoBackground = !wantPty && process.env.OMP_TOOLS_BASH_NO_AUTOBG !== "1" && typeof deliver === "function";
		if (autoBackground) {
			const thresholdMs = Math.max(
				1000,
				Math.min(Number(process.env.OMP_TOOLS_BASH_AUTOBG_MS) || AUTO_BACKGROUND_MS, (timeoutSec ?? Infinity) * 1000 - 1000),
			);
			const raced = await Promise.race([
				settled.then(() => "settled" as const),
				new Promise<"threshold">(resolve => {
					const timer = setTimeout(() => resolve("threshold"), thresholdMs);
					timer.unref?.();
					void settled.finally(() => clearTimeout(timer));
				}),
			]);
			if (raced === "threshold" && job.settledAt === undefined && !signal?.aborted) {
				job.background = true;
				void settled.then(() => deliverSettled(job, deliver));
				return backgroundStartResult(job, notices);
			}
		}
		await settled;
	} finally {
		signal?.removeEventListener("abort", abort);
	}

	if (signal?.aborted && !job.timedOut) {
		const tail = jobOutputText(job);
		throw new ToolError(`[Command cancelled]${tail ? `\n${tail}` : ""}`);
	}
	job.delivered = true;
	return settledResult(job, notices);
}

/* -------------------------------- register -------------------------------- */

export async function registerBash(pi: PiApi): Promise<void> {
	registeredTools.add("bash");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	// Auto-delivery of settled background jobs, when the host can inject
	// messages (pi and prime expose sendUserMessage on the extension API).
	const host = pi as { sendUserMessage?: (content: string, options?: { deliverAs?: string }) => void };
	const deliver: DeliverFn | undefined =
		typeof host.sendUserMessage === "function"
			? text => {
					try {
						host.sendUserMessage?.(text, { deliverAs: "followUp" });
					} catch {
						/* delivery is best-effort; op:"wait" remains available */
					}
				}
			: undefined;

	pi.registerTool({
		...(support ? { renderShell: "self", ...bashRenderers(support) } : {}),
		name: "bash",
		label: "Bash",
		description: BASH_DESCRIPTION,
		promptSnippet: "Workspace shell with optional PTY and background-job dispatch",
		promptGuidelines: [
			"Use bash for shell commands with cwd/env params instead of cd/export prefixes; use async: true (or let slow commands auto-background) for long-running work.",
		],
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "command to execute (required unless op is set)" })),
			cwd: Type.Optional(Type.String({ description: "working directory" })),
			env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "extra env vars" })),
			timeout: Type.Optional(
				Type.Number({
					description: `timeout in seconds; 0 disables the deadline; nonzero values are clamped to ${BASH_TIMEOUTS.min}-${BASH_TIMEOUTS.max}`,
				}),
			),
			pty: Type.Optional(Type.Boolean({ description: "run in pty mode (terminal interaction)" })),
			async: Type.Optional(Type.Boolean({ description: "run as a background job" })),
			op: Type.Optional(
				Type.Union([Type.Literal("jobs"), Type.Literal("output"), Type.Literal("wait"), Type.Literal("kill")], {
					description: "background-job dispatch operation",
				}),
			),
			job: Type.Optional(Type.String({ description: "job id for output/wait/kill" })),
		}),
		async execute(_id: string, call: BashParams, signal?: AbortSignal, onUpdate?: ToolUpdate, callCtx?: ToolCtx) {
			return executeBash(call, callCtx, signal, onUpdate, deliver);
		},
	});
}
