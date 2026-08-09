/**
 * ast-grep engine: structural search and rewrite over source files via
 * @ast-grep/napi (builtin js/ts/tsx/css/html plus optional
 * `@ast-grep/lang-*` dynamic grammars).
 */
import * as fs from "node:fs/promises";
import { ToolError } from "../host.ts";
import { knownLangNames, langForFile, loadNapi, resolveLang } from "./astlang.ts";

export interface AstMatch {
	file: string;
	startLine: number; // 1-based
	endLine: number; // 1-based inclusive
	text: string;
}

export interface AstSearchOutcome {
	matches: AstMatch[];
	filesSearched: number;
	parseErrors: string[];
	skippedNoLang: number;
}

// biome-ignore lint/suspicious/noExplicitAny: napi nodes are dynamically typed
type SgNode = any;

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function nodeSpan(node: SgNode): { startLine: number; endLine: number } {
	const range = node.range();
	const endLine = range.end.column === 0 ? range.end.line : range.end.line + 1;
	return { startLine: range.start.line + 1, endLine: Math.max(endLine, range.start.line + 1) };
}

async function parseFile(file: string, source: string): Promise<SgNode | null> {
	const langName = langForFile(file);
	if (!langName) return null;
	const lang = await resolveLang(langName);
	if (lang === null) return null;
	const napi = await loadNapi();
	if (!napi) return null;
	const sg = await napi.parseAsync(lang, source);
	return sg.root();
}

export async function astSearch(
	pattern: string,
	files: string[],
	options: { langFilter?: string; maxMatches?: number; signal?: AbortSignal } = {},
): Promise<AstSearchOutcome> {
	const napi = await loadNapi();
	if (!napi) {
		throw new ToolError(
			"@ast-grep/napi is not installed. Run `npm install` in the omp-tools extension directory.",
		);
	}
	const outcome: AstSearchOutcome = { matches: [], filesSearched: 0, parseErrors: [], skippedNoLang: 0 };
	const maxMatches = options.maxMatches ?? 2000;

	for (const file of files) {
		if (options.signal?.aborted) break;
		if (outcome.matches.length >= maxMatches) break;
		const langName = langForFile(file);
		if (!langName || (options.langFilter && langName !== options.langFilter)) {
			outcome.skippedNoLang++;
			continue;
		}
		let source: string;
		try {
			const stat = await fs.stat(file);
			if (stat.size > MAX_FILE_BYTES) continue;
			source = await fs.readFile(file, "utf8");
		} catch {
			continue;
		}
		if (source.includes("\u0000")) continue;
		outcome.filesSearched++;
		try {
			const root = await parseFile(file, source);
			if (!root) {
				outcome.skippedNoLang++;
				continue;
			}
			const nodes = root.findAll(pattern) as SgNode[];
			for (const node of nodes) {
				const span = nodeSpan(node);
				outcome.matches.push({ file, startLine: span.startLine, endLine: span.endLine, text: node.text() });
				if (outcome.matches.length >= maxMatches) break;
			}
		} catch (error) {
			outcome.parseErrors.push(`${file}: ${String((error as Error).message ?? error)}`);
		}
	}
	return outcome;
}

const META_TOKEN_RE = /\$\$\$([A-Z_][A-Z0-9_]*)|\$\$\$|\$([A-Z_][A-Z0-9_]*)|\$_/g;

function substituteMeta(out: string, match: SgNode, source: string): string {
	return out.replace(META_TOKEN_RE, (token, multiName?: string, singleName?: string) => {
		if (multiName) {
			const nodes = match.getMultipleMatches(multiName) as SgNode[];
			if (!nodes || nodes.length === 0) return "";
			const first = nodes[0].range();
			const last = nodes[nodes.length - 1].range();
			return source.slice(first.start.index, last.end.index);
		}
		if (singleName) {
			const node = match.getMatch(singleName);
			return node ? node.text() : "";
		}
		throw new ToolError(
			`Rewrite template uses unbound ${token} — name the capture (e.g. $$$ARGS / $NAME) in both pattern and template.`,
		);
	});
}

export interface AstRewriteResult {
	newText: string;
	count: number;
}

export async function astRewrite(
	file: string,
	source: string,
	ops: Array<{ pat: string; out: string }>,
): Promise<AstRewriteResult | null> {
	let text = source;
	let total = 0;
	for (const op of ops) {
		const root = await parseFile(file, text);
		if (!root) return total > 0 ? { newText: text, count: total } : null;
		const nodes = root.findAll(op.pat) as SgNode[];
		if (nodes.length === 0) continue;
		// Collect non-overlapping edits left-to-right (outermost wins).
		const edits: Array<{ start: number; end: number; replacement: string }> = [];
		let lastEnd = -1;
		const ordered = nodes
			.map(node => ({ node, range: node.range() }))
			.sort((a, b) => a.range.start.index - b.range.start.index || b.range.end.index - a.range.end.index);
		for (const { node, range } of ordered) {
			if (range.start.index < lastEnd) continue; // nested in an already-rewritten node
			edits.push({ start: range.start.index, end: range.end.index, replacement: substituteMeta(op.out, node, text) });
			lastEnd = range.end.index;
		}
		let rebuilt = "";
		let cursor = 0;
		for (const editOp of edits) {
			rebuilt += text.slice(cursor, editOp.start) + editOp.replacement;
			cursor = editOp.end;
		}
		rebuilt += text.slice(cursor);
		text = rebuilt;
		total += edits.length;
	}
	return { newText: text, count: total };
}

export function availableLangSummary(): string {
	return knownLangNames().join(", ");
}
