/**
 * TUI renderers for all omp tools, matching oh-my-pi's tool UI look:
 * rounded full-width output boxes with the status line inset in the top
 * border (`╭─── ✎ Write: 🟦 path · 16 lines ───╮`), dim line-number
 * gutters, `N│content` diff frames with red/green rows and intra-line
 * inverse highlighting, `⟦badge⟧` chips, emoji file icons, and `├─`/`└─`
 * tree bodies for search-style tools.
 *
 * Everything is built from the host's public primitives (`theme.fg`,
 * `Text`, `Component#render(width)`); host UI modules are imported lazily
 * and on hosts without them the tools register without custom renderers.
 */

// biome-ignore lint/suspicious/noExplicitAny: host theme/components are structurally typed
type Any = any;

export interface RenderSupport {
	Text: new (text: string, paddingX?: number, paddingY?: number) => Any;
	Container: new () => Any;
	highlightCode?: (code: string, language?: string, theme?: Any) => string | string[];
	getLanguageFromPath?: (path: string) => string | undefined;
	/** Resolves a keybinding action id (e.g. `app.tools.expand`) to its key label. */
	keyText?: (keybinding: string) => string;
	visibleWidth?: (text: string) => number;
	truncateToWidth?: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
}

let supportPromise: Promise<RenderSupport | null> | undefined;

export function loadRenderSupport(): Promise<RenderSupport | null> {
	supportPromise ??= (async () => {
		try {
			// Dynamic import: host modules exist only inside pi/prime-agent; this
			// package must also load on hosts without them.
			// @ts-ignore -- not a compile-time dependency
			const tui = (await import("@earendil-works/pi-tui")) as Any;
			let host: Any = {};
			try {
				// @ts-ignore -- not a compile-time dependency
				host = (await import("@earendil-works/pi-coding-agent")) as Any;
			} catch {
				/* renderers degrade to unhighlighted bodies */
			}
			if (!tui?.Text) return null;
			return {
				Text: tui.Text,
				Container: tui.Container,
				highlightCode: host.highlightCode,
				getLanguageFromPath: host.getLanguageFromPath,
				keyText: host.keyText,
				visibleWidth: tui.visibleWidth,
				truncateToWidth: tui.truncateToWidth,
			};
		} catch {
			return null;
		}
	})();
	return supportPromise;
}

/* --------------------------- layout constants -------------------------- */

const COLLAPSED_CODE_LINES = 12;
const COLLAPSED_DIFF_LINES = 24;
const COLLAPSED_TREE_LINES = 28;
const COLLAPSED_LIST_ITEMS = 10;
const EXPANDED_LINES = 400;
const MIN_BOX_WIDTH = 24;
const FALLBACK_WIDTH = 80;

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", teeR: "├", teeL: "┤" } as const;
const TREE = { branch: "├─ ", last: "└─ ", rail: "│  ", blank: "   " } as const;

const STATUS: Record<string, { glyph: string; color: string }> = {
	success: { glyph: "✔", color: "success" },
	done: { glyph: "•", color: "success" },
	error: { glyph: "✘", color: "error" },
	warning: { glyph: "⚠", color: "warning" },
	pending: { glyph: "⏳", color: "muted" },
	running: { glyph: "⟳", color: "accent" },
	info: { glyph: "ⓘ", color: "accent" },
};

/** Emoji file-type icons, keyed by extension (omp's language icon set). */
const EXT_ICONS: Record<string, string> = {
	ts: "🟦", tsx: "🟦", mts: "🟦", cts: "🟦",
	js: "🟨", jsx: "🟨", mjs: "🟨", cjs: "🟨",
	py: "🐍", rs: "🦀", go: "🐹", java: "☕", rb: "💎",
	sh: "💻", bash: "💻", zsh: "💻", fish: "💻",
	html: "🌐", htm: "🌐", css: "🎨", scss: "🎨", less: "🎨",
	json: "🧾", jsonc: "🧾", toml: "🧾",
	yaml: "📋", yml: "📋",
	md: "📝", markdown: "📝", mdx: "📝",
	sql: "🗄", sqlite: "🗄", sqlite3: "🗄", db: "🗄",
	lua: "🌙", log: "📜", csv: "📑", tsv: "📑",
	png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", svg: "🖼",
	pdf: "📕", zip: "🗜", tar: "🗜", gz: "🗜", tgz: "🗜", ipynb: "📓",
	txt: "🗒",
};

