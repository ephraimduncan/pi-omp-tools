/**
 * Numbered unified diff in the host TUI's format: `+123 content`,
 * `-123 content`, ` 123 content` — consumed by prime/pi's `renderDiff`
 * (red/green rows with intra-line inverse highlighting).
 */
import { structuredPatch } from "diff";

export function numberedDiff(before: string, after: string, context = 2): string {
	const patch = structuredPatch("a", "b", before, after, "", "", { context });
	const width = String(
		Math.max(1, ...patch.hunks.map(hunk => Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines))),
	).length;
	const out: string[] = [];
	let firstHunk = true;
	for (const hunk of patch.hunks) {
		if (!firstHunk) out.push("⋮");
		firstHunk = false;
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const sign = line[0];
			const content = line.slice(1);
			if (sign === "-") {
				out.push(`-${String(oldLine).padStart(width)} ${content}`);
				oldLine++;
			} else if (sign === "+") {
				out.push(`+${String(newLine).padStart(width)} ${content}`);
				newLine++;
			} else {
				out.push(` ${String(newLine).padStart(width)} ${content}`);
				oldLine++;
				newLine++;
			}
		}
	}
	return out.join("\n");
}
