/**
 * `read` tool: files, dirs, archives, SQLite, PDFs, notebooks, and URLs
 * through one `path`, with `:selector` suffixes (ranges, :raw, sqlite
 * table/key, archive members).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import { snapshots } from "../shared/snapshots.ts";
import { assertReadonlySql, assertSafeIdentifier, sqliteDriver, type Row } from "../shared/sqlite.ts";
import {
	capOutput,
	DEFAULT_READ_LINES,
	displayPath,
	formatBytes,
	formatNumberedLine,
	hasBinary,
	imageMimeFor,
	isProbablyBinary,
	isSqliteFile,
	normalizeText,
	pathExists,
	resolvePath,
	run,
	statOrNull,
	tarExtOf,
	ZIP_EXTS,
} from "../shared/util.ts";

interface LineRange {
	start: number;
	end: number; // Infinity = to EOF
}

interface TextSelector {
	ranges: LineRange[];
	raw: boolean;
}

const RANGE_PART_RE = /^([1-9]\d*)(?:-([1-9]\d*)?|\+([1-9]\d*))?$/;

function parseRangeSelector(sel: string): LineRange[] | null {
	const ranges: LineRange[] = [];
	for (const part of sel.split(",")) {
		const match = RANGE_PART_RE.exec(part.trim());
		if (!match) return null;
		const start = Number.parseInt(match[1] as string, 10);
		let end: number;
		if (match[3]) end = start + Number.parseInt(match[3], 10) - 1;
		else if (match[2]) end = Number.parseInt(match[2], 10);
		else if (part.includes("-")) end = Number.POSITIVE_INFINITY;
		else end = start;
		if (end < start) return null;
		ranges.push({ start, end });
	}
	return ranges.length > 0 ? ranges : null;
}

function parseTextSelectors(selectors: string[]): TextSelector | null {
	const result: TextSelector = { ranges: [], raw: false };
	for (const sel of selectors) {
		if (sel === "raw") {
			result.raw = true;
			continue;
		}
		const ranges = parseRangeSelector(sel);
		if (!ranges) return null;
		result.ranges.push(...ranges);
	}
	return result;
}

interface ResolvedTarget {
	abs: string;
	selectors: string[];
	query: URLSearchParams;
}

async function resolveTarget(raw: string, cwd: string): Promise<ResolvedTarget> {
	let query = new URLSearchParams();
	let candidate = raw;

	const asIs = resolvePath(candidate, cwd);
	if (await pathExists(asIs)) return { abs: asIs, selectors: [], query };

	// `?limit=&where=&q=` query attached to the last selector (or the path).
	const questionIndex = candidate.lastIndexOf("?");
	if (questionIndex !== -1) {
		query = new URLSearchParams(candidate.slice(questionIndex + 1));
		candidate = candidate.slice(0, questionIndex);
		const absNoQuery = resolvePath(candidate, cwd);
		if (await pathExists(absNoQuery)) return { abs: absNoQuery, selectors: [], query };
	}

	const segments = candidate.split(":");
	for (let cut = 1; cut < Math.min(segments.length, 4); cut++) {
		const base = segments.slice(0, segments.length - cut).join(":");
		if (!base) break;
		const abs = resolvePath(base, cwd);
		if (await pathExists(abs)) return { abs, selectors: segments.slice(segments.length - cut), query };
	}
	return { abs: asIs, selectors: [], query };
}

export interface DisplayRow {
	n: number;
	text: string;
}

interface SelectedLines {
	text: string;
	rows: DisplayRow[];
	moreLines: number;
	totalLines: number;
}

const DETAIL_ROW_CAP = 400;

function selectLines(
	lines: string[],
	selector: TextSelector | null,
	limit: number,
	shownPath: string,
	tag: string | undefined,
): SelectedLines {
	const total = lines.length;
	const ranges: LineRange[] =
		selector && selector.ranges.length > 0 ? selector.ranges : [{ start: 1, end: Number.POSITIVE_INFINITY }];

	const out: string[] = [];
	const rows: DisplayRow[] = [];
	out.push(tag ? `[${shownPath}#${tag}]` : `[${shownPath}]`);
	let emitted = 0;
	let truncatedAt: number | null = null;
	let previousEnd = 0;

	for (const range of ranges) {
		const start = Math.max(1, range.start);
		const end = Math.min(total, range.end === Number.POSITIVE_INFINITY ? total : range.end);
		if (start > total) continue;
		if (previousEnd > 0 && start > previousEnd + 1) out.push("…");
		for (let line = Math.max(start, previousEnd + 1); line <= end; line++) {
			if (emitted >= limit) {
				truncatedAt = line;
				break;
			}
			out.push(formatNumberedLine(line, lines[line - 1] as string));
			if (rows.length < DETAIL_ROW_CAP) rows.push({ n: line, text: lines[line - 1] as string });
			emitted++;
		}
		previousEnd = Math.max(previousEnd, end);
		if (truncatedAt !== null) break;
	}

	let moreLines = 0;
	if (truncatedAt !== null) {
		moreLines = total - (truncatedAt - 1);
		out.push(`… truncated at line ${truncatedAt - 1} of ${total} — continue with ${shownPath}:${truncatedAt}-`);
	} else if (previousEnd < total && (selector?.ranges.length ?? 0) === 0) {
		moreLines = total - previousEnd;
		out.push(`… ${total - previousEnd} more lines — continue with ${shownPath}:${previousEnd + 1}-`);
	} else if ((selector?.ranges.length ?? 0) > 0) {
		out.push(`(${emitted} of ${total} lines)`);
	}
	return { text: out.join("\n"), rows, moreLines, totalLines: total };
}

/** Structured directory entry passed to renderers via result details. */
interface DirEntryDetail {
	name: string;
	dir?: boolean;
	/** Pre-formatted size ("8.1KB") for plain files. */
	size?: string;
	/** Child count for readable subdirectories. */
	count?: number;
	/** Symlink target. */
	link?: string;
}