function fileIcon(rawPath: string | undefined, isDir = false): string {
	if (isDir) return "📁";
	if (!rawPath) return "🗒";
	// Selectors (`db.sqlite:users`, `a.zip:member`) never change the container icon.
	const base = (rawPath.split(":")[0] ?? rawPath).toLowerCase();
	const name = base.slice(base.lastIndexOf("/") + 1);
	if (name === "dockerfile") return "🐳";
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot + 1) : "";
	return EXT_ICONS[ext] ?? "🗒";
}

/* ----------------------------- ansi + width ---------------------------- */

const ANSI_RE = /\x1b\[[0-9;:]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function vw(R: RenderSupport, text: string): number {
	if (R.visibleWidth) {
		try {
			return R.visibleWidth(text);
		} catch {
			/* fall through */
		}
	}
	return stripAnsi(text).length;
}

function fit(R: RenderSupport, text: string, max: number): string {
	if (max <= 0) return "";
	if (vw(R, text) <= max) return text;
	if (R.truncateToWidth) {
		try {
			return R.truncateToWidth(text, max, "…");
		} catch {
			/* fall through */
		}
	}
	const plain = stripAnsi(text);
	return plain.length <= max ? plain : `${plain.slice(0, Math.max(0, max - 1))}…`;
}

/* ----------------------------- theme helpers --------------------------- */

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

function statusIcon(theme: Any, kind: keyof typeof STATUS): string {
	const spec = STATUS[kind] as { glyph: string; color: string };
	return fg(theme, spec.color, spec.glyph);
}

function diffStatsBadge(theme: Any, added: number, removed: number): string {
	return (
		fg(theme, "dim", "⟦") +
		fg(theme, "toolDiffAdded", `+${added}`) +
		fg(theme, "dim", "/") +
		fg(theme, "toolDiffRemoved", `-${removed}`) +
		fg(theme, "dim", "⟧")
	);
}

/**
 * One-line tool header, omp status-line shape:
 * `{icon} {Title}: {description} {⟦badge⟧} {meta · meta}`.
 */
function statusLine(
	theme: Any,
	opts: { icon?: string; title: string; description?: string; badge?: string; meta?: string[] },
): string {
	const parts: string[] = [];
	if (opts.icon) parts.push(opts.icon);
	parts.push(fg(theme, "toolTitle", bold(theme, `${opts.title}:`)));
	if (opts.description) parts.push(opts.description);
	if (opts.badge) parts.push(opts.badge);
	if (opts.meta && opts.meta.length > 0) parts.push(fg(theme, "dim", opts.meta.join(" · ")));
	return parts.join(" ").replace(/\s*\n\s*/g, " ");
}

function pathLabel(theme: Any, path: string, tag?: string): string {
	return fg(theme, "accent", path) + (tag ? fg(theme, "dim", `#${tag}`) : "");
}

function expandKeyLabel(R: RenderSupport): string {
	if (R.keyText) {
		try {
			const raw = stripAnsi(R.keyText("app.tools.expand")).trim();
			if (raw) {
				return raw
					.split("+")
					.map(part => (part.length <= 1 ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1)))
					.join("+");
			}
		} catch {
			/* fall through */
		}
	}
	return "Ctrl+O";
}

function moreLine(R: RenderSupport, theme: Any, hidden: number, expanded: boolean, what = "lines"): string {
	if (hidden <= 0) return "";
	const label = hidden === 1 ? what.replace(/s$/, "") : what;
	const chip = expanded ? "" : ` ⟦${expandKeyLabel(R)}: Expand⟧`;
	return fg(theme, "dim", `… ${hidden} more ${label}${chip}`);
}

function bodyWindow(rows: string[], expanded: boolean, collapsedCap: number): { shown: string[]; hidden: number } {
	const cap = expanded ? EXPANDED_LINES : collapsedCap;
	if (rows.length <= cap) return { shown: rows, hidden: 0 };
	return { shown: rows.slice(0, cap), hidden: rows.length - cap };
}

/* ------------------------------ components ----------------------------- */

function lineText(R: RenderSupport, lines: string[]): Any {
	return new R.Text(lines.join("\n"), 0, 0);
}

interface BoxSection {
	label?: string;
	rows: string[];
	padLeft?: number;
}

/**
 * Rounded full-width box with the header inset in the top border and
 * optional labeled section dividers — omp's framed output block.
 */
