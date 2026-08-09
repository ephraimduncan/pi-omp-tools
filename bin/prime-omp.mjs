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

// omp parity: hide the model/context tray line under the editor (omp has no
// bottom bar; the omp chrome extension puts status in the editor's top
// border). The tray still appears when subagents are active, since that is
// functional information with no other surface. Best-effort: skipped if the
// module shape changes.
try {
	const trayModule = await import(
		pathToFileURL(path.join(primeRoot, "dist", "modes", "interactive", "components", "subagent-summary-line.js")).href
	);
	const SubagentSummaryLine = trayModule.SubagentSummaryLine;
	if (SubagentSummaryLine?.prototype?.render) {
		const originalRender = SubagentSummaryLine.prototype.render;
		SubagentSummaryLine.prototype.render = function (width) {
			if ((this.counts?.total ?? 0) === 0) return [];
			return originalRender.call(this, width);
		};
	}
} catch {
	/* tray stays visible on unexpected prime versions */
}

// omp parity: append omp's usage row under every completed assistant message
// (`time  ⤵ in  ⤴ out  💾 cache  ⏱ ttft  ⚡ tok/s`, dim). Stream timings come
// from the omp chrome extension via a globalThis bridge; without a timing
// entry (resumed history) the row shows token counts only. Best-effort.
try {
	const messageModule = await import(
		pathToFileURL(path.join(primeRoot, "dist", "modes", "interactive", "components", "assistant-message.js")).href
	);
	const themeModule = await import(
		pathToFileURL(path.join(primeRoot, "dist", "modes", "interactive", "theme", "theme.js")).href
	);
	const AssistantMessageComponent = messageModule.AssistantMessageComponent;
	const TIMING_KEY = Symbol.for("omp-tools.usage-timings.v1");

	const trim1 = (n) => {
		const s = n.toFixed(1);
		return s.endsWith(".0") ? s.slice(0, -2) : s;
	};
	const formatNumber = (n) => {
		if (n < 1_000) return String(n);
		if (n < 10_000) return `${trim1(n / 1_000)}K`;
		if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
		if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
		return `${Math.round(n / 1_000_000)}M`;
	};
	const pad2 = (n) => String(n).padStart(2, "0");
	const formatStamp = (ms) => {
		const d = new Date(ms);
		return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	};

	const buildUsageRow = (message) => {
		const usage = message?.usage;
		if (!usage) return undefined;
		const output = usage.output ?? 0;
		const totalInput = (usage.input ?? 0) + (usage.cacheWrite ?? 0);
		if (totalInput === 0 && output === 0) return undefined;
		const timings = globalThis[TIMING_KEY];
		let timing;
		if (Array.isArray(timings)) {
			for (let i = timings.length - 1; i >= 0; i--) {
				const candidate = timings[i];
				if (
					candidate.input === (usage.input ?? 0) &&
					candidate.output === output &&
					candidate.cacheRead === (usage.cacheRead ?? 0) &&
					candidate.cacheWrite === (usage.cacheWrite ?? 0)
				) {
					timing = candidate;
					break;
				}
			}
		}
		const parts = [];
		if (timing?.at) parts.push(formatStamp(timing.at));
		parts.push(`⤵ ${formatNumber(totalInput)}`);
		parts.push(`⤴ ${formatNumber(output)}`);
		if ((usage.cacheRead ?? 0) > 0) parts.push(`💾 ${formatNumber(usage.cacheRead)}`);
		if (timing?.ttftMs > 0) parts.push(`⏱ ${(timing.ttftMs / 1000).toFixed(1)}s`);
		if (timing?.durationMs > 100 && output > 0) {
			parts.push(`⚡ ${((output / timing.durationMs) * 1000).toFixed(1)}/s`);
		}
		return parts.join("  ");
	};

	if (AssistantMessageComponent?.prototype?.render) {
		const originalRender = AssistantMessageComponent.prototype.render;
		AssistantMessageComponent.prototype.render = function (width) {
			const lines = originalRender.call(this, width);
			const message = this.lastMessage;
			// Only completed, non-error assistant messages get a usage row.
			const stop = message?.stopReason;
			if (!message || (stop !== "stop" && stop !== "toolUse" && stop !== "length")) return lines;
			if (this.__ompUsageRow === undefined) {
				this.__ompUsageRow = buildUsageRow(message) ?? null;
			}
			if (!this.__ompUsageRow) return lines;
			const dim = themeModule.theme?.fg ? themeModule.theme.fg("dim", this.__ompUsageRow) : this.__ompUsageRow;
			return [...lines, "", ` ${dim}`];
		};
	}
} catch {
	/* usage rows are cosmetic; skip on unexpected prime versions */
}

// No-op factory: forces the in-process (non-daemon) interactive runtime.
await main(process.argv.slice(2), { extensionFactories: [async () => {}] });
