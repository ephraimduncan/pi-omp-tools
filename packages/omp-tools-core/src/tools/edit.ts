/**
 * `edit` tool: hashline patches with content-hash anchors and stale-anchor
 * recovery. See parser.ts for the language; description text lives in index.ts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolError, textResult, type ToolCtx, type ToolResult } from "../host.ts";
import type { BlockResolution, ConcreteOp, Registers } from "../hashline/apply.ts";
import { ANON_REGISTER, applyConcreteOps, resolveOps } from "../hashline/apply.ts";
import type { HashlineSection } from "../hashline/parser.ts";
import { parsePatch } from "../hashline/parser.ts";
import { buildPreview } from "../hashline/preview.ts";
import { buildLineMap, remapOps } from "../hashline/recovery.ts";
import { firstChangedLineOf, numberedDiff } from "../shared/numdiff.ts";
import { computeFileTag, snapshots } from "../shared/snapshots.ts";
import { denormalizeText, displayPath, normalizeText, pathExists, resolvePath } from "../shared/util.ts";

/** Named registers persist across edit calls within the session (shared
 * across separately-installed packages via globalThis). */
const REGISTER_KEY = Symbol.for("omp-tools.registers.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[REGISTER_KEY] ??= new Map<string, string[]>();
const sessionRegisters = globalRegistry[REGISTER_KEY] as Registers;

interface PreparedSection {
	section: HashlineSection;
	absPath: string;
	shownPath: string;
	before: string;
	after: string;
	encoding: { hadBom: boolean; crlf: boolean };
	warnings: string[];
	blockResolutions: BlockResolution[];
	moveToAbs?: string;
}

async function prepareSection(
	section: HashlineSection,
	cwd: string,
	registers: Registers,
): Promise<PreparedSection> {
	const absPath = resolvePath(section.path, cwd);
	const shownPath = displayPath(absPath, cwd);

	if (!(await pathExists(absPath))) {
		// Path-typo recovery: the tag may name a file read under another path.
		if (section.tag) {
			const candidates = snapshots.findByHash(section.tag);
			const alive: string[] = [];
			for (const candidate of candidates) {
				if (await pathExists(candidate.path)) alive.push(candidate.path);
			}
			if (alive.length === 1) {
				const recovered = { ...section, path: alive[0] as string };
				const prepared = await prepareSection(recovered, cwd, registers);
				prepared.warnings.unshift(
					`Section path ${shownPath} does not exist; tag #${section.tag} matched ${displayPath(alive[0] as string, cwd)} — applied there.`,
				);
				return prepared;
			}
		}
		throw new ToolError(
			`File not found: ${shownPath}. hashline edits existing files only — create new files with \`write\`.`,
		);
	}

	const raw = await fs.readFile(absPath, "utf8");
	const normalized = normalizeText(raw);
	const currentText = normalized.text;
	const currentTag = computeFileTag(currentText);
	const warnings: string[] = [];
	const blockResolutions: BlockResolution[] = [];

	if (!section.tag) {
		throw new ToolError(
			`Section [${section.path}] is missing its #TAG. Copy the \`[FILENAME#TAG]\` header from your latest read/search of this file (current tag: #${currentTag}); never fabricate it.`,
		);
	}

	let concreteOps: ConcreteOp[];
	if (section.tag === currentTag) {
		concreteOps = await resolveOps(absPath, currentText, section.ops, warnings, blockResolutions);
	} else {
		const snapshot = snapshots.byHash(absPath, section.tag);
		if (!snapshot) {
			throw new ToolError(
				`Stale or unknown tag #${section.tag} for ${shownPath}: the file now hashes to #${currentTag} and no snapshot for #${section.tag} is retained. ` +
					`Re-read the file to get current line numbers and the fresh tag, then re-issue the edit.`,
			);
		}
		// Resolve blocks & ranges against the snapshot the model actually saw,
		// then remap anchors onto live content via an unchanged-line map.
		concreteOps = await resolveOps(absPath, snapshot.text, section.ops, warnings, blockResolutions);
		const lineMap = buildLineMap(snapshot.text, currentText);
		concreteOps = remapOps(concreteOps, lineMap, shownPath);
		warnings.push(
			`Recovered stale anchors for ${shownPath}: the file changed since tag #${section.tag} was minted. ` +
				`Anchored lines were remapped onto the current content — verify the preview below.`,
		);
	}

	let after = section.remove ? "" : applyConcreteOps(shownPath, currentText, concreteOps, registers).text;
	if (section.remove && section.ops.length > 0) {
		throw new ToolError(`Section [${section.path}]: REM cannot be combined with other line edits.`);
	}

	let moveToAbs: string | undefined;
	if (section.moveTo) {
		moveToAbs = resolvePath(section.moveTo, cwd);
		if (moveToAbs !== absPath && (await pathExists(moveToAbs))) {
			throw new ToolError(`MV destination already exists: ${displayPath(moveToAbs, cwd)}.`);
		}
	}

	return {
		section,
		absPath,
		shownPath,
		before: currentText,
		after,
		encoding: { hadBom: normalized.hadBom, crlf: normalized.crlf },
		warnings,
		blockResolutions,
		moveToAbs,
	};
}

function noChangeMessage(shownPath: string): string {
	return (
		`Edits to ${shownPath} parsed and applied cleanly, but produced no change: ` +
		`the body rows are byte-identical to the file at the targeted lines. ` +
		`Re-read the file before issuing another edit; do NOT widen the payload.`
	);
}

export interface SectionDetail {
	path: string;
	tag?: string;
	op: "update" | "delete" | "noop";
	diff?: string;
	moveFrom?: string;
	warnings: string[];
	blockResolutions: BlockResolution[];
}

async function commitSection(
	prepared: PreparedSection,
	cwd: string,
): Promise<{ text: string; detail: SectionDetail }> {
	const parts: string[] = [];

	if (prepared.section.remove) {
		await fs.unlink(prepared.absPath);
		snapshots.invalidate(prepared.absPath);
		parts.push(`Deleted ${prepared.shownPath}`);
		return {
			text: parts.join("\n"),
			detail: { path: prepared.shownPath, op: "delete", warnings: prepared.warnings, blockResolutions: [] },
		};
	}

	const targetAbs = prepared.moveToAbs ?? prepared.absPath;
	const finalText = denormalizeText(prepared.after, prepared.encoding);
	await fs.mkdir(path.dirname(targetAbs), { recursive: true });
	await fs.writeFile(targetAbs, finalText, "utf8");
	if (prepared.moveToAbs && prepared.moveToAbs !== prepared.absPath) {
		await fs.unlink(prepared.absPath);
		snapshots.relocate(prepared.absPath, prepared.moveToAbs);
	}
	const newTag = snapshots.record(targetAbs, prepared.after);

	const shownTarget = displayPath(targetAbs, cwd);
	parts.push(`[${shownTarget}#${newTag}] updated`);
	for (const resolution of prepared.blockResolutions) {
		parts.push(`  block ${resolution.anchor}* resolved to ${resolution.start}.=${resolution.end}`);
	}
	if (prepared.moveToAbs && prepared.moveToAbs !== prepared.absPath) {
		parts.push(`Moved ${prepared.shownPath} -> ${shownTarget}`);
	}
	const preview = buildPreview(prepared.before, prepared.after);
	if (preview) parts.push(preview);
	if (prepared.warnings.length > 0) parts.push(`Warnings:\n${prepared.warnings.join("\n")}`);
	return {
		text: parts.join("\n"),
		detail: {
			path: shownTarget,
			tag: newTag,
			op: "update",
			diff: numberedDiff(prepared.before, prepared.after),
			moveFrom: prepared.moveToAbs && prepared.moveToAbs !== prepared.absPath ? prepared.shownPath : undefined,
			warnings: prepared.warnings,
			blockResolutions: prepared.blockResolutions,
		},
	};
}

export async function executeEdit(input: string, ctx?: ToolCtx): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const sections = parsePatch(input);

	const seen = new Set<string>();
	// Batch registers: named registers persist across calls; the anonymous
	// register is batch-local.
	const registers: Registers = new Map(sessionRegisters);
	registers.delete(ANON_REGISTER);

	const prepared: PreparedSection[] = [];
	for (const section of sections) {
		const preparedSection = await prepareSection(section, cwd, registers);
		if (seen.has(preparedSection.absPath)) {
			throw new ToolError(
				`Multiple sections target ${preparedSection.shownPath}. Merge them into one section per file.`,
			);
		}
		seen.add(preparedSection.absPath);
		prepared.push(preparedSection);
	}

	const noops = prepared.filter(p => !p.section.remove && !p.moveToAbs && p.after === p.before);
	if (noops.length === prepared.length && prepared.length > 0) {
		return textResult(noops.map(p => noChangeMessage(p.shownPath)).join("\n\n"), {
			sections: noops.map(p => ({ path: p.shownPath, op: "noop", warnings: [], blockResolutions: [] })),
		});
	}

	const responses: string[] = [];
	const sectionDetails: SectionDetail[] = [];
	for (const preparedSection of prepared) {
		const committed = await commitSection(preparedSection, cwd);
		responses.push(committed.text);
		sectionDetails.push(committed.detail);
	}

	// Persist named registers captured this batch.
	for (const [name, value] of registers) {
		if (name !== ANON_REGISTER) sessionRegisters.set(name, value);
	}

	// Combined numbered diff in the host's built-in edit format. In daemon-mode
	// prime the TUI cannot receive our render functions, but it CAN replay its
	// built-in edit renderer (replayBuiltInToolName) — which reads details.diff.
	const combinedParts: string[] = [];
	for (const detail of sectionDetails) {
		if (!detail.diff) continue;
		if (sectionDetails.length > 1) combinedParts.push(`${detail.path}${detail.tag ? ` #${detail.tag}` : ""}`);
		combinedParts.push(detail.diff);
	}
	let combinedDiff = combinedParts.join("\n");
	const combinedLines = combinedDiff.split("\n");
	if (combinedLines.length > 400) {
		combinedDiff = [...combinedLines.slice(0, 400), `… diff truncated (${combinedLines.length} lines)`].join("\n");
	}

	return textResult(responses.join("\n\n"), {
		sections: sectionDetails,
		diff: combinedDiff,
		firstChangedLine: firstChangedLineOf(combinedDiff),
	});
}