function boxed(R: RenderSupport, theme: Any, opts: { header: string; borderColor?: string; sections: BoxSection[] }): Any {
	const border = (text: string) => fg(theme, opts.borderColor ?? "borderMuted", text);
	let cachedWidth = -1;
	let cached: string[] = [];
	return {
		render(width: number): string[] {
			const w = Math.max(MIN_BOX_WIDTH, width || FALLBACK_WIDTH);
			if (w === cachedWidth) return cached;
			const inner = w - 2;
			const lines: string[] = [];
			const header = fit(R, opts.header.replace(/\s*\n\s*/g, " "), Math.max(1, inner - 7));
			const headFill = Math.max(0, inner - 5 - vw(R, header));
			lines.push(border(BOX.tl + BOX.h.repeat(3)) + ` ${header} ` + border(BOX.h.repeat(headFill) + BOX.tr));
			let first = true;
			for (const section of opts.sections) {
				if (section.label !== undefined) {
					const label = fit(R, fg(theme, "toolTitle", section.label), Math.max(1, inner - 7));
					const fill = Math.max(0, inner - 5 - vw(R, label));
					lines.push(border(BOX.teeR + BOX.h.repeat(3)) + ` ${label} ` + border(BOX.h.repeat(fill) + BOX.teeL));
				} else if (!first) {
					lines.push(border(BOX.teeR + BOX.h.repeat(inner) + BOX.teeL));
				}
				const pad = section.padLeft ?? 1;
				const contentWidth = inner - pad;
				for (const row of section.rows) {
					const shown = fit(R, row.replace(/\t/g, "  "), contentWidth);
					const rightPad = " ".repeat(Math.max(0, contentWidth - vw(R, shown)));
					lines.push(border(BOX.v) + " ".repeat(pad) + shown + rightPad + border(BOX.v));
				}
				first = false;
			}
			lines.push(border(BOX.bl + BOX.h.repeat(inner) + BOX.br));
			cachedWidth = w;
			cached = lines;
			return lines;
		},
		invalidate(): void {
			cachedWidth = -1;
		},
	};
}

/** Renderer state shared between a tool row's call and result renders. */
interface RenderState {
	done?: boolean;
}

function stateOf(context: Any): RenderState | undefined {
	// Cast: the host initializes state as an empty object we own.
	const state = context && typeof context === "object" ? (context.state as RenderState | undefined) : undefined;
	return state && typeof state === "object" ? state : undefined;
}

/**
 * Pending-call status line that disappears once the result renders — omp
 * replaces the `⏳ Tool: …` row with the framed result instead of stacking.
 */
function pendingCall(R: RenderSupport, context: Any, text: string): Any {
	const state = stateOf(context);
	return {
		render(width: number): string[] {
			if (state?.done) return [];
			return [fit(R, text, Math.max(10, width || FALLBACK_WIDTH))];
		},
		invalidate(): void {},
	};
}

/** Flag the shared renderer state so the pending call line stops rendering. */
function markDone(context: Any): void {
	const state = stateOf(context);
	if (state) state.done = true;
}

/* ----------------------------- code bodies ----------------------------- */

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

/** `NN content` rows with a dim right-aligned line-number gutter. */
function codeRows(
	R: RenderSupport,
	theme: Any,
	rows: Array<{ n: number; text: string; isMatch?: boolean }>,
	options: { language?: string; minGutter?: number } = {},
): string[] {
	if (rows.length === 0) return [];
	const width = Math.max(options.minGutter ?? 2, String(Math.max(1, ...rows.map(row => row.n))).length);
	const highlighted = options.language
		? highlight(R, rows.map(row => row.text).join("\n"), options.language, theme)
		: null;
	return rows.map((row, index) => {
		const num = fg(theme, "dim", `${String(row.n).padStart(width)} `);
		const content = highlighted ? (highlighted[index] ?? row.text) : fg(theme, "toolOutput", row.text);
		return `${num}${content}`;
	});
}

/* ------------------------------ diff bodies ---------------------------- */

interface DiffRow {
	marker: "+" | "-" | " ";
	n: number;
	text: string;
}

type DiffLine = DiffRow | { gap: true } | { note: string };

function parseDiffText(diff: string): DiffLine[] {
	const out: DiffLine[] = [];
	for (const line of diff.split("\n")) {
		const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
		if (match) {
			out.push({ marker: match[1] as DiffRow["marker"], n: Number.parseInt(match[2] as string, 10), text: match[3] as string });
		} else if (line.trim() === "⋮" || line.trim() === "…") {
			out.push({ gap: true });
		} else if (line.trim().length > 0) {
			out.push({ note: line });
		}
	}
	return out;
}

function diffStatsOf(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of parseDiffText(diff)) {
		if ("marker" in row && row.marker === "+") added++;
		if ("marker" in row && row.marker === "-") removed++;
	}
	return { added, removed };
}

/** Make leading indentation visible on changed rows (`··` for spaces). */
function visualizeIndent(text: string): string {
	return text.replace(/^[\t ]+/, indentText => indentText.replace(/ /g, "·").replace(/\t/g, "→ "));
}

