/**
 * Compact post-edit preview: numbered current-file lines around each change,
 * so a follow-up edit can take fresh line numbers directly from the response.
 */
import { diffLines } from "diff";
import { formatNumberedLine } from "../shared/util.ts";

const CONTEXT = 2;
const MAX_RUN = 6;
const MAX_PREVIEW_LINES = 80;

export function buildPreview(before: string, after: string): string {
	const parts = diffLines(before, after);
	const out: string[] = [];
	let newLine = 1;
	let pendingContext: string[] = [];
	let emittedAny = false;

	const pushMarker = (): void => {
		if (out.length > 0 && out[out.length - 1] !== "…") out.push("…");
	};

	for (const part of parts) {
		const count = part.count ?? 0;
		const partLines = part.value.split("\n");
		if (partLines[partLines.length - 1] === "") partLines.pop();
		if (part.removed) continue;
		if (part.added) {
			// Emit trailing context collected before this change.
			if (pendingContext.length > 0) {
				if (emittedAny || pendingContext.length > CONTEXT) pushMarker();
				for (const line of pendingContext.slice(-CONTEXT)) out.push(line);
				pendingContext = [];
			}
			if (count <= MAX_RUN) {
				for (let i = 0; i < partLines.length; i++) out.push(formatNumberedLine(newLine + i, partLines[i] as string));
			} else {
				for (let i = 0; i < CONTEXT; i++) out.push(formatNumberedLine(newLine + i, partLines[i] as string));
				out.push("…");
				for (let i = count - CONTEXT; i < count; i++)
					out.push(formatNumberedLine(newLine + i, partLines[i] as string));
			}
			emittedAny = true;
			newLine += count;
			continue;
		}
		// Unchanged run: keep head as trailing context of the previous change,
		// stash tail as leading context for the next.
		let index = 0;
		if (emittedAny) {
			for (; index < Math.min(CONTEXT, count); index++) {
				out.push(formatNumberedLine(newLine + index, partLines[index] as string));
			}
		}
		pendingContext = [];
		for (let i = Math.max(index, count - CONTEXT); i < count; i++) {
			pendingContext.push(formatNumberedLine(newLine + i, partLines[i] as string));
		}
		if (index < count - CONTEXT && emittedAny) pushMarker();
		newLine += count;
	}

	if (out.length > MAX_PREVIEW_LINES) {
		const head = out.slice(0, MAX_PREVIEW_LINES);
		head.push(`… preview truncated (${out.length} lines)`);
		return head.join("\n");
	}
	return out.join("\n");
}
