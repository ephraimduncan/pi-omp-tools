/**
 * Stale-anchor recovery: when a section's tag names an older recorded
 * snapshot instead of the live file, prove every anchored line still maps to
 * one unchanged line in the current content, remap the ops, and replay.
 * Fails closed (ToolError) when any anchor landed on changed/removed lines.
 */
import { diffLines } from "diff";
import { ToolError } from "../host.ts";
import type { ConcreteOp } from "./apply.ts";
import { opAnchorLines } from "./apply.ts";

/** Map 1-based line numbers in `previous` to line numbers in `current` for unchanged lines. */
export function buildLineMap(previous: string, current: string): Map<number, number> {
	const parts = diffLines(previous, current);
	const map = new Map<number, number>();
	let prevLine = 1;
	let curLine = 1;
	for (const part of parts) {
		const count = part.count ?? 0;
		if (part.added) {
			curLine += count;
		} else if (part.removed) {
			prevLine += count;
		} else {
			for (let i = 0; i < count; i++) map.set(prevLine + i, curLine + i);
			prevLine += count;
			curLine += count;
		}
	}
	return map;
}

function remapGap(gap: { kind: string; line?: number }, map: Map<number, number>, path: string): void {
	if (gap.kind !== "before" && gap.kind !== "after") return;
	const mapped = map.get(gap.line as number);
	if (mapped === undefined) {
		throw new ToolError(
			`Recovery failed for ${path}: anchor line ${gap.line} from your snapshot no longer exists unchanged in the current file. Re-read the file.`,
		);
	}
	gap.line = mapped;
}

/**
 * Remap every op's line numbers from snapshot coordinates to live-file
 * coordinates. Ranges must stay contiguous after mapping.
 */
export function remapOps(ops: ConcreteOp[], map: Map<number, number>, path: string): ConcreteOp[] {
	const remapped: ConcreteOp[] = ops.map(op => ({ ...op }));
	for (const op of remapped) {
		if (op.kind === "insert" || op.kind === "paste_gap") {
			op.gap = { ...op.gap };
			remapGap(op.gap as { kind: string; line?: number }, map, path);
			continue;
		}
		const anchors = opAnchorLines(op);
		const mappedStart = map.get(op.start);
		if (mappedStart === undefined) {
			throw new ToolError(
				`Recovery failed for ${path}: line ${op.start} changed since your snapshot. Re-read the file and re-anchor.`,
			);
		}
		for (const anchor of anchors) {
			const mapped = map.get(anchor);
			if (mapped === undefined || mapped !== mappedStart + (anchor - op.start)) {
				throw new ToolError(
					`Recovery failed for ${path}: lines ${op.start}.=${op.end} no longer form one unchanged region in the current file. Re-read the file.`,
				);
			}
		}
		const span = op.end - op.start;
		op.start = mappedStart;
		op.end = mappedStart + span;
	}
	return remapped;
}
