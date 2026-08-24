/**
 * Apply parsed hashline ops to file text.
 *
 * All line numbers name ORIGINAL lines. Blocks are resolved to concrete
 * ranges first; then ops are validated (bounds, overlap) and rendered in one
 * walk over the original lines. Registers are captured in patch order before
 * rendering, so `CUT ... @r` in one section can feed `PUT ... @r` later —
 * including across sections in the same patch.
 */
import { ToolError } from "../host.ts";
import { resolveBlock } from "./blocks.ts";
import type { Gap, HashlineOp } from "./parser.ts";

export const ANON_REGISTER = "";

export type Registers = Map<string, string[]>;

export interface BlockResolution {
	anchor: number;
	start: number;
	end: number;
}

/** Concrete (block-free) op. */
export type ConcreteOp =
	| { kind: "replace"; start: number; end: number; body: string[] }
	| { kind: "insert"; gap: Gap; body: string[] }
	| { kind: "cut"; start: number; end: number; register?: string }
	| { kind: "paste_gap"; gap: Gap; register?: string }
	| { kind: "paste_range"; start: number; end: number; register: string };

export interface ApplyOutcome {
	text: string;
	warnings: string[];
	blockResolutions: BlockResolution[];
}

export async function resolveOps(
	filePath: string,
	text: string,
	ops: HashlineOp[],
	warnings: string[],
	blockResolutions: BlockResolution[],
): Promise<ConcreteOp[]> {
	const resolved: ConcreteOp[] = [];
	for (const op of ops) {
		switch (op.kind) {
			case "replace":
			case "insert":
			case "cut":
			case "paste_gap":
			case "paste_range":
				resolved.push(op);
				break;
			case "replace_block": {
				const span = await requireBlock(filePath, text, op.line, "PUT N*:");
				blockResolutions.push({ anchor: op.line, start: span.start, end: span.end });
				resolved.push({ kind: "replace", start: span.start, end: span.end, body: op.body });
				break;
			}
			case "cut_block": {
				const span = await requireBlock(filePath, text, op.line, "CUT N*");
				blockResolutions.push({ anchor: op.line, start: span.start, end: span.end });
				resolved.push({ kind: "cut", start: span.start, end: span.end, register: op.register });
				break;
			}
			case "paste_block": {
				const span = await requireBlock(filePath, text, op.line, "PUT N* @name");
				blockResolutions.push({ anchor: op.line, start: span.start, end: span.end });
				resolved.push({ kind: "paste_range", start: span.start, end: span.end, register: op.register });
				break;
			}
			case "insert_after_block": {
				const span = await resolveBlock(filePath, text, op.line);
				if (span) {
					blockResolutions.push({ anchor: op.line, start: span.start, end: span.end });
					resolved.push({ kind: "insert", gap: { kind: "after", line: span.end }, body: op.body });
				} else {
					warnings.push(
						`PUT >${op.line}*: could not resolve a block at line ${op.line}; lowered to plain insert after line ${op.line} — verify the landing line.`,
					);
					resolved.push({ kind: "insert", gap: { kind: "after", line: op.line }, body: op.body });
				}
				break;
			}
			case "paste_after_block": {
				const span = await resolveBlock(filePath, text, op.line);
				if (span) {
					blockResolutions.push({ anchor: op.line, start: span.start, end: span.end });
					resolved.push({ kind: "paste_gap", gap: { kind: "after", line: span.end }, register: op.register });
				} else {
					warnings.push(
						`PUT >${op.line}* could not resolve a block at line ${op.line}; lowered to paste after line ${op.line}.`,
					);
					resolved.push({ kind: "paste_gap", gap: { kind: "after", line: op.line }, register: op.register });
				}
				break;
			}
		}
	}
	return resolved;
}

async function requireBlock(filePath: string, text: string, line: number, opName: string) {
	const span = await resolveBlock(filePath, text, line);
	if (!span) {
		throw new ToolError(
			`${opName} at line ${line} of ${filePath}: no multi-line block begins on that line. ` +
				`Block ops anchor the OPENING line of a multi-line construct. Use an explicit range (A.=B) instead.`,
		);
	}
	return span;
}

export function opAnchorLines(op: ConcreteOp): number[] {
	switch (op.kind) {
		case "replace":
		case "cut":
		case "paste_range": {
			const lines: number[] = [];
			for (let i = op.start; i <= op.end; i++) lines.push(i);
			return lines;
		}
		case "insert":
		case "paste_gap":
			return op.gap.kind === "before" || op.gap.kind === "after" ? [op.gap.line] : [];
	}
}

