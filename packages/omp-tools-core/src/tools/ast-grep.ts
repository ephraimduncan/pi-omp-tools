/**
 * `ast_grep` tool: structural code search via ast-grep patterns.
 */
import * as fs from "node:fs/promises";
import { textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { astSearch, availableLangSummary, type AstMatch } from "../shared/astengine.ts";
import { collectFiles } from "../shared/files.ts";
import { snapshots } from "../shared/snapshots.ts";
import {
	capOutput,
	displayPath,
	formatNumberedLine,
	normalizeText,
	splitPathList,
} from "../shared/util.ts";

export interface AstGrepParams {
	pat: string;
	path?: string;
	lang?: string;
	skip?: number;
}

const FILE_LIMIT = 20;
const PER_FILE_MATCHES = 20;
const MAX_MATCH_LINES = 8;

export async function executeAstGrep(params: AstGrepParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const files = await collectFiles(splitPathList(params.path ?? "."), cwd, signal);
	const outcome = await astSearch(params.pat, files, { langFilter: params.lang, signal });

	if (outcome.matches.length === 0) {
		const notes: string[] = [`No matches for pattern ${JSON.stringify(params.pat)} (${outcome.filesSearched} files parsed).`];
		if (outcome.parseErrors.length > 0) {
			notes.push(`Parse issues (query failure, not absence): ${outcome.parseErrors.slice(0, 3).join("; ")}`);
		}
		if (outcome.filesSearched === 0) {
			notes.push(`No parseable files in scope. Supported languages: ${availableLangSummary()}.`);
		}
		return textResult(notes.join("\n"), { pat: params.pat, files: [], summary: notes[0] });
	}

	// Group by file.
	const byFile = new Map<string, AstMatch[]>();
	for (const match of outcome.matches) {
		const list = byFile.get(match.file) ?? [];
		list.push(match);
		byFile.set(match.file, list);
	}
	const orderedFiles = [...byFile.keys()].sort();
	const skip = Math.max(0, params.skip ?? 0);
	const page = orderedFiles.slice(skip, skip + FILE_LIMIT);

	const out: string[] = [];
	const fileDetails: Array<{
		path: string;
		tag?: string;
		rows: Array<{ n: number; text: string; isMatch: boolean }>;
		more: number;
	}> = [];
	for (const file of page) {
		const matches = byFile.get(file) as AstMatch[];
		const shownPath = displayPath(file, cwd);
		let header = `[${shownPath}]`;
		let tag: string | undefined;
		let fileLines: string[] | null = null;
		try {
			const raw = await fs.readFile(file, "utf8");
			const normalized = normalizeText(raw).text;
			tag = snapshots.record(file, normalized);
			header = `[${shownPath}#${tag}]`;
			fileLines = normalized.replace(/\n$/, "").split("\n");
		} catch {
			/* keep tag-less header */
		}
		out.push(header);
		const detail = { path: shownPath, tag, rows: [] as Array<{ n: number; text: string; isMatch: boolean }>, more: 0 };
		fileDetails.push(detail);
		let previousEnd = 0;
		for (const match of matches.slice(0, PER_FILE_MATCHES)) {
			if (previousEnd > 0 && match.startLine > previousEnd + 1) out.push("…");
			const end = Math.min(match.endLine, match.startLine + MAX_MATCH_LINES - 1);
			for (let line = Math.max(match.startLine, previousEnd + 1); line <= end; line++) {
				const text = fileLines ? (fileLines[line - 1] ?? "") : (match.text.split("\n")[line - match.startLine] ?? "");
				out.push(formatNumberedLine(line, text));
				detail.rows.push({ n: line, text, isMatch: true });
			}
			if (end < match.endLine) out.push(`⋮ match continues to line ${match.endLine}`);
			previousEnd = Math.max(previousEnd, end);
		}
		if (matches.length > PER_FILE_MATCHES) {
			detail.more = matches.length - PER_FILE_MATCHES;
			out.push(`… ${matches.length - PER_FILE_MATCHES} more matches in this file`);
		}
		out.push("");
	}

	const summary: string[] = [`${outcome.matches.length} matches in ${byFile.size} files (${outcome.filesSearched} parsed)`];
	if (skip > 0 || orderedFiles.length > skip + page.length) {
		summary.push(`showing files ${skip + 1}-${skip + page.length}; next: skip=${skip + page.length}`);
	}
	if (outcome.parseErrors.length > 0) summary.push(`${outcome.parseErrors.length} files failed to parse`);
	out.push(summary.join(" — "));
	return textResult(capOutput(out.join("\n")).text, {
		pat: params.pat,
		files: fileDetails,
		summary: summary.join(" — "),
	});
}
