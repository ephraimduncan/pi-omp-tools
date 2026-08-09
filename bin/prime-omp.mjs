#!/usr/bin/env node
/**
 * prime-omp: launch prime-agent IN-PROCESS so extension tool renderers work.
 *
 * Interactive prime normally attaches the TUI to a daemon-hosted session;
 * render functions cannot cross that RPC boundary, so extension renderCall/
 * renderResult never reach the TUI. prime's public `main(args, options)`
 * skips the daemon whenever process-local `extensionFactories` are present
 * (`hasProcessLocalExtensionFactories`), running the session in-process with
 * a localSessionHost — the mode where custom tool UIs render.
 *
 * The factory below is a NO-OP: its only job is flipping that switch. The
 * omp tools themselves load through normal package discovery
 * (settings.json "packages"), now in-process, renderers intact.
 *
 * Trade-offs vs daemon mode: the session lives in this process (closing the
 * terminal ends it — it is still saved and resumable), no multi-client
 * attach, and daemon-hosted features (agents view, background sessions)
 * are unavailable. Plain `prime-agent` remains untouched.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function findPrimeRoot() {
	if (process.env.PRIME_AGENT_ROOT) return process.env.PRIME_AGENT_ROOT;
	const probe = process.platform === "win32" ? "where" : "which";
	const binPath = execFileSync(probe, ["prime-agent"], { encoding: "utf8" }).trim().split("\n")[0];
	// bin -> .../node_modules/prime-agent/dist/bundle/cli.js (via symlink)
	const real = realpathSync(binPath);
	let dir = path.dirname(real);
	for (let i = 0; i < 6; i++) {
		if (path.basename(dir) === "prime-agent" && path.basename(path.dirname(dir)) === "node_modules") return dir;
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the prime-agent package root from ${real}. Set PRIME_AGENT_ROOT.`);
}

const primeRoot = findPrimeRoot();
const { main } = await import(pathToFileURL(path.join(primeRoot, "dist", "index.js")).href);

// No-op factory: forces the in-process (non-daemon) interactive runtime.
await main(process.argv.slice(2), { extensionFactories: [async () => {}] });
