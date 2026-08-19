/**
 * File enumeration shared by ast_grep / ast_edit: expands files, dirs, and
 * globs (gitignore-aware via ripgrep, tinyglobby fallback).
 */
import * as path from "node:path";
import { glob } from "tinyglobby";
import picomatch from "picomatch";
import { ToolError } from "../host.ts";
import { hasBinary, resolvePath, rgIgnoreFlags, run, splitGlobEntry, statOrNull } from "./util.ts";

export async function collectFiles(entries: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	// Glob entries anchor at their own static base dir (absolute/~ globs work);
	// plain directory entries scan fully.
	const globsByBase = new Map<string, string[]>();
	const roots: string[] = [];
	const direct: string[] = [];

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
		if (!stat) throw new ToolError(`Path not found: ${entry}`);
		if (stat.isDirectory()) roots.push(abs);
		else direct.push(abs);
	}

	const found: string[] = [...direct];
	const useRg = await hasBinary("rg");
	const scan = async (base: string, patterns: string[]): Promise<void> => {
		if (useRg) {
			// User globs cannot go through rg -g: override globs beat ignore
			// rules (`*` would whitelist gitignored dirs). Filter output instead.
			const matches = patterns.length > 0 ? picomatch(patterns, { dot: true, matchBase: true }) : null;
			const args = ["--files", "--hidden", ...(await rgIgnoreFlags(base)), "-g", "!.git"];
			const result = await run("rg", args, { cwd: base, signal, timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });
			for (const line of result.stdout.split("\n")) {
				if (line && (!matches || matches(line))) found.push(path.resolve(base, line));
			}
		} else {
			const matches = await glob(patterns.length > 0 ? patterns : ["**/*"], {
				cwd: base,
				dot: true,
				onlyFiles: true,
				ignore: ["**/.git/**", "**/node_modules/**"],
				absolute: true,
			});
			// Loop, don't spread: `push(...matches)` overflows the stack past ~100k paths.
			for (const match of matches) found.push(match);
		}
	};
	for (const [base, patterns] of globsByBase) await scan(base, patterns);
	for (const root of roots) await scan(root, []);
	return [...new Set(found.map(p => path.resolve(cwd, p)))];
}
