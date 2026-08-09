/**
 * TUI renderers for all omp tools, replicating oh-my-pi's look with the
 * host's own primitives: colored `label · status` panels (host default
 * shell), red/green diffs with intra-line highlighting (host `renderDiff`),
 * syntax-highlighted file bodies, dim line-number gutters, accent file
 * headers, and expand-on-demand.
 *
 * Host UI modules (`@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`)
 * are imported lazily; on hosts without them the tools register without
 * custom renderers and fall back to plain text.
 */

// biome-ignore lint/suspicious/noExplicitAny: host theme/components are structurally typed
type Any = any;

export interface RenderSupport {
	Text: new (text: string, paddingX?: number, paddingY?: number) => Any;
	Container: new () => Any;
	renderDiff?: (diffText: string) => string;
	highlightCode?: (code: string, language?: string, theme?: Any) => string | string[];
	getLanguageFromPath?: (path: string) => string | undefined;
	keyHint?: (keybinding: string, description: string) => string;
}

let supportPromise: Promise<RenderSupport | null> | undefined;

export function loadRenderSupport(): Promise<RenderSupport | null> {
	supportPromise ??= (async () => {
		try {
			// Host-provided modules; resolvable only inside pi/prime-agent.
			// @ts-ignore -- not a compile-time dependency
			const tui = (await import("@earendil-works/pi-tui")) as Any;
			let host: Any = {};
			try {
				// @ts-ignore -- not a compile-time dependency
				host = (await import("@earendil-works/pi-coding-agent")) as Any;
			} catch {
				/* renderers degrade to uncolored diffs */
			}
			if (!tui?.Text) return null;
			return {
				Text: tui.Text,
				Container: tui.Container,
				renderDiff: host.renderDiff,
				highlightCode: host.highlightCode,
				getLanguageFromPath: host.getLanguageFromPath,
				keyHint: host.keyHint,
			};
		} catch {
			return null;
		}
	})();
	return supportPromise;
}

const COLLAPSED_BODY_LINES = 14;
const EXPANDED_BODY_LINES = 400;

function fg(theme: Any, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function bold(theme: Any, text: string): string {
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

function inverse(theme: Any, text: string): string {
	try {
		if (typeof theme.inverse === "function") return theme.inverse(text);
	} catch {
		/* fall through */
	}
	return bold(theme, text);
}

/** Syntax-highlight `code` if the host exposes highlightCode; else return as-is. */
function highlight(R: RenderSupport, code: string, language: string | undefined, theme: Any): string[] {
	const plain = code.split("\n");
	if (!R.highlightCode || !language) return plain;
	try {
		const result = R.highlightCode(code, language, theme);
		const joined = Array.isArray(result) ? result.join("\n") : result;
		const lines = joined.split("\n");
		return lines.length === plain.length ? lines : plain;
	} catch {
		return plain;
	}
}

function languageFor(R: RenderSupport, path: string | undefined): string | undefined {
	if (!path || !R.getLanguageFromPath) return undefined;
	try {
		return R.getLanguageFromPath(path);
	} catch {
		return undefined;
	}
}

function expandHint(R: RenderSupport, theme: Any, expanded: boolean, hiddenCount: number): string {
	if (hiddenCount <= 0) return "";
	const hint = R.keyHint ? R.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand") : "";
	const suffix = hint ? ` · ${hint}` : "";
	return fg(theme, "dim", `… ${hiddenCount} more lines${suffix}`);
}

function bodyWindow(rows: string[], expanded: boolean): { shown: string[]; hidden: number } {
	const cap = expanded ? EXPANDED_BODY_LINES : COLLAPSED_BODY_LINES;
	if (rows.length <= cap) return { shown: rows, hidden: 0 };
	return { shown: rows.slice(0, cap), hidden: rows.length - cap };
}

function fileHeader(theme: Any, path: string, tag?: string): string {
	return fg(theme, "accent", path) + (tag ? fg(theme, "dim", ` #${tag}`) : "");
}

function gutterRows(
	R: RenderSupport,
	theme: Any,
	rows: Array<{ n: number; text: string; isMatch?: boolean }>,
	options: { language?: string; matchRe?: RegExp | null } = {},
): string[] {
	const width = String(Math.max(1, ...rows.map(row => row.n))).length;
	// Highlight contiguous content as one block so multi-line tokens survive.
	const highlighted =
		options.language && !options.matchRe
			? highlight(R, rows.map(row => row.text).join("\n"), options.language, theme)
			: null;
	return rows.map((row, index) => {
		const num = fg(theme, "dim", `${String(row.n).padStart(width)} `);
		let content = highlighted ? (highlighted[index] ?? row.text) : row.text;
		if (options.matchRe && row.isMatch !== false) {
			try {
				options.matchRe.lastIndex = 0;
				content = content.replace(options.matchRe, m => inverse(theme, m));
			} catch {
				/* keep plain */
			}
		}
		if (!options.matchRe && !highlighted) content = fg(theme, "toolOutput", content);
		return `${num}${content}`;
	});
}

function toText(R: RenderSupport, lines: string[]): Any {
	return new R.Text(lines.join("\n"), 0, 0);
}

function fallbackText(R: RenderSupport, result: Any, theme: Any): Any {
	const raw = (result?.content ?? [])
		.filter((part: Any) => part.type === "text")
		.map((part: Any) => part.text)
		.join("\n");
	return new R.Text(fg(theme, "toolOutput", raw), 0, 0);
}

function argText(value: unknown): string {
	return typeof value === "string" ? value : "…";
}

interface Renderers {
	renderCall: (args: Any, theme: Any, context: Any) => Any;
	renderResult: (result: Any, options: Any, theme: Any, context: Any) => Any;
}

function call(R: RenderSupport, theme: Any, name: string, rest: string): Any {
	return new R.Text(`${fg(theme, "toolTitle", bold(theme, name))} ${rest}`, 0, 0);
}

/* ------------------------------- read ---------------------------------- */

export function readRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			return call(R, theme, "read", fg(theme, "accent", argText(args?.path)));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			if (context?.isError || !details?.kind) return fallbackText(R, result, theme);
			if (details.kind === "text" && Array.isArray(details.rows)) {
				const language = details.language ?? languageFor(R, details.path);
				const rows = gutterRows(R, theme, details.rows, { language });
				const { shown, hidden } = bodyWindow(rows, expanded);
				const out = [fileHeader(theme, details.path, details.tag), ...shown];
				const hint = expandHint(R, theme, expanded, hidden + (details.moreLines ?? 0));
				if (hint) out.push(hint);
				return toText(R, out);
			}
			if (typeof details.body === "string") {
				const rows = details.body.split("\n").map((line: string) => fg(theme, "toolOutput", line));
				const { shown, hidden } = bodyWindow(rows, expanded);
				const header = details.path ? [fileHeader(theme, details.path, details.tag)] : [];
				const out = [...header, ...shown];
				const hint = expandHint(R, theme, expanded, hidden);
				if (hint) out.push(hint);
				return toText(R, out);
			}
			return fallbackText(R, result, theme);
		},
	};
}

