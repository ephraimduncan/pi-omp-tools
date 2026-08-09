/**
 * Hashline patch parser (lean port of @oh-my-pi/hashline's language).
 *
 * Grammar (per line):
 *   [PATH#TAG]                      file section header (TAG = 4-hex snapshot tag)
 *   PUT A.=B:                       replace original lines A..B (inclusive) with body rows
 *   PUT A*:                         replace the syntactic block beginning at line A
 *   PUT <A: / PUT >A: / PUT >$:     insert body rows before/after line A (>$ = EOF)
 *   PUT >A*:                        insert body rows after the end of the block at A
 *   PUT <A / PUT >A [@name]         paste register at a gap (no body)
 *   PUT A.=B @name / PUT A* @name   paste register over a range/block (no body)
 *   CUT A.=B [@name] / CUT A* [@name]  delete lines/block, capture into register
 *   REM                             delete the section file
 *   MV DEST                         move/rename the section file
 *   +TEXT                           body row (verbatim after the `+`); `+` alone = blank line
 */
import { ToolError } from "../host.ts";

export type Gap =
	| { kind: "before"; line: number }
	| { kind: "after"; line: number }
	| { kind: "bof" }
	| { kind: "eof" };

export type HashlineOp =
	| { kind: "replace"; start: number; end: number; body: string[] }
	| { kind: "replace_block"; line: number; body: string[] }
	| { kind: "insert"; gap: Gap; body: string[] }
	| { kind: "insert_after_block"; line: number; body: string[] }
	| { kind: "paste_gap"; gap: Gap; register?: string }
	| { kind: "paste_after_block"; line: number; register?: string }
	| { kind: "paste_range"; start: number; end: number; register: string }
	| { kind: "paste_block"; line: number; register: string }
	| { kind: "cut"; start: number; end: number; register?: string }
	| { kind: "cut_block"; line: number; register?: string };

export interface HashlineSection {
	path: string;
	tag?: string;
	ops: HashlineOp[];
	remove: boolean;
	moveTo?: string;
	/** 1-based line in the patch input where this section started (diagnostics). */
	patchLine: number;
}

const HEADER_RE = /^\[(.+?)(?:#([0-9A-Fa-f]{4}))?\]\s*$/;
const RANGE_RE = /^([1-9]\d*)(?:\.=([1-9]\d*))?$/;

function parseError(lineNo: number, line: string, message: string): ToolError {
	return new ToolError(`hashline parse error at patch line ${lineNo} (${JSON.stringify(line)}): ${message}`);
}

interface PendingBody {
	push(row: string): void;
}

export function parsePatch(input: string): HashlineSection[] {
	const sections: HashlineSection[] = [];
	let current: HashlineSection | null = null;
	let body: string[] | null = null;
	let bodyOwner: string | null = null;

	const lines = input.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] as string;
		const lineNo = i + 1;

		if (raw.startsWith("+")) {
			if (!body) {
				throw parseError(
					lineNo,
					raw,
					current
						? `body row outside a \`PUT ...:\` header${bodyOwner ? ` (last op: ${bodyOwner})` : ""} — colonless PUT/CUT/REM/MV take no body rows`
						: "body row before any [PATH#TAG] section header",
				);
			}
			body.push(raw.slice(1));
			continue;
		}

		const headerMatch = HEADER_RE.exec(raw);
		if (headerMatch) {
			current = {
				path: (headerMatch[1] as string).trim(),
				tag: headerMatch[2]?.toUpperCase(),
				ops: [],
				remove: false,
				patchLine: lineNo,
			};
			sections.push(current);
			body = null;
			bodyOwner = null;
			continue;
		}

		if (raw.trim().length === 0) {
			// Blank rows between ops are tolerated; blank body lines must be `+`.
			body = null;
			continue;
		}

		if (!current) {
			throw parseError(lineNo, raw, "expected a [PATH#TAG] section header first");
		}

		const trimmed = raw.trimEnd();
		body = null;
		bodyOwner = null;

		if (trimmed === "REM") {
			current.remove = true;
			continue;
		}
		if (trimmed.startsWith("MV ")) {
			let dest = trimmed.slice(3).trim();
			if ((dest.startsWith('"') && dest.endsWith('"')) || (dest.startsWith("'") && dest.endsWith("'"))) {
				dest = dest.slice(1, -1);
			}
			if (!dest) throw parseError(lineNo, raw, "MV requires a destination path");
			current.moveTo = dest;
			continue;
		}

		const keyword = trimmed.startsWith("PUT ") ? "PUT" : trimmed.startsWith("CUT ") ? "CUT" : null;
		if (!keyword) {
			throw parseError(lineNo, raw, "expected PUT/CUT/REM/MV, a +body row, or a [PATH#TAG] header");
		}

		let rest = trimmed.slice(4).trim();
		const hasColon = rest.endsWith(":");
		if (hasColon) rest = rest.slice(0, -1).trimEnd();

		let register: string | undefined;
		const atIndex = rest.lastIndexOf("@");
		if (atIndex !== -1) {
			const registerName = rest.slice(atIndex + 1).trim();
			if (!/^[A-Za-z0-9_-]+$/.test(registerName)) {
				throw parseError(lineNo, raw, `invalid register name ${JSON.stringify(registerName)}`);
			}
			register = registerName;
			rest = rest.slice(0, atIndex).trim();
		}

		const op = parseLocatorOp(keyword, rest, hasColon, register, lineNo, raw);
		current.ops.push(op);
		if (
			op.kind === "replace" ||
			op.kind === "replace_block" ||
			op.kind === "insert" ||
			op.kind === "insert_after_block"
		) {
			body = op.body;
			bodyOwner = trimmed;
		}
	}

	if (sections.length === 0) {
		throw new ToolError(
			"No hashline sections found. Start with `[path#TAG]` (tag from your latest read/search), then PUT/CUT/REM/MV ops.",
		);
	}
	for (const section of sections) {
		if (section.ops.length === 0 && !section.remove && !section.moveTo) {
			throw new ToolError(`Section [${section.path}] has no operations.`);
		}
		const emptyBody = section.ops.find(
			op =>
				(op.kind === "replace" || op.kind === "replace_block" || op.kind === "insert" || op.kind === "insert_after_block") &&
				op.body.length === 0,
		);
		if (emptyBody) {
			throw new ToolError(
				`Section [${section.path}]: a \`PUT ...:\` header has no +body rows. To delete lines use CUT, not an empty PUT.`,
			);
		}
	}
	return sections;
}

