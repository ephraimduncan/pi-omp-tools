/**
 * `find` tool: glob-based path lookup. Respects .gitignore by default (via
 * ripgrep's file walker), falls back to tinyglobby. Results newest-first;
 * directories end with `/`.
 */
import * as path from "node:path";
import { glob } from "tinyglobby";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import {
	displayPath,
	hasBinary,
	hasGlobMagic,
	resolvePath,
	run,
	splitGlobEntry,
	splitPathList,
	statOrNull,
} from "../shared/util.ts";

export interface FindParams {
	path?: string;
	hidden?: boolean;
	gitignore?: boolean;
	limit?: number;
}

const DEFAULT_LIMIT = 200;
const STAT_CAP = 3000;

interface Candidate {
	abs: string;
	isDir: boolean;
	mtime: number;
}

async function ripgrepFiles(
	patterns: string[],
	roots: string[],
	hidden: boolean,
	gitignore: boolean,
	signal?: AbortSignal,
): Promise<string[]> {
	// rg -g globs match the path as printed, so scan each root with cwd=root
	// and relative output, then absolutize.
	const found: string[] = [];
	for (const root of roots) {
		const args = ["--files", "-g", "!.git"];
		if (hidden) args.push("--hidden");
		if (!gitignore) args.push("--no-ignore");
		for (const pattern of patterns) args.push("-g", pattern);
		const result = await run("rg", args, { cwd: root, signal, timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });
		if (result.code === 2 && !result.stdout.trim()) {
			throw new ToolError(`rg --files error: ${result.stderr.trim().split("\n")[0] ?? "unknown"}`);
		}
		for (const line of result.stdout.split("\n")) {
			if (line) found.push(path.resolve(root, line));
		}
	}
	return found;
}

export async function executeFind(params: FindParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 2000));
	const hidden = params.hidden !== false;
	const gitignore = params.gitignore !== false;
	const entries = splitPathList(params.path ?? ".");

	// Each glob entry is anchored at its own static base dir so absolute and
	// `~` globs work; plain directory entries scan fully.
	const globsByBase = new Map<string, string[]>();
	const roots: string[] = [];
	const directHits: string[] = [];

	for (const entry of entries) {
		const split = splitGlobEntry(entry, cwd);
		if (split) {
			if (!(await statOrNull(split.base))?.isDirectory()) {
				throw new ToolError(`Glob base directory not found: ${split.base} (from ${entry})`);
			}
			globsByBase.set(split.base, [...(globsByBase.get(split.base) ?? []), split.glob]);
			continue;
		}
		const abs = resolvePath(entry, cwd);
		const stat = await statOrNull(abs);
		if (!stat) throw new ToolError(`Not found: ${entry}`);
		if (stat.isDirectory()) roots.push(abs);
		else directHits.push(abs);
	}
	if (globsByBase.size === 0 && roots.length === 0 && directHits.length === 0) roots.push(cwd);

	const found: string[] = [];
	const useRg = await hasBinary("rg");
	const scan = async (base: string, patterns: string[]): Promise<void> => {
		if (useRg) {
			found.push(...(await ripgrepFiles(patterns, [base], hidden, gitignore, signal)));
		} else {
			const matches = await glob(patterns.length > 0 ? patterns : ["**/*"], {
				cwd: base,
				dot: hidden,
				onlyFiles: false,
				ignore: ["**/.git/**", "**/node_modules/**"],
				absolute: true,
			});
			found.push(...matches);
		}
	};
	for (const [base, patterns] of globsByBase) await scan(base, patterns);
	for (const root of roots) await scan(root, []);
	found.push(...directHits);

	// Dedup + stat (newest-first ordering, dir detection).
	const unique = [...new Set(found.map(p => path.resolve(cwd, p)))];
	const candidates: Candidate[] = [];
	for (let i = 0; i < unique.length; i++) {
		const abs = unique[i] as string;
		if (i < STAT_CAP) {
			const stat = await statOrNull(abs);
			candidates.push({ abs, isDir: stat?.isDirectory() ?? abs.endsWith("/"), mtime: stat?.mtimeMs ?? 0 });
		} else {
			candidates.push({ abs, isDir: false, mtime: 0 });
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);

	const total = candidates.length;
	if (total === 0) {
		const scope = params.path ?? ".";
		const hint = gitignore ? " (gitignored files excluded — retry with gitignore:false)" : "";
		return textResult(`No paths match ${JSON.stringify(scope)}${hint}.`, { total: 0, paths: [] });
	}

	const shown = candidates.slice(0, limit);
	const lines = shown.map(candidate => `${displayPath(candidate.abs, cwd)}${candidate.isDir ? "/" : ""}`);
	const header = `${total} paths (newest first${total > limit ? `, showing ${limit}` : ""})`;
	return textResult([header, ...lines].join("\n"), {
		total,
		paths: shown.map(candidate => ({ path: displayPath(candidate.abs, cwd), isDir: candidate.isDir })),
	});
}