/** Inverse-highlight the changed middle segment of a single-line replace pair. */
function inverseChanged(theme: Any, removed: string, added: string): { removed: string; added: string } {
	let prefix = 0;
	const maxPrefix = Math.min(removed.length, added.length);
	while (prefix < maxPrefix && removed[prefix] === added[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < Math.min(removed.length, added.length) - prefix &&
		removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]
	) {
		suffix++;
	}
	const mark = (text: string): string => {
		const mid = text.slice(prefix, text.length - suffix);
		if (mid.length === 0) return text;
		return text.slice(0, prefix) + inverse(theme, mid) + text.slice(text.length - suffix);
	};
	return { removed: mark(removed), added: mark(added) };
}

/**
 * omp's edit diff frame: `(marker+num)│content` rows from numbered-diff
 * text (`+N …`/`-N …`/` N …`), red/green whole-row coloring, blank gutter
 * on a `+` row repeating the number just shown, dim `…` gap rows, and
 * intra-line inverse on single-line replace pairs.
 */
function diffFrameRows(R: RenderSupport, theme: Any, diff: string, language: string | undefined): string[] {
	const parsed = parseDiffText(diff);
	const numbered = parsed.filter((row): row is DiffRow => "marker" in row);
	if (numbered.length === 0) return diff.split("\n").map(line => fg(theme, "toolOutput", line));
	const width = Math.max(3, String(Math.max(1, ...numbered.map(row => row.n))).length);

	// Intra-line highlights for lone -/+ pairs (single-line replacements).
	const marked = new Map<DiffRow, string>();
	for (let i = 0; i < parsed.length - 1; i++) {
		const a = parsed[i];
		const b = parsed[i + 1];
		if (!a || !b || !("marker" in a) || !("marker" in b) || a.marker !== "-" || b.marker !== "+") continue;
		const prev = parsed[i - 1];
		const next = parsed[i + 2];
		const lonePair =
			(!prev || !("marker" in prev) || prev.marker !== "-") && (!next || !("marker" in next) || next.marker !== "+");
		if (!lonePair) continue;
		const pair = inverseChanged(theme, visualizeIndent(a.text), visualizeIndent(b.text));
		marked.set(a, pair.removed);
		marked.set(b, pair.added);
	}

	// Highlight context rows as one block so multi-line tokens survive.
	const context = language
		? highlight(R, numbered.map(row => (row.marker === " " ? row.text : "")).join("\n"), language, theme)
		: null;
	const out: string[] = [];
	let contextIndex = 0;
	let lastNumber = -1;
	for (const row of parsed) {
		if ("gap" in row) {
			out.push(fg(theme, "dim", "…"));
			continue;
		}
		if ("note" in row) {
			out.push(fg(theme, "dim", row.note));
			continue;
		}
		const highlightedContext = context?.[contextIndex];
		contextIndex++;
		if (row.marker === " ") {
			const gutter = fg(theme, "dim", `${String(row.n).padStart(width + 1)}│`);
			out.push(gutter + (highlightedContext || fg(theme, "toolDiffContext", row.text)));
			lastNumber = row.n;
			continue;
		}
		const color = row.marker === "+" ? "toolDiffAdded" : "toolDiffRemoved";
		const repeats = row.marker === "+" && row.n === lastNumber;
		const num = repeats ? "+".padStart(width + 1) : `${row.marker}${String(row.n)}`.padStart(width + 1);
		out.push(fg(theme, color, `${num}│${marked.get(row) ?? visualizeIndent(row.text)}`));
		lastNumber = row.n;
	}
	return out;
}

/* ------------------------------ tree bodies ---------------------------- */

/** `├─ first / │  rest` grouped tree body used by search-style tools. */
function treeRows(theme: Any, groups: string[][]): string[] {
	const out: string[] = [];
	groups.forEach((group, index) => {
		const last = index === groups.length - 1;
		group.forEach((line, lineIndex) => {
			const prefix = lineIndex === 0 ? (last ? TREE.last : TREE.branch) : last ? TREE.blank : TREE.rail;
			out.push(fg(theme, "dim", prefix) + line);
		});
	});
	return out;
}

/* -------------------------------- shared ------------------------------- */

interface Renderers {
	renderCall: (args: Any, theme: Any, context: Any) => Any;
	renderResult: (result: Any, options: Any, theme: Any, context: Any) => Any;
}

function textOf(result: Any): string {
	const parts = (result?.content ?? []) as Any[];
	return parts
		.filter((part: Any) => part.type === "text")
		.map((part: Any) => part.text)
		.join("\n");
}

