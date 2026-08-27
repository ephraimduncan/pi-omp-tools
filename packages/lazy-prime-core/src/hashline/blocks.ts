/**
 * Resolve the hashline `N*` block locator: given a file and a 1-based anchor
 * line, find the full extent of the syntactic block *beginning* on that line.
 *
 * Resolution order:
 *   1. Markdown headings -> whole section (nested headings included).
 *   2. Tree-sitter via @ast-grep/napi when the language is available: the
 *      largest multi-line AST node starting on the anchor line.
 *   3. Heuristic fallback: bracket matching, then indentation blocks.
 */
import * as path from "node:path";
import { langForFile, loadNapi, resolveLang } from "../shared/astlang.ts";

export interface BlockSpan {
	start: number;
	end: number;
}

const MD_EXTS = new Set([".md", ".mdx", ".markdown"]);

function resolveMarkdownBlock(lines: string[], anchor: number): BlockSpan | null {
	const line = lines[anchor - 1] ?? "";
	const heading = /^(#{1,6})\s/.exec(line);
	if (!heading) return null;
	const level = (heading[1] as string).length;
	let end = lines.length;
	for (let i = anchor; i < lines.length; i++) {
		const next = /^(#{1,6})\s/.exec(lines[i] as string);
		if (next && (next[1] as string).length <= level) {
			end = i;
			break;
		}
	}
	while (end > anchor && (lines[end - 1] as string).trim() === "") end--;
	return end > anchor ? { start: anchor, end } : null;
}

interface SgNodeLike {
	range(): { start: { line: number }; end: { line: number; column: number } };
	children(): SgNodeLike[];
	isNamed?(): boolean;
}

async function resolveTreeSitterBlock(filePath: string, text: string, anchor: number): Promise<BlockSpan | null> {
	const langName = langForFile(filePath);
	if (!langName) return null;
	const napi = await loadNapi();
	if (!napi) return null;
	const lang = await resolveLang(langName);
	if (lang === null) return null;

	let rootNode: SgNodeLike;
	try {
		const sg = await napi.parseAsync(lang, text);
		rootNode = sg.root() as SgNodeLike;
	} catch {
		return null;
	}

	const targetRow = anchor - 1;
	let bestEnd = 0;

	const visit = (node: SgNodeLike): void => {
		const range = node.range();
		if (range.start.line > targetRow || range.end.line < targetRow) return;
		if (range.start.line === targetRow) {
			// tree-sitter end positions are exclusive: column 0 means the node
			// ended with the previous row's newline.
			const endLine1 = range.end.column === 0 ? range.end.line : range.end.line + 1;
			if (endLine1 > anchor && endLine1 > bestEnd) bestEnd = endLine1;
		}
		for (const child of node.children()) {
			const childRange = child.range();
			if (childRange.start.line <= targetRow && childRange.end.line >= targetRow) visit(child);
		}
	};
	visit(rootNode);
	return bestEnd > anchor ? { start: anchor, end: bestEnd } : null;
}

const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const CLOSERS: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

/** Net bracket effect of a line, ignoring common string/comment noise crudely. */
function bracketDeltas(line: string): { open: string[]; closeCount: Record<string, number> } {
	const open: string[] = [];
	const closeCount: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
	let inString: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === inString) inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "/" && line[i + 1] === "/") break;
		if (ch === "#" && !line.slice(0, i).trim()) break;
		if (OPENERS[ch]) open.push(ch);
		else if (CLOSERS[ch]) {
			const opener = CLOSERS[ch] as string;
			const last = open.lastIndexOf(opener);
			if (last !== -1) open.splice(last, 1);
			else closeCount[opener] = (closeCount[opener] ?? 0) + 1;
		}
	}
	return { open, closeCount };
}

function resolveBracketBlock(lines: string[], anchor: number): BlockSpan | null {
	const first = bracketDeltas(lines[anchor - 1] ?? "");
	if (first.open.length === 0) return null;
	let depth = first.open.length;
	for (let i = anchor; i < lines.length; i++) {
		const { open, closeCount } = bracketDeltas(lines[i] as string);
		const closes = Object.values(closeCount).reduce((a, b) => a + b, 0);
		depth -= closes;
		if (depth <= 0) return { start: anchor, end: i + 1 };
		depth += open.length;
	}
	return null;
}

function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

function resolveIndentBlock(lines: string[], anchor: number): BlockSpan | null {
	const anchorLine = lines[anchor - 1] ?? "";
	if (anchorLine.trim() === "") return null;
	const base = indentWidth(anchorLine);
	let end = anchor;
	for (let i = anchor; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === "") continue;
		if (indentWidth(line) > base) end = i + 1;
		else break;
	}
	return end > anchor ? { start: anchor, end } : null;
}

export async function resolveBlock(filePath: string, text: string, anchor: number): Promise<BlockSpan | null> {
	const lines = text.split("\n");
	if (anchor < 1 || anchor > lines.length) return null;
	if ((lines[anchor - 1] ?? "").trim() === "") return null;

	if (MD_EXTS.has(path.extname(filePath).toLowerCase())) {
		const md = resolveMarkdownBlock(lines, anchor);
		if (md) return md;
	}

	const ts = await resolveTreeSitterBlock(filePath, text, anchor);
	if (ts && ts.end > ts.start) return ts;

	const bracket = resolveBracketBlock(lines, anchor);
	if (bracket) return bracket;

	const indent = resolveIndentBlock(lines, anchor);
	if (indent) return indent;

	return ts; // possibly single-line tree-sitter node -> null stays null
}
