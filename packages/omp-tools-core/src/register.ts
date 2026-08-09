/**
 * Tool registration + system-prompt integration.
 *
 * Each `register*` function registers one tool AND wires the shared prompt
 * contract, so the host's system prompt actively steers the model toward
 * these tools instead of shell/ipython equivalents:
 *
 *  1. `promptGuidelines` per tool — bullets the host appends to its default
 *     system prompt while the tool is active.
 *  2. A `before_agent_start` handler (registered once per process) that
 *     appends an "omp-tools" workflow block describing the read -> edit
 *     anchor loop for whichever of the tools are installed.
 *  3. A `session_start` handler that deactivates same-purpose built-in tools
 *     (e.g. pi's `grep`/`glob` when `search`/`find` are installed). Opt out
 *     with OMP_TOOLS_KEEP_BUILTINS=1.
 */
import { Type } from "typebox";
import {
	AST_EDIT_DESCRIPTION,
	AST_GREP_DESCRIPTION,
	EDIT_DESCRIPTION,
	FIND_DESCRIPTION,
	READ_DESCRIPTION,
	SEARCH_DESCRIPTION,
	WRITE_DESCRIPTION,
} from "./descriptions.ts";
import type { PiApi } from "./host.ts";
import { executeAstEdit } from "./tools/ast-edit.ts";
import { executeAstGrep } from "./tools/ast-grep.ts";
import { executeEdit } from "./tools/edit.ts";
import { executeFind } from "./tools/find.ts";
import { executeRead } from "./tools/read.ts";
import { executeSearch, type SearchParams } from "./tools/search.ts";
import { executeWrite } from "./tools/write.ts";

