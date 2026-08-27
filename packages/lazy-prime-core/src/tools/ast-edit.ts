/**
 * `ast_edit` tool: structural rewrites via ast-grep patterns. Dry-run by
 * default — matches render as unified-diff previews; re-issue with
 * `apply: true` to write.
 */
import * as fs from "node:fs/promises";
import { textResult, ToolError, type ToolCtx, type ToolResult } from "../host.ts";
import { astRewrite } from "../shared/astengine.ts";
import { collectFiles } from "../shared/files.ts";
import { numberedDiff } from "../shared/numdiff.ts";
import { snapshots } from "../shared/snapshots.ts";
import { capOutput, denormalizeText, displayPath, normalizeText } from "../shared/util.ts";

export interface AstEditParams {
	ops: Array<{ pat: string; out: string }>;
	paths: string[];
	apply?: boolean;
}

const MAX_FILES = 50;
const MAX_DIFF_LINES_PER_FILE = 60;

function cappedDiff(before: string, after: string): string {
	const lines = numberedDiff(before, after).split("\n");
	if (lines.length > MAX_DIFF_LINES_PER_FILE) {
		const shown = lines.slice(0, MAX_DIFF_LINES_PER_FILE);
		shown.push(`… diff truncated (${lines.length} lines)`);
		return shown.join("\n");
	}
	return lines.join("\n");
}

export async function executeAstEdit(params: AstEditParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	if (!params.ops || params.ops.length === 0) throw new ToolError("ast_edit requires at least one {pat, out} op.");
	const files = await collectFiles(params.paths, cwd, signal);

	const changes: Array<{ file: string; before: string; after: string; count: number; encoding: { hadBom: boolean; crlf: boolean } }> = [];
	const parseErrors: string[] = [];
	let filesSearched = 0;

	for (const file of files) {
		if (signal?.aborted) break;
		if (changes.length >= MAX_FILES) break;
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		if (raw.includes("\u0000")) continue;
		const normalized = normalizeText(raw);
		filesSearched++;
		try {
			const result = await astRewrite(file, normalized.text, params.ops);
			if (result && result.count > 0 && result.newText !== normalized.text) {
				changes.push({
					file,
					before: normalized.text,
					after: result.newText,
					count: result.count,
					encoding: { hadBom: normalized.hadBom, crlf: normalized.crlf },
				});
			}
		} catch (error) {
			parseErrors.push(`${file}: ${String((error as Error).message ?? error)}`);
		}
	}

	const totalReplacements = changes.reduce((sum, change) => sum + change.count, 0);
	if (changes.length === 0) {
		const notes = [`No rewrites matched (${filesSearched} files parsed).`];
		if (parseErrors.length > 0) notes.push(`Parse issues: ${parseErrors.slice(0, 3).join("; ")}`);
		notes.push("Parse issues = query failure, not absence — fix the pattern or tighten paths before concluding no matches.");
		return textResult(notes.join("\n"));
	}

	const applying = params.apply === true;
	const out: string[] = [];
	out.push(
		applying
			? `APPLIED ${totalReplacements} replacement(s) in ${changes.length} file(s):`
			: `PREVIEW — ${totalReplacements} replacement(s) in ${changes.length} file(s). No files written. Re-issue the same call with "apply": true to write.`,
	);

	const fileDetails: Array<{ path: string; tag?: string; count: number; diff: string }> = [];
	for (const change of changes) {
		const shownPath = displayPath(change.file, cwd);
		const diff = cappedDiff(change.before, change.after);
		let tag: string | undefined;
		if (applying) {
			await fs.writeFile(change.file, denormalizeText(change.after, change.encoding), "utf8");
			tag = snapshots.record(change.file, change.after);
			out.push(`\n[${shownPath}#${tag}] ${change.count} replacement(s)`);
		} else {
			out.push(`\n${shownPath} — ${change.count} replacement(s)`);
		}
		out.push(diff);
		fileDetails.push({ path: shownPath, tag, count: change.count, diff });
	}
	if (parseErrors.length > 0) {
		out.push(`\n${parseErrors.length} file(s) failed to parse: ${parseErrors.slice(0, 3).join("; ")}`);
	}
	return textResult(capOutput(out.join("\n")).text, {
		applied: applying,
		totalReplacements,
		files: fileDetails,
		parseErrors: parseErrors.slice(0, 5),
	});
}