function parseGap(rest: string): { gap: Gap; block: boolean } | null {
	const direction = rest[0];
	if (direction !== "<" && direction !== ">") return null;
	let anchor = rest.slice(1).trim();
	let block = false;
	if (anchor.endsWith("*")) {
		block = true;
		anchor = anchor.slice(0, -1);
	}
	if (anchor === "$") {
		if (direction === "<") return null;
		return { gap: { kind: "eof" }, block };
	}
	if (!/^[1-9]\d*$/.test(anchor)) return null;
	const line = Number.parseInt(anchor, 10);
	if (direction === "<" && line === 1) return { gap: { kind: "bof" }, block };
	return { gap: { kind: direction === "<" ? "before" : "after", line }, block };
}

function parseLocatorOp(
	keyword: "PUT" | "CUT",
	rest: string,
	hasColon: boolean,
	register: string | undefined,
	lineNo: number,
	raw: string,
): HashlineOp {
	// Gap locators: <N, >N, >$ (optionally >N*)
	const gapParsed = parseGap(rest);
	if (gapParsed) {
		if (keyword === "CUT") throw parseError(lineNo, raw, "CUT takes a range (CUT A.=B) or block (CUT A*), not a gap");
		const { gap, block } = gapParsed;
		if (block) {
			if (gap.kind !== "after") throw parseError(lineNo, raw, "block gap insert must be `PUT >N*:`");
			if (!hasColon) {
				return { kind: "paste_after_block", line: gap.line, register };
			}
			return { kind: "insert_after_block", line: gap.line, body: [] };
		}
		if (hasColon) {
			if (register !== undefined) throw parseError(lineNo, raw, "register PUT takes no `:` header or body rows");
			return { kind: "insert", gap, body: [] };
		}
		return { kind: "paste_gap", gap, register };
	}

	// Block locator: N*
	if (rest.endsWith("*")) {
		const num = rest.slice(0, -1).trim();
		if (!/^[1-9]\d*$/.test(num)) throw parseError(lineNo, raw, `invalid block anchor ${JSON.stringify(rest)}`);
		const line = Number.parseInt(num, 10);
		if (keyword === "CUT") {
			if (hasColon) throw parseError(lineNo, raw, "CUT takes no `:` header");
			return { kind: "cut_block", line, register };
		}
		if (hasColon) {
			if (register !== undefined) throw parseError(lineNo, raw, "register PUT takes no `:` header or body rows");
			return { kind: "replace_block", line, body: [] };
		}
		if (register === undefined) throw parseError(lineNo, raw, "block paste requires `@name` (or use `PUT N*:` with body rows)");
		return { kind: "paste_block", line, register };
	}

	// Range locator: A.=B or single A (lenient shorthand for A.=A)
	const rangeMatch = RANGE_RE.exec(rest);
	if (!rangeMatch) {
		throw parseError(
			lineNo,
			raw,
			`invalid locator ${JSON.stringify(rest)} — expected A.=B, A*, <A, >A, or >$ (line numbers from your latest read)`,
		);
	}
	const start = Number.parseInt(rangeMatch[1] as string, 10);
	const end = rangeMatch[2] ? Number.parseInt(rangeMatch[2] as string, 10) : start;
	if (end < start) throw parseError(lineNo, raw, `range end ${end} is before start ${start}`);
	if (keyword === "CUT") {
		if (hasColon) throw parseError(lineNo, raw, "CUT takes no `:` header (the range alone names what to delete)");
		return { kind: "cut", start, end, register };
	}
	if (hasColon) {
		if (register !== undefined) throw parseError(lineNo, raw, "register PUT takes no `:` header or body rows");
		return { kind: "replace", start, end, body: [] };
	}
	if (register === undefined) {
		throw parseError(lineNo, raw, "span paste requires `@name`; to replace with literal content end the header with `:` and add +body rows");
	}
	return { kind: "paste_range", start, end, register };
}