function argText(value: unknown): string {
	return typeof value === "string" ? value : "…";
}

function errorBox(R: RenderSupport, theme: Any, title: string, subject: string, result: Any): Any {
	const rows = textOf(result)
		.split("\n")
		.slice(0, 8)
		.map(line => fg(theme, "error", line));
	return boxed(R, theme, {
		header: statusLine(theme, { icon: statusIcon(theme, "error"), title, description: fg(theme, "accent", subject) }),
		borderColor: "error",
		sections: [{ rows }],
	});
}

/* -------------------------------- read --------------------------------- */

export function readRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Read",
				description: fg(theme, "accent", argText(args?.path)),
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const shownPath = details?.path ?? callArgs?.path ?? "";
			if (context?.isError) return errorBox(R, theme, "Read", shownPath, result);
			if (!details?.kind) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);

			let rows: string[];
			let lineSuffix = "";
			if (details.kind === "text" && Array.isArray(details.rows)) {
				const language = details.language ?? languageFor(R, details.path);
				rows = codeRows(R, theme, details.rows, { language });
				const total = details.rows.length + (details.moreLines ?? 0);
				lineSuffix = fg(theme, "dim", ` · ${total} line${total === 1 ? "" : "s"}`);
			} else if (typeof details.body === "string") {
				rows = details.body.split("\n").map((line: string) => fg(theme, "toolOutput", line));
			} else {
				return lineText(R, [fg(theme, "toolOutput", textOf(result))]);
			}
			const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_CODE_LINES);
			const totalHidden = hidden + (details.kind === "text" ? (details.moreLines ?? 0) : 0);
			const tail = moreLine(R, theme, totalHidden, expanded);
			if (tail) shown.push(tail);
			return boxed(R, theme, {
				header: statusLine(theme, {
					icon: `${fileIcon(shownPath, details.kind === "dir")} ${statusIcon(theme, "done")}`,
					title: "Read",
					description: pathLabel(theme, shownPath, details.tag) + lineSuffix,
				}),
				sections: [{ rows: shown }],
			});
		},
	};
}

/* -------------------------------- write -------------------------------- */

export function writeRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const shownPath = argText(args?.path);
			const header = statusLine(theme, {
				icon: fg(theme, "accent", "✎"),
				title: "Write",
				description: `${fileIcon(shownPath)} ${fg(theme, "accent", shownPath)}`,
			});
			const state = stateOf(context);
			const streaming = context?.argsComplete === false;
			const content = typeof args?.content === "string" ? args.content : "";
			return {
				render(width: number): string[] {
					if (state?.done) return [];
					const contentLines = content.length > 0 ? content.replace(/\n$/, "").split("\n") : [];
					const tailStart = Math.max(0, contentLines.length - COLLAPSED_CODE_LINES);
					const rows = codeRows(
						R,
						theme,
						contentLines.slice(tailStart).map((text: string, index: number) => ({ n: tailStart + index + 1, text })),
						{ minGutter: 3 },
					);
					if (streaming) rows.push(fg(theme, "dim", "… (streaming)"));
					return boxed(R, theme, { header, sections: [{ rows }] }).render(width);
				},
				invalidate(): void {},
			};
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const shownPath = details?.path ?? callArgs?.path ?? "";
			if (context?.isError) return errorBox(R, theme, "Write", shownPath, result);
			if (!details?.path) {
				// Archive/SQLite writes have no preview body; single status line.
				return lineText(R, [
					statusLine(theme, {
						icon: statusIcon(theme, "success"),
						title: "Write",
						description: fg(theme, "muted", textOf(result)),
					}),
				]);
			}
			const previewRows = Array.isArray(details.rows) ? details.rows : [];
			const rows = codeRows(R, theme, previewRows, {
				language: details.language ?? languageFor(R, details.path),
				minGutter: 3,
			});
			const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_CODE_LINES);
			const totalHidden = hidden + Math.max(0, (details.lineCount ?? 0) - previewRows.length);
			const tail = moreLine(R, theme, totalHidden, expanded);
			if (tail) shown.push(tail);
			return boxed(R, theme, {
				header: statusLine(theme, {
					icon: fg(theme, "accent", "✎"),
					title: details.existed ? "Write" : "Create",
					description:
						`${fileIcon(details.path)} ${pathLabel(theme, details.path, details.tag)}` +
						fg(theme, "dim", ` · ${details.lineCount ?? 0} line${details.lineCount === 1 ? "" : "s"}`),
				}),
				sections: [{ rows: shown }],
			});
		},
	};
}