async function readDirectory(abs: string, shownPath: string): Promise<ToolResult> {
	const entries = await fs.readdir(abs, { withFileTypes: true });
	entries.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const lines: string[] = [`${shownPath}/ — ${entries.length} entries`];
	const detailEntries: DirEntryDetail[] = [];
	const cap = 400;
	for (const entry of entries.slice(0, cap)) {
		if (entry.isDirectory()) {
			let count = "";
			let childCount: number | undefined;
			try {
				childCount = (await fs.readdir(path.join(abs, entry.name))).length;
				count = ` (${childCount})`;
			} catch {
				/* permission */
			}
			lines.push(`  ${entry.name}/${count}`);
			detailEntries.push({ name: entry.name, dir: true, ...(childCount === undefined ? {} : { count: childCount }) });
		} else if (entry.isSymbolicLink()) {
			const link = await fs.readlink(path.join(abs, entry.name)).catch(() => "?");
			lines.push(`  ${entry.name} -> ${link}`);
			detailEntries.push({ name: entry.name, link });
		} else {
			const stat = await statOrNull(path.join(abs, entry.name));
			lines.push(`  ${entry.name}  ${stat ? formatBytes(stat.size) : ""}`);
			detailEntries.push({ name: entry.name, ...(stat ? { size: formatBytes(stat.size) } : {}) });
		}
	}
	if (entries.length > cap) lines.push(`  … ${entries.length - cap} more entries`);
	return textResult(lines.join("\n"), {
		kind: "dir",
		path: shownPath,
		body: lines.join("\n"),
		entries: detailEntries,
		total: entries.length,
	});
}

function renderRows(rows: Row[], cap = 100): string[] {
	const lines: string[] = [];
	for (const row of rows.slice(0, cap)) {
		const cells = Object.fromEntries(
			Object.entries(row).map(([key, value]) => {
				if (value instanceof Uint8Array) return [key, `<blob ${value.length}B>`];
				if (typeof value === "string" && value.length > 200) return [key, `${value.slice(0, 200)}…`];
				return [key, value];
			}),
		);
		lines.push(JSON.stringify(cells));
	}
	if (rows.length > cap) lines.push(`… ${rows.length - cap} more rows`);
	return lines;
}