/** Names of omp tools registered in this process (shared across packages). */
const REGISTERED_KEY = Symbol.for("omp-tools.registered.v1");
const CONTRACT_KEY = Symbol.for("omp-tools.contract.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[REGISTERED_KEY] ??= new Set<string>();
const registeredTools = globalRegistry[REGISTERED_KEY] as Set<string>;

const TOOL_SUMMARIES: Record<string, string> = {
	read: "read — files, dirs, archives, SQLite, PDFs, notebooks, URLs through one path; mints [path#TAG] anchors",
	write: "write — create/overwrite a file, archive entry, or SQLite row",
	edit: "edit — hashline patches anchored on [path#TAG] + original line numbers from read/search",
	search: "search — regex over files/globs; output rows are valid edit anchors",
	find: "find — glob path lookup (newest-first)",
	ast_grep: "ast_grep — structural code queries via tree-sitter patterns",
	ast_edit: "ast_edit — structural rewrites, previewed before apply",
};

function buildContractBlock(): string {
	const names = [...registeredTools];
	if (names.length === 0) return "";
	const lines: string[] = [
		"## omp-tools",
		"File and search work goes through these tools — NOT shell equivalents (cat/grep/sed/find/ls) and NOT python/ipython file I/O:",
	];
	for (const name of ["read", "write", "edit", "search", "find", "ast_grep", "ast_edit"]) {
		if (registeredTools.has(name)) lines.push(`- ${TOOL_SUMMARIES[name]}`);
	}
	if (registeredTools.has("edit")) {
		lines.push(
			"",
			"Anchor loop: `read`/`search` output `[path#TAG]` headers with `N:text` rows; `edit` sections copy that exact tag and name ORIGINAL line numbers. " +
				"After an edit, the response shows fresh line numbers and the new tag — use those (or re-read) before the next edit on the same file.",
		);
	}
	if (registeredTools.has("ast_edit")) {
		lines.push("`ast_edit` is dry-run by default: verify the preview, then re-issue with apply: true.");
	}
	return lines.join("\n");
}

/** Wire prompt-contract + builtin-retirement handlers exactly once per process. */
function ensurePromptContract(pi: PiApi): void {
	if (globalRegistry[CONTRACT_KEY]) return;
	globalRegistry[CONTRACT_KEY] = true;
	if (typeof pi.on !== "function") return;

	pi.on("before_agent_start", async (event: unknown) => {
		const block = buildContractBlock();
		if (!block) return undefined;
		const systemPrompt = (event as { systemPrompt?: string }).systemPrompt;
		if (typeof systemPrompt !== "string") return undefined;
		if (systemPrompt.includes("## omp-tools")) return undefined;
		return { systemPrompt: `${systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async () => {
		retireOverlappingBuiltins(pi);
	});
}

/**
 * Deactivate built-in tools that duplicate an installed omp tool's purpose.
 * Same-name tools (read/write/edit) are replaced by registration already;
 * this handles differently-named ones (pi's grep/glob/ls vs search/find).
 */
function retireOverlappingBuiltins(pi: PiApi): void {
	if (process.env.OMP_TOOLS_KEEP_BUILTINS === "1") return;
	try {
		const getActive = (pi as { getActiveTools?: () => unknown[] }).getActiveTools;
		const setActive = (pi as { setActiveTools?: (names: string[]) => void }).setActiveTools;
		if (typeof getActive !== "function" || typeof setActive !== "function") return;
		const active = getActive.call(pi).map(tool => (typeof tool === "string" ? tool : (tool as { name: string }).name));
		const retire = new Set<string>();
		if (registeredTools.has("search")) {
			retire.add("grep");
			retire.add("rg");
		}
		if (registeredTools.has("find")) {
			retire.add("glob");
			retire.add("ls");
		}
		const next = active.filter(name => !retire.has(name));
		if (next.length !== active.length) setActive.call(pi, next);
	} catch {
		/* host without tool management — fine */
	}
}

export function registerRead(pi: PiApi): void {
	registeredTools.add("read");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "read",
		label: "Read",
		description: READ_DESCRIPTION,
		promptSnippet: "Read files, dirs, archives, SQLite, PDFs, notebooks, and URLs through one path",
		promptGuidelines: [
			"Use read (never cat/head/sed or python file reads) for file, directory, archive, SQLite, PDF, notebook, and URL content; it returns the [path#TAG] anchors that edit requires.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "file/dir/archive/sqlite/pdf/notebook path or URL, with optional :selectors" }),
			limit: Type.Optional(Type.Number({ description: "max lines to return (default 2000)" })),
		}),
		async execute(_id: string, params: { path: string; limit?: number }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeRead(params.path, params.limit, ctx, signal);
		},
	});
}

export function registerWrite(pi: PiApi): void {
	registeredTools.add("write");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "write",
		label: "Write",
		description: WRITE_DESCRIPTION,
		promptSnippet: "Create or overwrite a file, archive entry, or SQLite row",
		promptGuidelines: [
			"Use write (never shell redirection or python file writes) to create files or fully rewrite them; prefer edit for modifying existing files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "file path, archive.ext:member, or db.sqlite:table[:key]" }),
			content: Type.String({ description: "file content (JSON for sqlite rows)" }),
		}),
		async execute(_id: string, params: { path: string; content: string }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeWrite(params.path, params.content, ctx);
		},
	});
}

export function registerEdit(pi: PiApi): void {
	registeredTools.add("edit");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: EDIT_DESCRIPTION,
		promptSnippet: "Hashline patches with content-hash anchors and stale-anchor recovery",
		promptGuidelines: [
			"Use edit (hashline patches) for every modification to an existing file instead of sed/awk/python rewrites; anchor each [path#TAG] section with the tag from your latest read or search of that file.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "hashline patch text ([PATH#TAG] sections with PUT/CUT/REM/MV ops and +body rows)" }),
		}),
		async execute(_id: string, params: { input: string }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeEdit(params.input, ctx);
		},
	});
}

export function registerSearch(pi: PiApi): void {
	registeredTools.add("search");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "search",
		label: "Search",
		description: SEARCH_DESCRIPTION,
		promptSnippet: "Regex search over files, globs, and directories",
		promptGuidelines: [
			"Use search instead of shell grep/rg for content lookups; its [path#TAG] N:text output doubles as edit anchors.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "regex pattern (rust regex syntax)" }),
			path: Type.Optional(Type.String({ description: 'file, directory, glob, or "<file>:<lines>"; semicolon-delimited list. Default "."' })),
			case: Type.Optional(Type.Boolean({ description: "force case-sensitive (default smart-case)" })),
			literal: Type.Optional(Type.Boolean({ description: "treat pattern as a fixed string" })),
			context: Type.Optional(Type.Number({ description: "context lines around matches (0-10)" })),
			gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore (default true)" })),
			multiline: Type.Optional(Type.Boolean({ description: "allow matches spanning lines" })),
			skip: Type.Optional(Type.Number({ description: "files to skip (pagination)" })),
		}),
		async execute(_id: string, params: SearchParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeSearch(params, ctx, signal);
		},
	});
}

export function registerFind(pi: PiApi): void {
	registeredTools.add("find");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "find",
		label: "Find",
		description: FIND_DESCRIPTION,
		promptSnippet: "Glob-based path lookup, newest-first",
		promptGuidelines: [
			"Use find instead of shell find/ls for path discovery by glob; use search when you need content matches.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: 'glob, file, or directory; semicolon-delimited list ("src/**/*.ts; test"). Default "."' })),
			hidden: Type.Optional(Type.Boolean({ description: "include hidden files (default true)" })),
			gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore (default true)" })),
			limit: Type.Optional(Type.Number({ description: "max results (default 200)" })),
		}),
		async execute(_id: string, params: { path?: string; hidden?: boolean; gitignore?: boolean; limit?: number }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeFind(params, ctx, signal);
		},
	});
}

export function registerAstGrep(pi: PiApi): void {
	registeredTools.add("ast_grep");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "ast_grep",
		label: "AST Grep",
		description: AST_GREP_DESCRIPTION,
		promptSnippet: "Structural code search via ast-grep patterns",
		promptGuidelines: [
			"Use ast_grep when syntax shape matters more than text (calls, declarations, constructs); use search for plain text.",
		],
		parameters: Type.Object({
			pat: Type.String({ description: "ast pattern (one AST node; $NAME / $$$NAME metavariables)" }),
			path: Type.Optional(Type.String({ description: 'file, directory, or glob; semicolon-delimited list ("src; tests"). Default "."' })),
			lang: Type.Optional(Type.String({ description: "restrict to one language (javascript, typescript, tsx, python, rust, go, ...)" })),
			skip: Type.Optional(Type.Number({ description: "files to skip (pagination)" })),
		}),
		async execute(_id: string, params: { pat: string; path?: string; lang?: string; skip?: number }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeAstGrep(params, ctx, signal);
		},
	});
}

export function registerAstEdit(pi: PiApi): void {
	registeredTools.add("ast_edit");
	ensurePromptContract(pi);
	pi.registerTool({
		name: "ast_edit",
		label: "AST Edit",
		description: AST_EDIT_DESCRIPTION,
		promptSnippet: "Structural AST rewrites, previewed before apply",
		promptGuidelines: [
			"Use ast_edit for multi-site structural codemods where text replace is unsafe; verify its preview, then re-issue with apply: true.",
		],
		parameters: Type.Object({
			ops: Type.Array(
				Type.Object({
					pat: Type.String({ description: "ast pattern to match" }),
					out: Type.String({ description: "replacement template ($NAME / $$$NAME substitute)" }),
				}),
				{ minItems: 1, description: "rewrite ops" },
			),
			paths: Type.Array(Type.String(), { minItems: 1, description: "files, directories, or globs to rewrite" }),
			apply: Type.Optional(Type.Boolean({ description: "write changes (default false = preview only)" })),
		}),
		async execute(_id: string, params: { ops: Array<{ pat: string; out: string }>; paths: string[]; apply?: boolean }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
			return executeAstEdit(params, ctx, signal);
		},
	});
}

export function registerAll(pi: PiApi): void {
	registerRead(pi);
	registerWrite(pi);
	registerEdit(pi);
	registerSearch(pi);
	registerFind(pi);
	registerAstGrep(pi);
	registerAstEdit(pi);
}
