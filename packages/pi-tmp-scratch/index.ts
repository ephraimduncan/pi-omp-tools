/**
 * pi-tmp-scratch: omp-style /tmp scratch discipline for pi / prime-agent.
 *
 * oh-my-pi keeps throwaway work out of the repository by rooting its scratch
 * space under the OS temp dir (e.g. /tmp/omp-local/<session>) and steering the
 * model there. This package gives pi/prime-agent the same habit:
 *
 * - `session_start`: creates a per-session scratch directory under /tmp
 *   (falling back to os.tmpdir() when /tmp is unavailable) and exports it as
 *   $PI_SCRATCH_DIR so shells and kernels spawned afterwards inherit it.
 * - `before_agent_start`: appends a "## Scratch space" block to the system
 *   prompt — all temporary work (probe scripts, repro programs, one-off
 *   clones, downloads, generated junk, large intermediates) goes to the
 *   scratch dir, never into the repo/workspace.
 * - `/scratch` command: shows the directory and its contents;
 *   `/scratch clean` empties it.
 *
 * Nothing durable belongs there: the whole point is that wiping /tmp
 * periodically is safe.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Minimal structural host surface (no host imports, works in pi + prime). */
interface PiHost {
	on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerCommand?(name: string, options: {
		description?: string;
		handler: (args: string, ctx: unknown) => Promise<void> | void;
	}): void;
}

interface HostCtx {
	sessionManager?: { getSessionId?: () => string };
	ui?: { notify?: (message: string, level?: string) => void };
}

const STATE_KEY = Symbol.for("omp-tools.scratch.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[STATE_KEY] ??= {};
const state = globalRegistry[STATE_KEY] as { dir?: string };

export const SCRATCH_MARKER = "## Scratch space";
const BASE_NAME = "pi-scratch";

/** Prefer the literal /tmp (the dir the user actually cleans) over the darwin
 * per-user os.tmpdir() (/var/folders/...), which survives /tmp wipes. */
export function scratchRoot(): string {
	if (process.platform !== "win32") {
		try {
			fs.accessSync("/tmp", fs.constants.W_OK);
			return "/tmp";
		} catch {
			/* no writable /tmp — fall through */
		}
	}
	return os.tmpdir();
}

function sessionSlug(ctx: unknown): string {
	try {
		const id = (ctx as HostCtx)?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) {
			return id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
		}
	} catch {
		/* host without session manager */
	}
	return `pid-${process.pid}`;
}

/** Create (or re-create — the user may wipe /tmp mid-session) the scratch dir. */
export function ensureScratchDir(ctx: unknown): string {
	const dir = path.join(scratchRoot(), BASE_NAME, sessionSlug(ctx));
	fs.mkdirSync(dir, { recursive: true });
	state.dir = dir;
	process.env.PI_SCRATCH_DIR = dir;
	return dir;
}

export function scratchBlock(dir: string): string {
	return [
		SCRATCH_MARKER,
		`Session scratch directory: ${dir} (already created; also exported as $PI_SCRATCH_DIR).`,
		"Do ALL throwaway work there: probe/repro scripts, one-off clones and downloads, generated fixtures, build/test junk, large intermediate outputs. Create subdirectories freely.",
		"- NEVER create temporary or scratch files inside the repository/workspace — no ./tmp dirs, no scratch.py or test-output files next to sources. Files the project genuinely needs at a specific path are of course fine.",
		"- The user wipes /tmp periodically: never store durable results in the scratch dir, and skip cleanup — leftover scratch files are expected and harmless.",
	].join("\n");
}

function describeDir(dir: string): string {
	let entries = 0;
	let bytes = 0;
	const walk = (current: string, depth: number): void => {
		if (entries > 2000 || depth > 6) return;
		let names: fs.Dirent[];
		try {
			names = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of names) {
			entries++;
			if (entries > 2000) return;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else {
				try {
					bytes += fs.statSync(full).size;
				} catch {
					/* raced deletion */
				}
			}
		}
	};
	walk(dir, 0);
	if (entries === 0) return "empty";
	const size =
		bytes >= 1024 * 1024
			? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
			: bytes >= 1024
				? `${(bytes / 1024).toFixed(1)} KB`
				: `${bytes} B`;
	return `${entries}${entries > 2000 ? "+" : ""} entr${entries === 1 ? "y" : "ies"}, ${size}`;
}

export default function tmpScratch(pi: PiHost): void {
	pi.on?.("session_start", (_event, ctx) => {
		try {
			ensureScratchDir(ctx);
		} catch {
			/* read-only environments: prompt block is skipped too */
		}
	});

	pi.on?.("before_agent_start", (event, ctx) => {
		const systemPrompt = (event as { systemPrompt?: unknown })?.systemPrompt;
		if (typeof systemPrompt !== "string") return undefined;
		if (systemPrompt.includes(SCRATCH_MARKER)) return undefined;
		let dir: string;
		try {
			dir = ensureScratchDir(ctx);
		} catch {
			return undefined;
		}
		return { systemPrompt: `${systemPrompt}\n\n${scratchBlock(dir)}` };
	});

	pi.registerCommand?.("scratch", {
		description: "Show the session's /tmp scratch directory (`/scratch clean` empties it)",
		handler: (args, ctx) => {
			const notify = (message: string, level = "info"): void => {
				(ctx as HostCtx)?.ui?.notify?.(message, level);
			};
			let dir: string;
			try {
				dir = ensureScratchDir(ctx);
			} catch (error) {
				notify(`scratch dir unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if ((args ?? "").trim() === "clean") {
				fs.rmSync(dir, { recursive: true, force: true });
				fs.mkdirSync(dir, { recursive: true });
				notify(`scratch cleaned: ${dir}`);
				return;
			}
			notify(`${dir} — ${describeDir(dir)}`);
		},
	});
}