interface LineOps {
	removedBy?: ConcreteOp;
	payloadBefore: string[][];
	payload?: string[];
	payloadAfter: string[][];
}

export function applyConcreteOps(
	filePath: string,
	text: string,
	ops: ConcreteOp[],
	registers: Registers,
): { text: string } {
	const hasTrailingNewline = text.endsWith("\n");
	const lines = text.length === 0 ? [] : (hasTrailingNewline ? text.slice(0, -1) : text).split("\n");
	const lineCount = lines.length;

	// Bounds validation.
	for (const op of ops) {
		const spanEnd =
			op.kind === "replace" || op.kind === "cut" || op.kind === "paste_range"
				? op.end
				: op.gap.kind === "before" || op.gap.kind === "after"
					? op.gap.line
					: 0;
		if (spanEnd > lineCount) {
			throw new ToolError(
				`Line ${spanEnd} is beyond the end of ${filePath} (${lineCount} lines). ` +
					`Line numbers name ORIGINAL lines from your latest read — re-read the file.`,
			);
		}
	}

	// Overlap validation for removal spans.
	const claimed = new Map<number, string>();
	for (const op of ops) {
		if (op.kind !== "replace" && op.kind !== "cut" && op.kind !== "paste_range") continue;
		const label = `${op.kind} ${op.start}.=${op.end}`;
		for (let i = op.start; i <= op.end; i++) {
			const prior = claimed.get(i);
			if (prior) {
				throw new ToolError(
					`Overlapping hunks on ${filePath}: line ${i} is claimed by both "${prior}" and "${label}". ` +
						`Non-adjacent changes need disjoint ranges.`,
				);
			}
			claimed.set(i, label);
		}
	}

	// Capture registers in patch order, then resolve paste payloads.
	for (const op of ops) {
		if (op.kind === "cut") {
			registers.set(op.register ?? ANON_REGISTER, lines.slice(op.start - 1, op.end));
		}
	}
	const payloadOf = (register: string | undefined, what: string): string[] => {
		const key = register ?? ANON_REGISTER;
		const value = registers.get(key);
		if (value === undefined) {
			throw new ToolError(
				register === undefined
					? `${what}: nothing in the anonymous register — CUT something first in this patch.`
					: `${what}: register @${register} is empty. CUT into it first (registers persist across edit calls).`,
			);
		}
		return value;
	};

	// Build per-line action table.
	const table = new Map<number, LineOps>();
	const entry = (line: number): LineOps => {
		let existing = table.get(line);
		if (!existing) {
			existing = { payloadBefore: [], payloadAfter: [] };
			table.set(line, existing);
		}
		return existing;
	};
	const bofPayloads: string[][] = [];
	const eofPayloads: string[][] = [];

	const placeGap = (gap: Gap, payload: string[]): void => {
		if (gap.kind === "bof") bofPayloads.push(payload);
		else if (gap.kind === "eof") eofPayloads.push(payload);
		else if (gap.kind === "before") entry(gap.line).payloadBefore.push(payload);
		else entry(gap.line).payloadAfter.push(payload);
	};

	for (const op of ops) {
		switch (op.kind) {
			case "replace": {
				const cell = entry(op.start);
				cell.payload = op.body;
				for (let i = op.start; i <= op.end; i++) entry(i).removedBy = op;
				break;
			}
			case "cut": {
				for (let i = op.start; i <= op.end; i++) entry(i).removedBy = op;
				break;
			}
			case "paste_range": {
				const cell = entry(op.start);
				cell.payload = payloadOf(op.register, `PUT ${op.start}.=${op.end} @${op.register}`);
				for (let i = op.start; i <= op.end; i++) entry(i).removedBy = op;
				break;
			}
			case "insert":
				placeGap(op.gap, op.body);
				break;
			case "paste_gap":
				placeGap(op.gap, payloadOf(op.register, op.register ? `PUT @${op.register}` : "PUT (anonymous paste)"));
				break;
		}
	}

	// Render.
	const out: string[] = [];
	for (const payload of bofPayloads) out.push(...payload);
	for (let i = 1; i <= lineCount; i++) {
		const cell = table.get(i);
		if (!cell) {
			out.push(lines[i - 1] as string);
			continue;
		}
		for (const payload of cell.payloadBefore) out.push(...payload);
		if (cell.payload) out.push(...cell.payload);
		if (!cell.removedBy) out.push(lines[i - 1] as string);
		for (const payload of cell.payloadAfter) out.push(...payload);
	}
	for (const payload of eofPayloads) out.push(...payload);

	let result = out.join("\n");
	if (hasTrailingNewline && result.length > 0) result += "\n";
	return { text: result };
}