async function readSqlite(
	abs: string,
	shownPath: string,
	selectors: string[],
	query: URLSearchParams,
): Promise<ToolResult> {
	const driver = await sqliteDriver();
	if (!driver) {
		throw new ToolError("No SQLite driver available (needs node:sqlite, bun:sqlite, or the sqlite3 CLI).");
	}
	const customSql = query.get("q");
	if (customSql) {
		const rows = await driver.query(abs, assertReadonlySql(customSql));
		{
			const body = [`${shownPath} ?q= — ${rows.length} rows`, ...renderRows(rows)].join("\n");
			return textResult(body, { kind: "sqlite", body });
		}
	}
	if (selectors.length === 0) {
		const tables = await driver.query(
			abs,
			"SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		const lines = [`${shownPath} — ${tables.length} tables`];
		for (const table of tables) {
			const name = String(table.name);
			let count = "?";
			try {
				const countRows = await driver.query(abs, `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
				count = String(countRows[0]?.n ?? "?");
			} catch {
				/* virtual tables etc. */
			}
			lines.push(`  ${name} (${table.type}, ${count} rows)`);
		}
		lines.push(`Next: ${shownPath}:<table> for schema+rows, :<table>:<key> by primary key, ?limit=/?where=/?q=SELECT…`);
		return textResult(lines.join("\n"), { kind: "sqlite", body: lines.join("\n") });
	}

	const table = assertSafeIdentifier(selectors[0] as string);
	const limit = Math.min(Number.parseInt(query.get("limit") ?? "20", 10) || 20, 500);
	const schema = await driver.query(abs, `PRAGMA table_info("${table}")`);
	if (schema.length === 0) throw new ToolError(`No such table in ${shownPath}: ${table}`);
	const columns = schema.map(col => `${col.name} ${col.type}${col.pk ? " PK" : ""}${col.notnull ? " NOT NULL" : ""}`);

	if (selectors.length >= 2) {
		const key = selectors.slice(1).join(":");
		const pkColumn = String(schema.find(col => col.pk)?.name ?? "rowid");
		const rows = await driver.query(abs, `SELECT * FROM "${table}" WHERE "${pkColumn}" = ? LIMIT 5`, [key]);
		if (rows.length === 0) {
			const body = `${shownPath}:${table}: no row with ${pkColumn}=${key}`;
			return textResult(body, { kind: "sqlite", body });
		}
		{
			const body = [`${shownPath}:${table} ${pkColumn}=${key}`, ...renderRows(rows)].join("\n");
			return textResult(body, { kind: "sqlite", body });
		}
	}

	const where = query.get("where");
	const whereSql = where ? ` WHERE ${assertReadonlySqlFragment(where)}` : "";
	const rows = await driver.query(abs, `SELECT * FROM "${table}"${whereSql} LIMIT ${limit}`);
	const lines = [
		`${shownPath}:${table} — columns: ${columns.join(", ")}`,
		`rows (limit ${limit}${where ? `, where ${where}` : ""}):`,
		...renderRows(rows),
	];
	return textResult(lines.join("\n"), { kind: "sqlite", body: lines.join("\n") });
}

function assertReadonlySqlFragment(fragment: string): string {
	if (/;|--|\/\*/.test(fragment)) throw new ToolError("Unsafe characters in ?where= fragment");
	return fragment;
}

async function readZipArchive(abs: string, shownPath: string, member: string | undefined, limit: number): Promise<ToolResult> {
	if (!(await hasBinary("unzip"))) throw new ToolError("`unzip` is required to read zip archives.");
	if (!member) {
		const listing = await run("unzip", ["-l", abs]);
		if (listing.code !== 0) throw new ToolError(`unzip -l failed: ${listing.stderr.trim()}`);
		{
			const body = capOutput(`${shownPath}:\n${listing.stdout.trim()}\nRead a member with ${shownPath}:<member/path>`).text;
			return textResult(body, { kind: "archive", body });
		}
	}
	const extraction = await run("unzip", ["-p", abs, member]);
	if (extraction.code !== 0) {
		throw new ToolError(`Cannot extract ${member} from ${shownPath}: ${extraction.stderr.trim() || "not found"}`);
	}
	return renderArchiveMember(shownPath, member, extraction.stdout, limit);
}

async function readTarArchive(abs: string, shownPath: string, member: string | undefined, limit: number): Promise<ToolResult> {
	if (!member) {
		const listing = await run("tar", ["-tvf", abs]);
		if (listing.code !== 0) throw new ToolError(`tar -tvf failed: ${listing.stderr.trim()}`);
		{
			const body = capOutput(`${shownPath}:\n${listing.stdout.trim()}\nRead a member with ${shownPath}:<member/path>`).text;
			return textResult(body, { kind: "archive", body });
		}
	}
	const extraction = await run("tar", ["-xOf", abs, member]);
	if (extraction.code !== 0) {
		throw new ToolError(`Cannot extract ${member} from ${shownPath}: ${extraction.stderr.trim() || "not found"}`);
	}
	return renderArchiveMember(shownPath, member, extraction.stdout, limit);
}

function renderArchiveMember(shownPath: string, member: string, content: string, limit: number): ToolResult {
	if (content.includes("\u0000")) {
		throw new ToolError(`${shownPath}:${member} is binary (${content.length} bytes).`);
	}
	const lines = normalizeText(content).text.split("\n");
	const selected = selectLines(lines, null, limit, `${shownPath}:${member}`, undefined);
	return textResult(`${selected.text}\n(read-only archive member)`, {
		kind: "text",
		path: `${shownPath}:${member}`,
		rows: selected.rows,
		moreLines: selected.moreLines,
	});
}

async function readPdf(abs: string, shownPath: string, selector: TextSelector | null, limit: number): Promise<ToolResult> {
	if (!(await hasBinary("pdftotext"))) {
		throw new ToolError("`pdftotext` (poppler) is required to read PDFs. Install it or read the file with :raw elsewhere.");
	}
	const conversion = await run("pdftotext", ["-layout", abs, "-"]);
	if (conversion.code !== 0) throw new ToolError(`pdftotext failed: ${conversion.stderr.trim()}`);
	const lines = conversion.stdout.replace(/\f/g, "\n— page break —\n").split("\n");
	const selected = selectLines(lines, selector, limit, shownPath, undefined);
	return textResult(`${selected.text}\n(read-only PDF extraction)`, {
		kind: "text",
		path: shownPath,
		rows: selected.rows,
		moreLines: selected.moreLines,
	});
}

interface NotebookCell {
	cell_type: string;
	source: string[] | string;
	outputs?: Array<{ output_type: string; text?: string[] | string; data?: Record<string, unknown> }>;
}

function renderNotebook(shownPath: string, rawJson: string, limit: number): ToolResult {
	let parsed: { cells?: NotebookCell[] };
	try {
		parsed = JSON.parse(rawJson) as { cells?: NotebookCell[] };
	} catch (error) {
		throw new ToolError(`Invalid notebook JSON in ${shownPath}: ${String(error)}`);
	}
	const cells = parsed.cells ?? [];
	const out: string[] = [`${shownPath} — ${cells.length} cells (read cells; edit via :raw JSON)`];
	let emitted = 0;
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i] as NotebookCell;
		const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
		out.push(`── cell ${i + 1} [${cell.cell_type}] ──`);
		for (const line of source.split("\n")) {
			if (emitted >= limit) break;
			out.push(line);
			emitted++;
		}
		const textOutputs = (cell.outputs ?? [])
			.map(output => {
				if (output.text) return Array.isArray(output.text) ? output.text.join("") : output.text;
				const data = output.data?.["text/plain"];
				if (data) return Array.isArray(data) ? data.join("") : String(data);
				return "";
			})
			.filter(Boolean);
		if (textOutputs.length > 0) {
			out.push(`  ▸ output: ${textOutputs.join("").split("\n").slice(0, 5).join("\n  ")}`);
		}
		if (emitted >= limit) {
			out.push(`… truncated at cell ${i + 1} of ${cells.length}`);
			break;
		}
	}
	return textResult(capOutput(out.join("\n")).text, { kind: "notebook", body: out.join("\n") });
}

function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
	text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
	text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "\n- ");
	text = text.replace(/<[^>]+>/g, "");
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/gi, "'");
	text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return titleMatch ? `# ${titleMatch[1]?.trim()}\n\n${text}` : text;
}

/**
 * Split a trailing `:raw` / `:ranges` selector off a URL. Handles bare
 * domains (`https://example.com:raw`), trailing slashes
 * (`https://example.com/:raw`), and paths (`https://x.com/p:10-20`).
 * A purely numeric tail on a path-less URL stays a port
 * (`https://host:8080`); add a trailing slash to disambiguate
 * (`https://host:8080/:50` selects lines).
 */
export function parseUrlTarget(rawUrl: string): { url: string; selector: TextSelector | null } {
	const selectorMatch = /^(.*):((?:raw)(?::[\d+,\-]+)?|[\d]+(?:[+\-,][\d,+\-]*)?(?::raw)?)$/.exec(rawUrl);
	if (!selectorMatch) return { url: rawUrl, selector: null };
	const prefix = selectorMatch[1] as string;
	const tail = selectorMatch[2] as string;
	let parsed: URL;
	try {
		parsed = new URL(prefix);
	} catch {
		return { url: rawUrl, selector: null };
	}
	// `https://host:8080` — a purely numeric tail with no path is a port.
	if (/^\d+$/.test(tail) && parsed.pathname === "/" && !prefix.endsWith("/")) {
		return { url: rawUrl, selector: null };
	}
	const selector = parseTextSelectors(tail.split(":"));
	if (!selector) return { url: rawUrl, selector: null };
	return { url: prefix, selector };
}

async function readUrl(rawUrl: string, limit: number, signal?: AbortSignal): Promise<ToolResult> {
	const target = parseUrlTarget(rawUrl);
	const url = target.url;
	const selector = target.selector;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	signal?.addEventListener("abort", () => controller.abort());
	let response: Response;
	try {
		response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: { "user-agent": "Mozilla/5.0 (compatible; omp-tools)", accept: "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8" },
		});
	} catch (error) {
		throw new ToolError(`Fetch failed for ${url}: ${String((error as Error).message ?? error)}`);
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${url}`);
	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();
	const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body.slice(0, 256));
	const raw = selector?.raw ?? false;
	const text = isHtml && !raw ? htmlToText(body) : body;
	const lines = text.split("\n");
	if (raw || !selector || selector.ranges.length === 0) {
		const capped = lines.slice(0, limit);
		let output = capped.join("\n");
		if (lines.length > limit) output += `\n… truncated (${lines.length} lines total; use ${url}:${limit + 1}- to continue)`;
		return textResult(capOutput(`${url}\n${output}`).text, { kind: "url", path: url, body: output });
	}
	const selected = selectLines(lines, selector, limit, url, undefined);
	return textResult(capOutput(selected.text).text, { kind: "text", path: url, rows: selected.rows, moreLines: selected.moreLines });
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function executeRead(
	rawPath: string,
	limitParam: number | undefined,
	ctx?: ToolCtx,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const limit = Math.max(1, Math.min(limitParam ?? DEFAULT_READ_LINES, 20_000));
	const trimmed = rawPath.trim().replace(/^@/, "");

	if (/^https?:\/\//i.test(trimmed)) return readUrl(trimmed, limit, signal);

	const target = await resolveTarget(trimmed, cwd);
	const shownPath = displayPath(target.abs, cwd);
	const stat = await statOrNull(target.abs);
	if (!stat) {
		const parent = path.dirname(target.abs);
		let hint = "";
		const parentStat = await statOrNull(parent);
		if (parentStat?.isDirectory()) {
			const siblings = (await fs.readdir(parent).catch(() => [] as string[])).slice(0, 15);
			hint = `\nNearby in ${displayPath(parent, cwd)}/: ${siblings.join(", ")}`;
		}
		throw new ToolError(`Not found: ${shownPath}${hint}`);
	}

	if (stat.isDirectory()) return readDirectory(target.abs, shownPath);

	if (isSqliteFile(target.abs)) return readSqlite(target.abs, shownPath, target.selectors, target.query);

	const lowerPath = target.abs.toLowerCase();
	if (ZIP_EXTS.has(path.extname(lowerPath))) {
		return readZipArchive(target.abs, shownPath, target.selectors.join(":") || undefined, limit);
	}
	if (tarExtOf(lowerPath)) {
		return readTarArchive(target.abs, shownPath, target.selectors.join(":") || undefined, limit);
	}

	const selector = parseTextSelectors(target.selectors);
	if (target.selectors.length > 0 && !selector) {
		throw new ToolError(
			`Unrecognized selector ${JSON.stringify(target.selectors.join(":"))} on ${shownPath}. ` +
				`Supported: :N, :N-M, :N+K, :N-, :a-b,c-d, :raw (and sqlite/archive member selectors on those file types).`,
		);
	}

	if (lowerPath.endsWith(".pdf")) return readPdf(target.abs, shownPath, selector, limit);

	const mime = imageMimeFor(target.abs);
	if (mime) {
		if (stat.size > MAX_IMAGE_BYTES) {
			throw new ToolError(`Image too large: ${shownPath} is ${formatBytes(stat.size)} (max ${formatBytes(MAX_IMAGE_BYTES)}).`);
		}
		const data = await fs.readFile(target.abs);
		return {
			content: [
				{ type: "text", text: `${shownPath} (${mime}, ${formatBytes(stat.size)})` },
				{ type: "image", data: data.toString("base64"), mimeType: mime },
			],
			details: {},
		};
	}

	if (stat.size > MAX_FILE_BYTES) {
		throw new ToolError(`File too large: ${shownPath} is ${formatBytes(stat.size)}. Use search, or read a :range.`);
	}

	const buffer = await fs.readFile(target.abs);
	if (isProbablyBinary(buffer)) {
		throw new ToolError(`Binary file: ${shownPath} (${formatBytes(stat.size)}). Not readable as text.`);
	}

	const raw = buffer.toString("utf8");
	if (lowerPath.endsWith(".ipynb") && !(selector?.raw ?? false)) {
		return renderNotebook(shownPath, raw, limit);
	}

	const normalized = normalizeText(raw);
	if (selector?.raw) {
		const lines = normalized.text.split("\n");
		if (selector.ranges.length > 0) {
			const parts: string[] = [];
			for (const range of selector.ranges) {
				const end = Math.min(lines.length, range.end === Number.POSITIVE_INFINITY ? lines.length : range.end);
				parts.push(lines.slice(range.start - 1, end).join("\n"));
			}
			return textResult(capOutput(parts.join("\n…\n")).text, { kind: "raw", path: shownPath, body: parts.join("\n…\n") });
		}
		return textResult(capOutput(normalized.text).text, { kind: "raw", path: shownPath, body: normalized.text });
	}

	const tag = snapshots.record(target.abs, normalized.text);
	const lines = normalized.text.length === 0 ? [""] : normalized.text.replace(/\n$/, "").split("\n");
	const selected = selectLines(lines, selector, limit, shownPath, tag);
	return textResult(capOutput(selected.text).text, {
		kind: "text",
		path: shownPath,
		tag,
		rows: selected.rows,
		moreLines: selected.moreLines,
		totalLines: selected.totalLines,
	});
}
