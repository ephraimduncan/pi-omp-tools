/**
 * Tool registration for the original seven file/search tools.
 *
 * Each `register*` function registers one tool AND wires the shared prompt
 * contract (see src/registry.ts), so the host's system prompt actively
 * steers the model toward these tools instead of shell/ipython equivalents.
 * Newer tools (todo, web_search, github, browser, inspect_image) live in
 * self-registering modules under src/tools/.
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
import { ensurePromptContract, registeredTools } from "./registry.ts";
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
		// Daemon-attached prime TUIs cannot receive render functions; this string
		// survives serialization and activates the TUI's built-in edit renderer
		// (red/green diff from details.diff). In-process hosts (pi) use our own
		// renderers above, which take precedence over replay.
		replayBuiltInToolName: "edit",
		name: "edit",
		label: "edit",
		description: EDIT_DESCRIPTION,
		promptSnippet: "Hashline patches with content-hash anchors and stale-anchor recovery",
		promptGuidelines: [
			"Use edit (hashline patches) for every modification to an existing file instead of sed/awk/python rewrites; anchor each [path#TAG] section with the tag from your latest read or search of that file.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "primary file being edited (display metadata; the patch sections name the real targets)" }),
			input: Type.String({ description: "hashline patch text ([PATH#TAG] sections with PUT/CUT/REM/MV ops and +body rows)" }),
		}),
		prepareArguments(args: unknown) {
			// Older sessions (and forgetful models) may omit `path`; derive it from
			// the first section header so validation passes.
			if (!args || typeof args !== "object") return args;
			const input = args as { path?: unknown; input?: unknown };
			if (typeof input.path === "string" || typeof input.input !== "string") return args;
			const header = /^\[([^\]#]+)/m.exec(input.input);
			return { ...input, path: header?.[1] ?? "" };
		},
		async execute(_id: string, params: { path?: string; input: string }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
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
