/**
 * File enumeration shared by ast_grep / ast_edit: expands files, dirs, and
 * globs (gitignore-aware via ripgrep, tinyglobby fallback).
 */
import * as path from "node:path";
import { glob } from "tinyglobby";
import { ToolError } from "../host.ts";
import { hasBinary, resolvePath, run, statOrNull } from "./util.ts";

export async function collectFiles(entries: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	const roots: string[] = [];
	const globPatterns: string[] = [];
	const direct: string[] = [];

	for (const entry of entries) {
		if (/[*?[{]/.test(entry)) {
			globPatterns.push(entry);
			continue;
		}
		const abs = resolvePath(entry, cwd);
		const stat = await statOrNull(abs);
		if (!stat) throw new ToolError(`Path not found: ${entry}`);
		if (stat.isDirectory()) roots.push(abs);
		else direct.push(abs);
	}

	const found: string[] = [...direct];
	if (roots.length > 0 || globPatterns.length > 0) {
		if (await hasBinary("rg")) {
			for (const root of roots.length > 0 ? roots : [cwd]) {
				const args = ["--files", "--hidden", "-g", "!.git"];
				for (const pattern of globPatterns) args.push("-g", pattern.includes("/") ? pattern : `**/${pattern}`);
				const result = await run("rg", args, { cwd: root, signal, timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });
				for (const line of result.stdout.split("\n")) {
					if (line) found.push(path.resolve(root, line));
				}
			}
		} else {
			const patterns = globPatterns.length > 0 ? globPatterns : ["**/*"];
			for (const root of roots.length > 0 ? roots : [cwd]) {
				const matches = await glob(patterns, {
					cwd: root,
					dot: true,
					onlyFiles: true,
					ignore: ["**/.git/**", "**/node_modules/**"],
					absolute: true,
				});
				found.push(...matches);
			}
		}
	}
	return [...new Set(found.map(p => path.resolve(cwd, p)))];
}
