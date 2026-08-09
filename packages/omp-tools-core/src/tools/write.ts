/**
 * `write` tool: create or overwrite a file, a zip archive entry, or a SQLite
 * row (`db.sqlite:table` insert, `db.sqlite:table:key` update/delete).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { snapshots } from "../shared/snapshots.ts";
import { assertSafeIdentifier, sqliteDriver } from "../shared/sqlite.ts";
import {
	displayPath,
	formatBytes,
	hasBinary,
	isSqliteFile,
	normalizeText,
	pathExists,
	resolvePath,
	run,
	tarExtOf,
	ZIP_EXTS,
} from "../shared/util.ts";

async function writeZipEntry(archiveAbs: string, member: string, content: string, shownPath: string): Promise<ToolResult> {
	if (!(await hasBinary("zip"))) throw new ToolError("`zip` CLI is required to write archive entries.");
	if (member.includes("..")) throw new ToolError("Archive member paths must not contain `..`.");
	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-zip-"));
	try {
		const memberAbs = path.join(staging, member);
		await fs.mkdir(path.dirname(memberAbs), { recursive: true });
		await fs.writeFile(memberAbs, content, "utf8");
		const result = await run("zip", ["-X", archiveAbs, member], { cwd: staging });
		if (result.code !== 0) throw new ToolError(`zip failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return textResult(`Wrote ${shownPath}:${member} (${formatBytes(Buffer.byteLength(content))})`);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

async function writeTarEntry(archiveAbs: string, member: string, content: string, shownPath: string): Promise<ToolResult> {
	const ext = tarExtOf(archiveAbs.toLowerCase());
	if (ext !== ".tar") {
		throw new ToolError("Only uncompressed .tar archives support entry writes (append). Recreate compressed archives instead.");
	}
	if (member.includes("..")) throw new ToolError("Archive member paths must not contain `..`.");
	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-tar-"));
	try {
		const memberAbs = path.join(staging, member);
		await fs.mkdir(path.dirname(memberAbs), { recursive: true });
		await fs.writeFile(memberAbs, content, "utf8");
		const result = await run("tar", ["-rf", archiveAbs, "-C", staging, member]);
		if (result.code !== 0) throw new ToolError(`tar append failed: ${result.stderr.trim()}`);
		return textResult(`Appended ${shownPath}:${member} (last entry wins on extraction)`);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

async function writeSqliteRow(
	dbAbs: string,
	selectors: string[],
	content: string,
	shownPath: string,
): Promise<ToolResult> {
	const driver = await sqliteDriver();
	if (!driver) throw new ToolError("No SQLite driver available (needs node:sqlite, bun:sqlite, or the sqlite3 CLI).");
	const table = assertSafeIdentifier(selectors[0] as string);
	const key = selectors.length > 1 ? selectors.slice(1).join(":") : undefined;

	const schema = await driver.query(dbAbs, `PRAGMA table_info("${table}")`);
	if (schema.length === 0) throw new ToolError(`No such table in ${shownPath}: ${table}`);
	const pkColumn = String(schema.find(col => col.pk)?.name ?? "rowid");

	if (key !== undefined && content.trim() === "") {
		const result = await driver.exec(dbAbs, `DELETE FROM "${table}" WHERE "${pkColumn}" = ?`, [key]);
		return textResult(`Deleted ${result.changes} row(s) from ${shownPath}:${table} where ${pkColumn}=${key}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(`SQLite row content must be JSON (object or array of objects): ${String(error)}`);
	}

	const rows = Array.isArray(parsed) ? parsed : [parsed];
	for (const row of rows) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new ToolError("Each SQLite row must be a JSON object of column -> value.");
		}
	}

	if (key !== undefined) {
		const row = rows[0] as Record<string, unknown>;
		const columns = Object.keys(row).map(assertSafeIdentifier);
		if (columns.length === 0) throw new ToolError("Update content has no columns.");
		const setSql = columns.map(col => `"${col}" = ?`).join(", ");
		const result = await driver.exec(dbAbs, `UPDATE "${table}" SET ${setSql} WHERE "${pkColumn}" = ?`, [
			...columns.map(col => (row as Record<string, unknown>)[col]),
			key,
		]);
		return textResult(`Updated ${result.changes} row(s) in ${shownPath}:${table} where ${pkColumn}=${key}`);
	}

	let inserted = 0;
	for (const rowValue of rows) {
		const row = rowValue as Record<string, unknown>;
		const columns = Object.keys(row).map(assertSafeIdentifier);
		if (columns.length === 0) throw new ToolError("Insert content has no columns.");
		const columnsSql = columns.map(col => `"${col}"`).join(", ");
		const placeholders = columns.map(() => "?").join(", ");
		await driver.exec(dbAbs, `INSERT INTO "${table}" (${columnsSql}) VALUES (${placeholders})`, columns.map(col => row[col]));
		inserted++;
	}
	return textResult(`Inserted ${inserted} row(s) into ${shownPath}:${table}`);
}

export async function executeWrite(rawPath: string, content: string, ctx?: ToolCtx): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const trimmed = rawPath.trim().replace(/^@/, "");

	// Selector routing: archive entries and sqlite rows name an EXISTING container.
	const segments = trimmed.split(":");
	for (let cut = 1; cut < Math.min(segments.length, 4); cut++) {
		const base = segments.slice(0, segments.length - cut).join(":");
		if (!base) break;
		const abs = resolvePath(base, cwd);
		if (!(await pathExists(abs))) continue;
		const selectors = segments.slice(segments.length - cut);
		const shownPath = displayPath(abs, cwd);
		if (isSqliteFile(abs)) return writeSqliteRow(abs, selectors, content, shownPath);
		if (ZIP_EXTS.has(path.extname(abs.toLowerCase()))) {
			return writeZipEntry(abs, selectors.join(":"), content, shownPath);
		}
		if (tarExtOf(abs.toLowerCase())) return writeTarEntry(abs, selectors.join(":"), content, shownPath);
		break; // existing plain file with ':' in trailing segment -> treat whole path as file below
	}

	const abs = resolvePath(trimmed, cwd);
	const shownPath = displayPath(abs, cwd);
	const existed = await pathExists(abs);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
	if (content.startsWith("#!")) {
		await fs.chmod(abs, 0o755).catch(() => undefined);
	}

	const normalized = normalizeText(content);
	const tag = snapshots.record(abs, normalized.text);
	const contentLines = normalized.text.length === 0 ? [] : normalized.text.replace(/\n$/, "").split("\n");
	const lineCount = contentLines.length;
	return textResult(
		`[${shownPath}#${tag}] ${existed ? "overwrote" : "created"} — ${lineCount} lines, ${formatBytes(Buffer.byteLength(content))}${
			content.startsWith("#!") ? " (made executable)" : ""
		}`,
		{
			path: shownPath,
			tag,
			existed,
			lineCount,
			rows: contentLines.slice(0, 400).map((text, index) => ({ n: index + 1, text })),
		},
	);
}