/* ------------------------------- write --------------------------------- */

export function writeRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			return call(R, theme, "write", fg(theme, "accent", argText(args?.path)));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			if (context?.isError || !details?.path) return fallbackText(R, result, theme);
			const out: string[] = [];
			out.push(
				`${fileHeader(theme, details.path, details.tag)} ${fg(theme, "success", details.existed ? "overwrote" : "created")}${fg(theme, "dim", ` · ${details.lineCount ?? 0} lines`)}`,
			);
			if (Array.isArray(details.rows) && details.rows.length > 0) {
				const language = details.language ?? languageFor(R, details.path);
				const rows = gutterRows(R, theme, details.rows, { language });
				const { shown, hidden } = bodyWindow(rows, expanded);
				out.push(...shown);
				const hint = expandHint(R, theme, expanded, hidden);
				if (hint) out.push(hint);
			}
			return toText(R, out);
		},
	};
}

/* -------------------------------- edit --------------------------------- */

export function editRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			const input = typeof args?.input === "string" ? args.input : "";
			const paths = [...input.matchAll(/^\[([^\]#]+)(?:#[0-9A-Fa-f]{4})?\]/gm)].map(match => match[1]);
			const label = paths.length > 0 ? paths.join(", ") : "…";
			return call(R, theme, "edit", fg(theme, "accent", label));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			if (context?.isError || !Array.isArray(details?.sections)) return fallbackText(R, result, theme);
			const out: string[] = [];
			for (const section of details.sections) {
				if (out.length > 0) out.push("");
				const status =
					section.op === "delete"
						? fg(theme, "error", " deleted")
						: section.op === "noop"
							? fg(theme, "warning", " no change")
							: "";
				out.push(fileHeader(theme, section.path, section.tag) + status);
				if (section.moveFrom) out.push(fg(theme, "dim", `moved from ${section.moveFrom}`));
				if (typeof section.diff === "string" && section.diff.length > 0) {
					const rendered = R.renderDiff ? R.renderDiff(section.diff) : section.diff;
					const rows = rendered.split("\n");
					const { shown, hidden } = bodyWindow(rows, expanded);
					out.push(...shown);
					const hint = expandHint(R, theme, expanded, hidden);
					if (hint) out.push(hint);
				}
				for (const resolution of section.blockResolutions ?? []) {
					out.push(fg(theme, "dim", `block ${resolution.anchor}* → ${resolution.start}.=${resolution.end}`));
				}
				for (const warning of section.warnings ?? []) {
					out.push(fg(theme, "warning", `⚠ ${warning}`));
				}
			}
			return toText(R, out);
		},
	};
}

/* ------------------------------ ast_edit ------------------------------- */

export function astEditRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			const ops = Array.isArray(args?.ops) ? args.ops.length : 0;
			const paths = Array.isArray(args?.paths) ? args.paths.join(", ") : "…";
			const mode = args?.apply === true ? fg(theme, "success", " apply") : fg(theme, "warning", " preview");
			return call(R, theme, "ast_edit", `${fg(theme, "muted", `${ops} op${ops === 1 ? "" : "s"} →`)} ${fg(theme, "accent", paths)}${mode}`);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			if (context?.isError || !Array.isArray(details?.files)) return fallbackText(R, result, theme);
			const out: string[] = [];
			const headline = details.applied
				? fg(theme, "success", `applied ${details.totalReplacements} replacement(s) in ${details.files.length} file(s)`)
				: fg(theme, "warning", `preview — ${details.totalReplacements} replacement(s) in ${details.files.length} file(s), nothing written`) +
					fg(theme, "dim", " · re-issue with apply: true");
			out.push(headline);
			for (const file of details.files) {
				out.push("");
				out.push(fileHeader(theme, file.path, file.tag) + fg(theme, "dim", ` · ${file.count} replacement(s)`));
				if (typeof file.diff === "string" && file.diff.length > 0) {
					const rendered = R.renderDiff ? R.renderDiff(file.diff) : file.diff;
					out.push(...rendered.split("\n"));
				}
			}
			const { shown, hidden } = bodyWindow(out, expanded);
			const hint = expandHint(R, theme, expanded, hidden);
			if (hint) shown.push(hint);
			return toText(R, shown);
		},
	};
}