/* --------------------------------- edit -------------------------------- */

function editSectionPaths(input: unknown): string[] {
	if (typeof input !== "string") return [];
	return [...input.matchAll(/^\[([^\]#]+)(?:#[0-9A-Fa-f]{4})?\]/gm)].map(match => match[1] as string);
}

export function editRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const paths = editSectionPaths(args?.input);
			const label = paths.length > 0 ? paths.join(", ") : argText(args?.path);
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Edit",
				description: fg(theme, "accent", label),
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const sections = details?.sections as Any[] | undefined;
			if (context?.isError) return errorBox(R, theme, "Edit", editSectionPaths(callArgs?.input).join(", "), result);
			if (!Array.isArray(sections)) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);

			// Deletes and noops render as single status lines; diffs share one box.
			const inline: string[] = [];
			const boxSections: BoxSection[] = [];
			let headerLine: string | undefined;
			for (const section of sections) {
				const label = pathLabel(theme, section.path, section.tag);
				if (section.op === "delete") {
					inline.push(statusLine(theme, { icon: "🗑", title: "Delete", description: label }));
					continue;
				}
				if (section.op === "noop") {
					inline.push(
						statusLine(theme, { icon: statusIcon(theme, "warning"), title: "Edit", description: label, meta: ["no change"] }),
					);
					continue;
				}
				const diff = typeof section.diff === "string" ? section.diff : "";
				const stats = diffStatsOf(diff);
				const line = statusLine(theme, {
					icon: fg(theme, "accent", "✎"),
					title: section.op === "create" ? "Create" : "Edit",
					description: `${fileIcon(section.path)} ${label}`,
					badge: diffStatsBadge(theme, stats.added, stats.removed),
				});
				const rows: string[] = [];
				if (section.moveFrom) rows.push(fg(theme, "dim", `moved from ${section.moveFrom}`));
				rows.push(...diffFrameRows(R, theme, diff, languageFor(R, section.path)));
				for (const resolution of section.blockResolutions ?? []) {
					rows.push(fg(theme, "dim", `block ${resolution.anchor}* → ${resolution.start}.=${resolution.end}`));
				}
				for (const warning of section.warnings ?? []) {
					rows.push(`${statusIcon(theme, "warning")} ${fg(theme, "warning", warning)}`);
				}
				if (headerLine === undefined) {
					headerLine = line;
					boxSections.push({ rows });
				} else {
					boxSections.push({ label: stripAnsi(line), rows });
				}
			}

			if (headerLine === undefined) {
				return lineText(R, inline.length > 0 ? inline : [fg(theme, "toolOutput", textOf(result))]);
			}

			// One collapse budget across all diff sections.
			if (!expanded) {
				let budget = COLLAPSED_DIFF_LINES;
				for (const section of boxSections) {
					const kept = section.rows.slice(0, Math.max(0, budget));
					const hidden = section.rows.length - kept.length;
					budget -= kept.length;
					if (hidden > 0) kept.push(moreLine(R, theme, hidden, expanded));
					section.rows = kept;
				}
			}
			const box = boxed(R, theme, { header: headerLine, sections: boxSections });
			if (inline.length === 0) return box;
			return {
				render(width: number): string[] {
					return [...inline.map(line => fit(R, line, Math.max(10, width || FALLBACK_WIDTH))), ...box.render(width)];
				},
				invalidate(): void {
					box.invalidate();
				},
			};
		},
	};
}

/* ------------------------------- ast_edit ------------------------------ */

function collapsePattern(pattern: unknown): string {
	return typeof pattern === "string" ? pattern.replace(/\s+/g, " ").trim() : "…";
}

