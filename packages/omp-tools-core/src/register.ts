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
import {
	astEditRenderers,
	astGrepRenderers,
	editRenderers,
	findRenderers,
	loadRenderSupport,
	readRenderers,
	searchRenderers,
	writeRenderers,
} from "./render.ts";
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
		"ALL file and search work goes through these tools. NEVER use bash/ipython for file operations: no cat/head/tail (use read), no grep/rg (use search), no find/ls for discovery (use find), no sed/awk/tee/heredoc rewrites or python open()/read_text()/write_text() (use edit/write). Such calls are blocked.",
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

	pi.on("tool_call", async (event: unknown) => {
		const { toolName, input } = event as { toolName?: string; input?: Record<string, unknown> };
		const verdict = guardFileOps(toolName, input);
		if (verdict) return { block: true, reason: verdict };
		return undefined;
	});
}

const BASH_FILE_IO_RE =
	/(?:^|&&|\|\||;)\s*(?:cat|head|tail|less|grep|rg|egrep|fgrep)\s+[^|<>]*$|(?:^|&&|\|\||;)\s*sed\s+(?:-[a-zA-Z]*\s+)*-i|(?:^|&&|\|\||;)\s*find\s+\S/m;
const PY_FILE_IO_RE =
	/open\s*\([^)]*["'][wax]\+?["']|\.write_text\s*\(|\.read_text\s*\(|open\s*\([^)]*\)\s*\.\s*read\s*\(|shutil\.copy|os\.remove\s*\(/;

/**
 * Redirect obvious file I/O in bash/ipython to the omp tools. Escape hatches:
 * OMP_TOOLS_NO_GUARD=1 disables entirely; a literal `omp-ok` marker in the
 * command/code allows a specific call through (for legitimate data work).
 */
function guardFileOps(toolName: string | undefined, input: Record<string, unknown> | undefined): string | null {
	if (process.env.OMP_TOOLS_NO_GUARD === "1") return null;
	if (!toolName || !input) return null;

	if (toolName === "bash" && registeredTools.size > 0) {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command || command.includes("omp-ok")) return null;
		if (BASH_FILE_IO_RE.test(command)) {
			return (
				"omp-tools: use the dedicated tools instead of shell file I/O — read (cat/head/tail), " +
				"search (grep/rg), find (find/ls), edit (sed -i). " +
				"If this command is genuinely not file inspection/editing (e.g. fixture setup), re-run it with `# omp-ok` appended."
			);
		}
		return null;
	}

	if (toolName === "ipython" && (registeredTools.has("read") || registeredTools.has("edit") || registeredTools.has("write"))) {
		const code = typeof input.code === "string" ? input.code : "";
		if (!code || code.includes("omp-ok")) return null;
		if (PY_FILE_IO_RE.test(code)) {
			return (
				"omp-tools: use the dedicated tools instead of python file I/O — read (open/read_text), " +
				"edit (targeted changes), write (open('w')/write_text). " +
				"If this code is genuinely data processing rather than file viewing/editing, re-run it with `# omp-ok` in the code."
			);
		}
	}
	return null;
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

export async function registerRead(pi: PiApi): Promise<void> {
	registeredTools.add("read");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? readRenderers(support) : {}),
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

export async function registerWrite(pi: PiApi): Promise<void> {
	registeredTools.add("write");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? writeRenderers(support) : {}),
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

export async function registerEdit(pi: PiApi): Promise<void> {
	registeredTools.add("edit");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? editRenderers(support) : {}),
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

export async function registerSearch(pi: PiApi): Promise<void> {
	registeredTools.add("search");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? searchRenderers(support) : {}),
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

export async function registerFind(pi: PiApi): Promise<void> {
	registeredTools.add("find");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? findRenderers(support) : {}),
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

export async function registerAstGrep(pi: PiApi): Promise<void> {
	registeredTools.add("ast_grep");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? astGrepRenderers(support) : {}),
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

export async function registerAstEdit(pi: PiApi): Promise<void> {
	registeredTools.add("ast_edit");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? astEditRenderers(support) : {}),
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

export async function registerAll(pi: PiApi): Promise<void> {
	await registerRead(pi);
	await registerWrite(pi);
	await registerEdit(pi);
	await registerSearch(pi);
	await registerFind(pi);
	await registerAstGrep(pi);
	await registerAstEdit(pi);
}
