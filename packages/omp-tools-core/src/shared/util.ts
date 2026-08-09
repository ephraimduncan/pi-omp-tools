/**
 * Shared path, formatting, subprocess, and file-type helpers.
 */
import { execFile } from "node:child_process";
import * as fss from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_OUTPUT_CHARS = 200_000;
export const MAX_LINE_CHARS = 700;
export const DEFAULT_READ_LINES = 2000;

/** Resolve a model-supplied path: strip leading `@`, expand `~`, resolve vs cwd. */
export function resolvePath(p: string, cwd: string): string {
	let cleaned = p.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (cleaned === "~") cleaned = os.homedir();
	else if (cleaned.startsWith("~/")) cleaned = path.join(os.homedir(), cleaned.slice(2));
	return path.resolve(cwd, cleaned);
}

/** Display path: relative to cwd when inside it, else absolute. */
export function displayPath(abs: string, cwd: string): string {
	const rel = path.relative(cwd, abs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
	return rel;
}

export function splitPathList(raw: string): string[] {
	return raw
		.split(";")
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

export function isProbablyBinary(buf: Buffer): boolean {
	const window = buf.subarray(0, 8192);
	for (let i = 0; i < window.length; i++) {
		if (window[i] === 0) return true;
	}
	return false;
}

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function imageMimeFor(p: string): string | undefined {
	return IMAGE_MIME[path.extname(p).toLowerCase()];
}

export const SQLITE_EXTS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);
export const ZIP_EXTS = new Set([".zip", ".jar", ".war", ".ear", ".apk", ".whl", ".ipa", ".xpi", ".vsix"]);
export const TAR_EXTS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz", ".tar"];

export function tarExtOf(p: string): string | undefined {
	const lower = p.toLowerCase();
	return TAR_EXTS.find(ext => lower.endsWith(ext));
}

export function isSqliteFile(abs: string): boolean {
	if (SQLITE_EXTS.has(path.extname(abs).toLowerCase())) return true;
	try {
		const fd = fss.openSync(abs, "r");
		const head = Buffer.alloc(16);
		fss.readSync(fd, head, 0, 16, 0);
		fss.closeSync(fd);
		return head.toString("latin1").startsWith("SQLite format 3");
	} catch {
		return false;
	}
}

export function truncateLine(line: string, max = MAX_LINE_CHARS): string {
	if (line.length <= max) return line;
	return `${line.slice(0, max)} …+${line.length - max} chars`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatHashlineHeader(filePath: string, tag: string): string {
	return `[${filePath}#${tag}]`;
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${truncateLine(line)}`;
}

/** Cap accumulated output at a global character budget. */
export function capOutput(text: string, budget = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
	if (text.length <= budget) return { text, truncated: false };
	return { text: `${text.slice(0, budget)}\n… output truncated (${text.length} chars total)`, truncated: true };
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export function run(
	command: string,
	args: string[],
	options: { cwd?: string; signal?: AbortSignal; maxBuffer?: number; input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	return new Promise(resolve => {
		const child = execFile(
			command,
			args,
			{
				cwd: options.cwd,
				signal: options.signal,
				maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
				timeout: options.timeoutMs ?? 60_000,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
						? ((error as unknown as { code: number }).code as number)
						: error
							? 1
							: 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
		if (options.input !== undefined && child.stdin) {
			child.stdin.write(options.input);
			child.stdin.end();
		}
	});
}

const binaryCache = new Map<string, boolean>();

export async function hasBinary(name: string): Promise<boolean> {
	const cached = binaryCache.get(name);
	if (cached !== undefined) return cached;
	const probe = process.platform === "win32" ? "where" : "which";
	const result = await run(probe, [name], { timeoutMs: 5000 });
	const ok = result.code === 0 && result.stdout.trim().length > 0;
	binaryCache.set(name, ok);
	return ok;
}

export async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function statOrNull(p: string): Promise<fss.Stats | null> {
	try {
		return await fs.stat(p);
	} catch {
		return null;
	}
}

/** Normalize text for editing: strip BOM, convert CRLF to LF. */
export function normalizeText(raw: string): { text: string; hadBom: boolean; crlf: boolean } {
	let text = raw;
	const hadBom = text.charCodeAt(0) === 0xfeff;
	if (hadBom) text = text.slice(1);
	const crlfCount = (text.match(/\r\n/g) ?? []).length;
	const lfCount = (text.match(/(?<!\r)\n/g) ?? []).length;
	const crlf = crlfCount > 0 && crlfCount >= lfCount;
	if (crlfCount > 0) text = text.replace(/\r\n/g, "\n");
	return { text, hadBom, crlf };
}

export function denormalizeText(text: string, opts: { hadBom: boolean; crlf: boolean }): string {
	let out = text;
	if (opts.crlf) out = out.replace(/\n/g, "\r\n");
	if (opts.hadBom) out = `\uFEFF${out}`;
	return out;
}