/* ------------------------------- search -------------------------------- */

function searchLikeResult(
	R: RenderSupport,
	result: Any,
	expanded: boolean,
	theme: Any,
	context: Any,
	matchRe: RegExp | null,
): Any {
	const details = result?.details as Any;
	if (context?.isError || !Array.isArray(details?.files)) return fallbackText(R, result, theme);
	if (details.files.length === 0) {
		return new R.Text(fg(theme, "muted", "no matches"), 0, 0);
	}
	const out: string[] = [];
	for (const file of details.files) {
		if (out.length > 0) out.push("");
		out.push(fileHeader(theme, file.path, file.tag));
		// Group consecutive rows; dim ⋮ between non-adjacent groups.
		let group: Array<{ n: number; text: string; isMatch?: boolean }> = [];
		let previous = 0;
		for (const row of file.rows ?? []) {
			if (previous > 0 && row.n > previous + 1) {
				out.push(...gutterFlush(R, theme, group, matchRe));
				out.push(fg(theme, "dim", "⋮"));
				group = [];
			}
			group.push(row);
			previous = row.n;
		}
		out.push(...gutterFlush(R, theme, group, matchRe));
		if (file.more) out.push(fg(theme, "dim", `… ${file.more} more matches in this file`));
	}
	if (details.summary) out.push("", fg(theme, "muted", details.summary));
	const { shown, hidden } = bodyWindow(out, expanded);
	const hint = expandHint(R, theme, expanded, hidden);
	if (hint) shown.push(hint);
	return toText(R, shown);
}

function gutterFlush(
	R: RenderSupport,
	theme: Any,
	rows: Array<{ n: number; text: string; isMatch?: boolean }>,
	matchRe: RegExp | null,
): string[] {
	if (rows.length === 0) return [];
	return gutterRows(R, theme, rows, { matchRe });
}

export function searchRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			let rest = fg(theme, "warning", JSON.stringify(argText(args?.pattern)));
			if (typeof args?.path === "string") rest += ` ${fg(theme, "muted", `in ${args.path}`)}`;
			return call(R, theme, "search", rest);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			let matchRe: RegExp | null = null;
			if (typeof details?.pattern === "string") {
				try {
					const source = details.literal
						? details.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
						: details.pattern;
					matchRe = new RegExp(source, details.caseSensitive ? "g" : "gi");
				} catch {
					matchRe = null;
				}
			}
			return searchLikeResult(R, result, expanded, theme, context, matchRe);
		},
	};
}

/* ------------------------------ ast_grep ------------------------------- */

export function astGrepRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			let rest = fg(theme, "warning", JSON.stringify(argText(args?.pat)));
			if (typeof args?.path === "string") rest += ` ${fg(theme, "muted", `in ${args.path}`)}`;
			return call(R, theme, "ast_grep", rest);
		},
		renderResult(result, { expanded }, theme, context) {
			return searchLikeResult(R, result, expanded, theme, context, null);
		},
	};
}

/* -------------------------------- find --------------------------------- */

export function findRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme) {
			return call(R, theme, "find", fg(theme, "accent", argText(args?.path ?? ".")));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result?.details as Any;
			if (context?.isError || !Array.isArray(details?.paths)) return fallbackText(R, result, theme);
			if (details.paths.length === 0) return new R.Text(fg(theme, "muted", "no matches"), 0, 0);
			const rows = details.paths.map((entry: Any) =>
				entry.isDir ? fg(theme, "accent", `${entry.path}/`) : fg(theme, "toolOutput", entry.path),
			);
			const { shown, hidden } = bodyWindow(rows, expanded);
			const out = [fg(theme, "muted", `${details.total} paths, newest first`), ...shown];
			const hint = expandHint(R, theme, expanded, hidden + Math.max(0, (details.total ?? 0) - (details.paths.length ?? 0)));
			if (hint) out.push(hint);
			return toText(R, out);
		},
	};
}
