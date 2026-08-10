/**
 * `search` tool: regex over files, globs, and directories via ripgrep
 * (JS walker fallback). Output is grouped per file under `[path#TAG]`
 * hashline headers so matched line numbers can anchor `edit` patches.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { snapshots } from "../shared/snapshots.ts";
import {
	capOutput,
	displayPath,
	formatNumberedLine,
	truncateLine,
	hasBinary,
	isProbablyBinary,
	normalizeText,
	pathExists,
	resolvePath,
	run,
	splitGlobEntry,
	splitPathList,
	statOrNull,
} from "../shared/util.ts";

export interface SearchParams {
	pattern: string;
	path?: string;
	case?: boolean;
	literal?: boolean;
	context?: number;
	gitignore?: boolean;
	multiline?: boolean;
	skip?: number;
}

const FILE_LIMIT = 20;
const PER_FILE_MATCHES = 20;
const SINGLE_FILE_MATCHES = 200;
const TAG_MAX_BYTES = 2 * 1024 * 1024;

interface FileMatches {
	file: string;
	lines: Map<number, { text: string; isMatch: boolean }>;
	matchCount: number;
	truncated: boolean;
}

interface SearchTarget {
	root: string;
	glob?: string;
	ranges?: Array<{ start: number; end: number }>;
}

async function parseTargets(rawPath: string | undefined, cwd: string): Promise<SearchTarget[]> {
	const entries = splitPathList(rawPath ?? ".");
	const targets: SearchTarget[] = [];
	for (const entry of entries) {
		const abs = resolvePath(entry, cwd);
		if (await pathExists(abs)) {
			targets.push({ root: abs });
			continue;
		}
		// Line selector on a single file: src/foo.ts:50-100[,200-300]
		const selectorMatch = /^(.*):((?:\d+(?:[+\-]\d*)?)(?:,\d+(?:[+\-]\d*)?)*)$/.exec(entry);
		if (selectorMatch) {
			const baseAbs = resolvePath(selectorMatch[1] as string, cwd);
			if (await pathExists(baseAbs)) {
				const ranges: Array<{ start: number; end: number }> = [];
				for (const part of (selectorMatch[2] as string).split(",")) {
					const rangeMatch = /^(\d+)(?:-(\d+)?|\+(\d+))?$/.exec(part);
					if (!rangeMatch) continue;
					const start = Number.parseInt(rangeMatch[1] as string, 10);
					const end = rangeMatch[3]
						? start + Number.parseInt(rangeMatch[3], 10) - 1
						: rangeMatch[2]
							? Number.parseInt(rangeMatch[2], 10)
							: part.includes("-")
								? Number.MAX_SAFE_INTEGER
								: start;
					ranges.push({ start, end });
				}
				targets.push({ root: baseAbs, ranges });
				continue;
			}
		}
		// Glob: anchor at its static base dir so absolute/~ globs match rg's
		// relative printed paths.
		const split = splitGlobEntry(entry, cwd);
		if (split) {
			// A glob whose base dir does not exist matches nothing, like any glob.
			if ((await statOrNull(split.base))?.isDirectory()) targets.push({ root: split.base, glob: split.glob });
			continue;
		}
		throw new ToolError(`Search root not found: ${entry}`);
	}
	return targets;
}

async function ripgrepSearch(
	params: SearchParams,
	targets: SearchTarget[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<Map<string, FileMatches>> {
	const baseArgs = ["--json", "--no-messages", "--regexp", params.pattern];
	if (params.literal) baseArgs.push("--fixed-strings");
	if (params.case === true) baseArgs.push("--case-sensitive");
	else baseArgs.push("--smart-case");
	if (params.gitignore === false) baseArgs.push("--no-ignore");
	baseArgs.push("--hidden", "-g", "!.git");
	if (params.multiline || /\\n|\n/.test(params.pattern)) baseArgs.push("--multiline", "--multiline-dotall");
	if (params.context && params.context > 0) baseArgs.push("-C", String(Math.min(params.context, 10)));
	baseArgs.push("--max-count", String(SINGLE_FILE_MATCHES), "--max-filesize", "16M");

	// rg -g globs match the path as printed: scan directory roots with
	// cwd=root (relative output) and per-root -g filters; file roots become
	// absolute positionals.
	const runs: Array<{ cwd: string; positional: string[]; base: string; extraArgs: string[] }> = [];
	const byRoot = new Map<string, string[]>();
	for (const target of targets) {
		const existing = byRoot.get(target.root);
		if (target.glob) byRoot.set(target.root, [...(existing ?? []), target.glob]);
		else if (!existing) byRoot.set(target.root, []);
	}
	for (const [root, rootGlobs] of byRoot) {
		const stat = await statOrNull(root);
		const extraArgs = rootGlobs.flatMap(glob => ["-g", glob]);
		if (stat?.isDirectory()) runs.push({ cwd: root, positional: ["."], base: root, extraArgs });
		else runs.push({ cwd, positional: [root], base: "", extraArgs: [] });
	}

	let stdout = "";
	let sawError = "";
	for (const invocation of runs) {
		const result = await run("rg", [...baseArgs, ...invocation.extraArgs, ...invocation.positional], {
			cwd: invocation.cwd,
			signal,
			timeoutMs: 30_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		// rg exit codes: 0 = matches, 1 = no matches, 2 = error (may still have partial output)
		if (result.code === 2 && !result.stdout.trim()) sawError = result.stderr.trim().split("\n")[0] ?? "unknown";
		// Absolutize relative paths inline while parsing below via `base`.
		for (const line of result.stdout.split("\n")) {
			if (line) stdout += `${invocation.base}\u0000${line}\n`;
		}
	}
	if (!stdout && sawError) {
		throw new ToolError(`ripgrep error: ${sawError}`);
	}

	const files = new Map<string, FileMatches>();
	for (const prefixed of stdout.split("\n")) {
		const sep = prefixed.indexOf("\u0000");
		if (sep === -1) continue;
		const base = prefixed.slice(0, sep);
		const line = prefixed.slice(sep + 1);
		if (!line) continue;
		let event: {
			type: string;
			data: {
				path?: { text?: string };
				line_number?: number;
				lines?: { text?: string };
			};
		};
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "match" && event.type !== "context") continue;
		const rawFilePath = event.data.path?.text;
		const lineNumber = event.data.line_number;
		if (!rawFilePath || lineNumber === undefined) continue;
		const filePath = base ? path.resolve(base, rawFilePath) : rawFilePath;
		let entry = files.get(filePath);
		if (!entry) {
			entry = { file: filePath, lines: new Map(), matchCount: 0, truncated: false };
			files.set(filePath, entry);
		}
		const text = (event.data.lines?.text ?? "").replace(/\n$/, "");
		const isMatch = event.type === "match";
		const existing = entry.lines.get(lineNumber);
		entry.lines.set(lineNumber, { text, isMatch: isMatch || (existing?.isMatch ?? false) });
		if (isMatch) entry.matchCount++;
	}
	return files;
}

async function jsFallbackSearch(
	params: SearchParams,
	targets: SearchTarget[],
	cwd: string,
): Promise<Map<string, FileMatches>> {
	const flags = params.case === true ? "g" : "gi";
	let regex: RegExp;
	try {
		regex = params.literal
			? new RegExp(params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
			: new RegExp(params.pattern, flags);
	} catch (error) {
		throw new ToolError(`Invalid regex: ${String(error)}`);
	}
	const files = new Map<string, FileMatches>();
	const skipDirs = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "__pycache__"]);

	const visit = async (abs: string, depth: number): Promise<void> => {
		if (files.size > 200 || depth > 12) return;
		const stat = await statOrNull(abs);
		if (!stat) return;
		if (stat.isDirectory()) {
			if (skipDirs.has(path.basename(abs))) return;
			for (const entry of await fs.readdir(abs).catch(() => [] as string[])) {
				await visit(path.join(abs, entry), depth + 1);
			}
			return;
		}
		if (stat.size > 4 * 1024 * 1024) return;
		const buffer = await fs.readFile(abs).catch(() => null);
		if (!buffer || isProbablyBinary(buffer)) return;
		const lines = buffer.toString("utf8").split("\n");
		const entry: FileMatches = { file: abs, lines: new Map(), matchCount: 0, truncated: false };
		for (let i = 0; i < lines.length; i++) {
			regex.lastIndex = 0;
			if (regex.test(lines[i] as string)) {
				entry.lines.set(i + 1, { text: lines[i] as string, isMatch: true });
				entry.matchCount++;
				if (entry.matchCount >= SINGLE_FILE_MATCHES) break;
			}
		}
		if (entry.matchCount > 0) files.set(abs, entry);
	};
	for (const target of targets) await visit(target.root, 0);
	return files;
}

export async function executeSearch(params: SearchParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const targets = await parseTargets(params.path, cwd);

	const files = (await hasBinary("rg"))
		? await ripgrepSearch(params, targets, cwd, signal)
		: await jsFallbackSearch(params, targets, cwd);

	// Line-range filters from single-file selectors.
	for (const target of targets) {
		if (!target.ranges) continue;
		const entry = files.get(target.root);
		if (!entry) continue;
		for (const lineNumber of [...entry.lines.keys()]) {
			const inRange = target.ranges.some(range => lineNumber >= range.start && lineNumber <= range.end);
			if (!inRange) {
				const line = entry.lines.get(lineNumber);
				if (line?.isMatch) entry.matchCount--;
				entry.lines.delete(lineNumber);
			}
		}
		if (entry.matchCount <= 0) files.delete(target.root);
	}

	const totalFiles = files.size;
	const totalMatches = [...files.values()].reduce((sum, file) => sum + file.matchCount, 0);
	if (totalFiles === 0) {
		return textResult(`No matches for ${JSON.stringify(params.pattern)}.`, {
			pattern: params.pattern,
			files: [],
			summary: "no matches",
		});
	}

	const skip = Math.max(0, params.skip ?? 0);
	const ordered = [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
	const page = ordered.slice(skip, skip + FILE_LIMIT);
	const singleFile = totalFiles === 1;
	const perFileCap = singleFile ? SINGLE_FILE_MATCHES : PER_FILE_MATCHES;

	const out: string[] = [];
	const fileDetails: Array<{
		path: string;
		tag?: string;
		rows: Array<{ n: number; text: string; isMatch: boolean }>;
		more: number;
	}> = [];
	for (const fileEntry of page) {
		const shownPath = displayPath(fileEntry.file, cwd);
		let header = `[${shownPath}]`;
		let tag: string | undefined;
		const stat = await statOrNull(fileEntry.file);
		if (stat && stat.size <= TAG_MAX_BYTES) {
			const buffer = await fs.readFile(fileEntry.file).catch(() => null);
			if (buffer && !isProbablyBinary(buffer)) {
				tag = snapshots.record(fileEntry.file, normalizeText(buffer.toString("utf8")).text);
				header = `[${shownPath}#${tag}]`;
			}
		}
		out.push(header);
		const detail = { path: shownPath, tag, rows: [] as Array<{ n: number; text: string; isMatch: boolean }>, more: 0 };
		fileDetails.push(detail);
		const lineNumbers = [...fileEntry.lines.keys()].sort((a, b) => a - b);
		let emittedMatches = 0;
		let previousLine = 0;
		for (const lineNumber of lineNumbers) {
			const line = fileEntry.lines.get(lineNumber) as { text: string; isMatch: boolean };
			if (line.isMatch && emittedMatches >= perFileCap) {
				detail.more = fileEntry.matchCount - emittedMatches;
				out.push(`… ${fileEntry.matchCount - emittedMatches} more matches in this file`);
				break;
			}
			if (previousLine > 0 && lineNumber > previousLine + 1) out.push("…");
			out.push(formatNumberedLine(lineNumber, line.text));
			detail.rows.push({ n: lineNumber, text: truncateLine(line.text), isMatch: line.isMatch });
			previousLine = lineNumber;
			if (line.isMatch) emittedMatches++;
		}
		out.push("");
	}

	const summary: string[] = [`${totalMatches} matches in ${totalFiles} files`];
	if (skip > 0 || totalFiles > skip + page.length) {
		summary.push(`showing files ${skip + 1}-${skip + page.length}; next: skip=${skip + page.length}`);
	}
	out.push(summary.join(" — "));
	return textResult(capOutput(out.join("\n")).text, {
		pattern: params.pattern,
		literal: params.literal === true,
		caseSensitive: params.case === true,
		files: fileDetails,
		summary: summary.join(" — "),
	});
}