export function astEditRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const firstOp = Array.isArray(args?.ops) ? (args.ops[0] as Any) : undefined;
			const paths = Array.isArray(args?.paths) ? args.paths.join("; ") : "…";
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "AST Edit",
				description: fg(theme, "muted", collapsePattern(firstOp?.pat)),
				meta: [`in ${paths}`],
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const firstOp = Array.isArray(callArgs?.ops) ? (callArgs.ops[0] as Any) : undefined;
			const pattern = collapsePattern(firstOp?.pat);
			if (context?.isError) return errorBox(R, theme, "AST Edit", pattern, result);
			if (!Array.isArray(details?.files) || details.files.length === 0) {
				const notes = textOf(result)
					.split("\n")
					.map(line => fg(theme, "muted", line));
				return lineText(R, [
					statusLine(theme, {
						icon: statusIcon(theme, "warning"),
						title: "AST Edit",
						description: fg(theme, "muted", pattern),
						meta: ["0 rewrites"],
					}),
					...notes,
				]);
			}

			const rows: string[] = [];
			for (const file of details.files as Any[]) {
				if (rows.length > 0) rows.push("");
				rows.push(
					pathLabel(theme, file.path, file.tag) + fg(theme, "dim", ` · ${file.count} replacement${file.count === 1 ? "" : "s"}`),
				);
				if (typeof file.diff === "string" && file.diff.length > 0) {
					const parsed = parseDiffText(file.diff);
					const numbered = parsed.filter((row): row is DiffRow => "marker" in row);
					const width = String(Math.max(1, ...numbered.map(row => row.n))).length;
					for (const row of parsed) {
						if ("gap" in row) rows.push(fg(theme, "dim", "…"));
						else if ("note" in row) rows.push(fg(theme, "dim", row.note));
						else if (row.marker === "+") rows.push(fg(theme, "toolDiffAdded", `+${String(row.n).padStart(width)} ${row.text}`));
						else if (row.marker === "-") rows.push(fg(theme, "toolDiffRemoved", `-${String(row.n).padStart(width)} ${row.text}`));
						else rows.push(fg(theme, "dim", ` ${String(row.n).padStart(width)} `) + fg(theme, "toolDiffContext", row.text));
					}
				}
			}
			for (const parseError of (details.parseErrors ?? []) as string[]) {
				rows.push(`${statusIcon(theme, "warning")} ${fg(theme, "warning", parseError)}`);
			}
			const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_DIFF_LINES);
			const tail = moreLine(R, theme, hidden, expanded, "changes");
			if (tail) shown.push(tail);

			const applied = details.applied === true;
			const fileCount = (details.files as Any[]).length;
			return boxed(R, theme, {
				header: statusLine(theme, {
					icon: statusIcon(theme, applied ? "success" : "done"),
					title: "AST Edit",
					description: fg(theme, "muted", pattern),
					badge: fg(theme, applied ? "success" : "warning", applied ? "⟦applied⟧" : "⟦proposed⟧"),
					meta: [
						`${details.totalReplacements} replacement${details.totalReplacements === 1 ? "" : "s"}`,
						`${fileCount} file${fileCount === 1 ? "" : "s"}`,
					],
				}),
				sections: [{ rows: shown }],
			});
		},
	};
}

/* ------------------------- search / ast_grep body ---------------------- */

function matchGutterRows(
	theme: Any,
	rows: Array<{ n: number; text: string; isMatch?: boolean }>,
	matchRe: RegExp | null,
): string[] {
	if (rows.length === 0) return [];
	const width = String(Math.max(1, ...rows.map(row => row.n))).length;
	const out: string[] = [];
	let previous = 0;
	for (const row of rows) {
		if (previous > 0 && row.n > previous + 1) out.push(fg(theme, "dim", "⋮"));
		previous = row.n;
		const marker = row.isMatch === false ? " " : "*";
		const gutter = fg(theme, "dim", `${`${marker}${String(row.n)}`.padStart(width + 1)}│`);
		let content = row.text;
		if (matchRe && row.isMatch !== false) {
			try {
				matchRe.lastIndex = 0;
				content = content.replace(matchRe, m => inverse(theme, m));
			} catch {
				/* keep plain */
			}
		}
		out.push(gutter + fg(theme, "toolOutput", content));
	}
	return out;
}

function searchLikeResult(
	R: RenderSupport,
	theme: Any,
	opts: {
		title: string;
		pattern: string;
		scope?: string;
		expanded: boolean;
		files: Any[];
		matchRe: RegExp | null;
		summary?: string;
	},
): Any {
	const matches = opts.files.reduce((sum, file) => {
		const fileRows = (file.rows ?? []) as Any[];
		return sum + fileRows.filter((row: Any) => row.isMatch !== false).length + (file.more ?? 0);
	}, 0);
	const meta: string[] = [
		`${matches} match${matches === 1 ? "" : "es"}`,
		`${opts.files.length} file${opts.files.length === 1 ? "" : "s"}`,
	];
	if (opts.scope) meta.push(`in ${opts.scope}`);
	if (opts.summary && /next: skip/.test(opts.summary)) meta.push("truncated");
	const header = statusLine(theme, {
		icon: fg(theme, "toolTitle", "🔍"),
		title: opts.title,
		description: fg(theme, "muted", opts.pattern),
		meta,
	});

	const groups: string[][] = opts.files.map(file => {
		const group: string[] = [pathLabel(theme, file.path, file.tag)];
		group.push(...matchGutterRows(theme, (file.rows ?? []) as Any[], opts.matchRe));
		if (file.more) group.push(fg(theme, "dim", `… ${file.more} more matches in this file`));
		return group;
	});
	const body = treeRows(theme, groups);
	const { shown, hidden } = bodyWindow(body, opts.expanded, COLLAPSED_TREE_LINES);
	const tail = moreLine(R, theme, hidden, opts.expanded);
	if (tail) shown.push(fg(theme, "dim", TREE.blank) + tail);
	return lineText(R, [header, ...shown]);
}

