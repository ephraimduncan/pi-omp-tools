/**
 * System-shell fallback suite: forces OMP_TOOLS_BASH_NO_BRUSH before the tool
 * module loads, so the bash tool exercises the spawn/`script` path that hosts
 * without @oh-my-pi/pi-natives use. Runs in its own process (node --test
 * spawns one per file), so the natives cache in the sibling suite is unaffected.
 */
process.env.OMP_TOOLS_BASH_NO_BRUSH = "1";

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { executeBash, loadBrushNatives, type ToolResult } from "../packages/omp-tools-core/index.ts";

function text(result: ToolResult): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n");
}

test("bash(system): natives are disabled by the kill switch", async () => {
	assert.equal(await loadBrushNatives(), null);
});

test("bash(system): runs a command on the system shell", async () => {
	const result = await executeBash({ command: "echo system-fallback-ok" });
	assert.equal(text(result), "system-fallback-ok");
	assert.equal(result.details?.backend, "system");
	assert.equal(result.details?.exitCode, 0);
});

test("bash(system): non-zero exit and timeout still behave", async () => {
	const failed = await executeBash({ command: "exit 5" });
	assert.equal(failed.details?.exitCode, 5);
	assert.match(text(failed), /\(exit 5\)/);

	const timedOut = await executeBash({ command: "sleep 30", timeout: 1 });
	assert.equal(timedOut.details?.timedOut, true);
});

test("bash(system): async job lifecycle works without natives", async () => {
	const start = await executeBash({ command: "sleep 0.2; echo system-bg-done", async: true });
	const jobId = /job (b\d+)/.exec(text(start))?.[1];
	assert.ok(jobId);
	const waited = await executeBash({ op: "wait", job: jobId });
	assert.match(text(waited), /system-bg-done/);
});