function noMatches(R: RenderSupport, theme: Any, title: string, pattern: string, extra?: string): Any {
	return lineText(R, [
		statusLine(theme, {
			icon: statusIcon(theme, "warning"),
			title,
			description: fg(theme, "muted", pattern),
			meta: ["0 matches"],
		}),
		`${statusIcon(theme, "warning")} ${fg(theme, "muted", extra ?? "No matches found")}`,
	]);
}

/* -------------------------------- search ------------------------------- */

export function searchRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const meta: string[] = [];
			if (typeof args?.path === "string") meta.push(`in ${args.path}`);
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Search",
				description: fg(theme, "muted", argText(args?.pattern)),
				meta,
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const pattern = typeof details?.pattern === "string" ? details.pattern : argText(callArgs?.pattern);
			if (context?.isError) return errorBox(R, theme, "Search", pattern, result);
			if (!Array.isArray(details?.files)) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);
			if (details.files.length === 0) return noMatches(R, theme, "Search", pattern);
			let matchRe: RegExp | null = null;
			try {
				const source = details.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
				matchRe = new RegExp(source, details.caseSensitive ? "g" : "gi");
			} catch {
				matchRe = null;
			}
			return searchLikeResult(R, theme, {
				title: "Search",
				pattern,
				scope: typeof callArgs?.path === "string" ? callArgs.path : undefined,
				expanded,
				files: details.files,
				matchRe,
				summary: details.summary,
			});
		},
	};
}

/* ------------------------------- ast_grep ------------------------------ */

export function astGrepRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const meta: string[] = [];
			if (typeof args?.path === "string") meta.push(`in ${args.path}`);
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "AST Grep",
				description: fg(theme, "muted", collapsePattern(args?.pat)),
				meta,
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const pattern = collapsePattern(details?.pat ?? callArgs?.pat);
			if (context?.isError) return errorBox(R, theme, "AST Grep", pattern, result);
			if (!Array.isArray(details?.files)) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);
			if (details.files.length === 0) return noMatches(R, theme, "AST Grep", pattern, details.summary);
			return searchLikeResult(R, theme, {
				title: "AST Grep",
				pattern,
				scope: typeof callArgs?.path === "string" ? callArgs.path : undefined,
				expanded,
				files: details.files,
				matchRe: null,
				summary: details.summary,
			});
		},
	};
}

/* --------------------------------- find -------------------------------- */

export function findRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Find",
				description: fg(theme, "accent", argText(args?.path ?? ".")),
			});
			return pendingCall(R, context, line);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const scope = argText(callArgs?.path ?? ".");
			if (context?.isError) return errorBox(R, theme, "Find", scope, result);
			if (!Array.isArray(details?.paths)) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);
			if (details.paths.length === 0) {
				return lineText(R, [
					statusLine(theme, {
						icon: statusIcon(theme, "warning"),
						title: "Find",
						description: fg(theme, "muted", scope),
						meta: ["0 paths"],
					}),
					`${statusIcon(theme, "warning")} ${fg(theme, "muted", "No paths found")}`,
				]);
			}
			const header = statusLine(theme, {
				icon: fg(theme, "toolTitle", "🔍"),
				title: "Find",
				description: fg(theme, "muted", scope),
				meta: [`${details.total} path${details.total === 1 ? "" : "s"}`, "newest first"],
			});
			const cap = expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS;
			const entries = (details.paths as Any[]).slice(0, cap);
			const hidden = Math.max(0, (details.total ?? details.paths.length) - entries.length);
			const rows = entries.map((entry, index) => {
				const last = index === entries.length - 1 && hidden === 0;
				const prefix = fg(theme, "dim", last ? TREE.last : TREE.branch);
				const icon = fg(theme, "muted", fileIcon(entry.path, entry.isDir === true));
				const label = entry.isDir ? fg(theme, "accent", `${entry.path}/`) : fg(theme, "toolOutput", entry.path);
				return `${prefix}${icon} ${label}`;
			});
			if (hidden > 0) rows.push(fg(theme, "dim", TREE.last) + moreLine(R, theme, hidden, expanded, "files"));
			return lineText(R, [header, ...rows]);
		},
	};
}
