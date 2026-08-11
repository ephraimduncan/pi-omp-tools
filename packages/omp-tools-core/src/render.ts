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

import { readGroupOf } from "./registry.ts";

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
	warning: { glyph: "!", color: "warning" },
	pending: { glyph: "◌", color: "accent" },
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
	if (opts.meta && opts.meta.length > 0) {
		parts.push(opts.meta.map(part => (ANSI_RE.test(part) ? part : fg(theme, "dim", part))).join(fg(theme, "dim", " · ")));
	}
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
	const chip = expanded
		? ""
		: ` ${fg(theme, "dim", "⟦")}${fg(theme, "accent", `${expandKeyLabel(R)}: Expand`)}${fg(theme, "dim", "⟧")}`;
	return fg(theme, "dim", `… ${hidden} more ${label}`) + chip;
}

function bodyWindow(rows: string[], expanded: boolean, collapsedCap: number): { shown: string[]; hidden: number } {
	const cap = expanded ? EXPANDED_LINES : collapsedCap;
	if (rows.length <= cap) return { shown: rows, hidden: 0 };
	return { shown: rows.slice(0, cap), hidden: rows.length - cap };
}

/* ------------------------------ components ----------------------------- */

/** Top-margined text rows: the next self-shell tool supplies the inter-tool gap. */
function lineText(R: RenderSupport, lines: string[]): Any {
	return new R.Text(["", ...lines].join("\n"), 0, 0);
}

/** Colon-free header (`☑ Todo 11 tasks`) used where omp drops the `Title:` form. */
function plainHeader(theme: Any, icon: string, title: string, meta: string[] = []): string {
	const parts = [icon, fg(theme, "toolTitle", bold(theme, title))];
	if (meta.length > 0) {
		parts.push(meta.map(part => (ANSI_RE.test(part) ? part : fg(theme, "dim", part))).join(fg(theme, "dim", " · ")));
	}
	return parts.join(" ").replace(/\s*\n\s*/g, " ");
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
			const lines: string[] = [""];
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
function pendingCall(R: RenderSupport, context: Any, lines: string[]): Any {
	const state = stateOf(context);
	return {
		render(width: number): string[] {
			if (state?.done) return [];
			return ["", ...lines.map(line => fit(R, line, Math.max(10, width || FALLBACK_WIDTH)))];
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

/** Structured dir entry shape produced by read.ts for `kind: "dir"` results. */
interface DirEntryDetail {
	name: string;
	dir?: boolean;
	size?: string;
	count?: number;
	link?: string;
}

/** One member of a consecutive-read group (shared across render slots). */
interface ReadGroupMember {
	toolCallId: string;
	path: string;
	details: Any;
	isError: boolean;
	invalidate?: () => void;
}

/**
 * Group membership store, anchored on globalThis like the snapshot store so
 * separately-installed packages (each with their own copy of this module)
 * still collapse into one `• Read (N)` widget.
 */
const READ_GROUP_RENDER_KEY = Symbol.for("omp-tools.read-group-render.v1");
const renderGlobals = globalThis as Record<PropertyKey, unknown>;
renderGlobals[READ_GROUP_RENDER_KEY] ??= new Map<string, ReadGroupMember[]>();
const readRenderGroups = renderGlobals[READ_GROUP_RENDER_KEY] as Map<string, ReadGroupMember[]>;

function dirLabel(path: string): string {
	return `${path.replace(/\/+$/, "")}/`;
}

/** `├─ 🟦 name.ts   8.1KB` rows with the size/count column right-aligned. */
function dirTreeRows(R: RenderSupport, theme: Any, details: Any, expanded: boolean): string[] {
	const all = (Array.isArray(details.entries) ? details.entries : []) as DirEntryDetail[];
	const total = typeof details.total === "number" ? details.total : all.length;
	const cap = expanded ? EXPANDED_LINES : COLLAPSED_TREE_LINES;
	const shown = all.slice(0, cap);
	const hidden = all.length - shown.length + Math.max(0, total - all.length);
	const nameOf = (entry: DirEntryDetail) => (entry.dir ? `${entry.name}/` : entry.name);
	const rightOf = (entry: DirEntryDetail) =>
		entry.dir ? (typeof entry.count === "number" ? `(${entry.count})` : "") : (entry.size ?? "");
	const nameWidth = Math.max(0, ...shown.map(entry => vw(R, nameOf(entry))));
	const rightWidth = Math.max(0, ...shown.map(entry => vw(R, rightOf(entry))));
	const rows = shown.map((entry, index) => {
		const last = index === shown.length - 1 && hidden === 0;
		const prefix = fg(theme, "dim", last ? TREE.last : TREE.branch);
		const icon = fg(theme, "muted", entry.link !== undefined ? "🔗" : fileIcon(entry.name, entry.dir === true));
		const name = nameOf(entry);
		const padded = name + " ".repeat(Math.max(0, nameWidth - vw(R, name)));
		if (entry.link !== undefined) {
			return `${prefix}${icon} ${fg(theme, "toolOutput", padded)} ${fg(theme, "dim", `→ ${entry.link}`)}`;
		}
		const label = entry.dir ? fg(theme, "accent", padded) : fg(theme, "toolOutput", padded);
		const right = rightOf(entry);
		const rightCell = right.length > 0 ? fg(theme, "dim", `  ${" ".repeat(Math.max(0, rightWidth - vw(R, right)))}${right}`) : "";
		return `${prefix}${icon} ${label}${rightCell}`;
	});
	if (hidden > 0) rows.push(fg(theme, "dim", TREE.last) + moreLine(R, theme, hidden, expanded, "entries"));
	return rows;
}

/** Boxless omp-style tree for a solo directory read. */
function soloDirComponent(R: RenderSupport, theme: Any, details: Any, shownPath: string, expanded: boolean): Any {
	const entries = Array.isArray(details.entries) ? details.entries : [];
	const total = typeof details.total === "number" ? details.total : entries.length;
	const header = statusLine(theme, {
		icon: `${fileIcon(shownPath, true)} ${statusIcon(theme, "done")}`,
		title: "Read",
		description: fg(theme, "accent", dirLabel(shownPath)) + fg(theme, "dim", ` · ${total} entr${total === 1 ? "y" : "ies"}`),
	});
	return lineText(R, [header, ...dirTreeRows(R, theme, details, expanded)]);
}

/** ` · 7 entries` / ` · 120 lines` style summary for one grouped read row. */
function readMemberMeta(details: Any): string {
	if (!details || typeof details !== "object" || typeof details.kind !== "string") return "image";
	switch (details.kind) {
		case "text": {
			const shown = Array.isArray(details.rows) ? details.rows.length : 0;
			const total =
				typeof details.totalLines === "number"
					? details.totalLines
					: shown + (typeof details.moreLines === "number" ? details.moreLines : 0);
			if (shown > 0 && total > shown) return `${shown} of ${total} lines`;
			const count = total || shown;
			return `${count} line${count === 1 ? "" : "s"}`;
		}
		case "dir": {
			const entries = Array.isArray(details.entries) ? details.entries.length : 0;
			const total = typeof details.total === "number" ? details.total : entries;
			return `${total} entr${total === 1 ? "y" : "ies"}`;
		}
		default:
			return String(details.kind);
	}
}

/** omp's collapsed read log: `• Read (N)` with one `├─ path · meta` row each. */
function readGroupLines(R: RenderSupport, theme: Any, members: ReadGroupMember[], expanded: boolean): string[] {
	const header = plainHeader(theme, statusIcon(theme, "done"), `Read (${members.length})`);
	const rows = members.map(member => {
		const isDir = member.details?.kind === "dir";
		const icon = fg(theme, "muted", fileIcon(member.path, isDir));
		if (member.isError) {
			return `${icon} ${statusIcon(theme, "error")} ${fg(theme, "accent", member.path)}${fg(theme, "dim", " · ")}${fg(theme, "error", "failed")}`;
		}
		const label = isDir
			? fg(theme, "accent", dirLabel(member.path))
			: pathLabel(theme, member.path, typeof member.details?.tag === "string" ? member.details.tag : undefined);
		const meta = readMemberMeta(member.details);
		return `${icon} ${label}${meta ? fg(theme, "dim", ` · ${meta}`) : ""}`;
	});
	const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_TREE_LINES);
	const lines = shown.map(
		(row, index) => fg(theme, "dim", index === shown.length - 1 && hidden === 0 ? TREE.last : TREE.branch) + row,
	);
	if (hidden > 0) lines.push(fg(theme, "dim", TREE.last) + moreLine(R, theme, hidden, expanded, "reads"));
	return [header, ...lines];
}

/** The pre-grouping single-read view: dir tree, code rows, or body dump. */
function soloReadComponent(
	R: RenderSupport,
	theme: Any,
	result: Any,
	details: Any,
	context: Any,
	shownPath: string,
	expanded: boolean,
): Any {
	if (context?.isError) return errorBox(R, theme, "Read", shownPath, result);
	if (!details?.kind) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);
	if (details.kind === "dir" && Array.isArray(details.entries)) {
		return soloDirComponent(R, theme, details, shownPath, expanded);
	}

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
			icon: `${fileIcon(shownPath, false)} ${statusIcon(theme, "done")}`,
			title: "Read",
			description: pathLabel(theme, shownPath, details.tag) + lineSuffix,
		}),
		sections: [{ rows: shown }],
	});
}

export function readRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Read",
				description: fg(theme, "accent", argText(args?.path)),
			});
			return pendingCall(R, context, [line]);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const shownPath = String(details?.path ?? callArgs?.path ?? "");
			const solo = () => soloReadComponent(R, theme, result, details, context, shownPath, expanded);

			const toolCallId = typeof context?.toolCallId === "string" ? context.toolCallId : undefined;
			const groupId =
				readGroupOf(toolCallId) ?? (typeof details?.readGroup === "string" ? (details.readGroup as string) : undefined);
			if (!toolCallId || !groupId) return solo();

			let members = readRenderGroups.get(groupId);
			if (!members) {
				members = [];
				readRenderGroups.set(groupId, members);
			}
			const member: ReadGroupMember = {
				toolCallId,
				path: shownPath || argText(callArgs?.path),
				details,
				isError: context?.isError === true,
				invalidate: typeof context?.invalidate === "function" ? () => context.invalidate() : undefined,
			};
			const existing = members.findIndex(entry => entry.toolCallId === toolCallId);
			if (existing >= 0) members[existing] = member;
			else members.push(member);
			// Collapse every other member's slot; the newest member renders the group.
			for (const other of members) {
				if (other.toolCallId !== toolCallId) other.invalidate?.();
			}

			const group = members;
			let soloComponent: Any | undefined;
			return {
				render(width: number): string[] {
					if (group[group.length - 1]?.toolCallId !== toolCallId) return [];
					if (group.length === 1) {
						soloComponent ??= solo();
						return soloComponent.render(width);
					}
					const max = Math.max(10, width || FALLBACK_WIDTH);
					return ["", ...readGroupLines(R, theme, group, expanded).map(line => fit(R, line, max))];
				},
				invalidate(): void {
					soloComponent?.invalidate?.();
				},
			};
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
			return pendingCall(R, context, [line]);
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
					inline.push(statusLine(theme, { icon: fg(theme, "error", "✘"), title: "Delete", description: label }));
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
				if (section.moveFrom) {
					rows.push(`${fg(theme, "dim", "moved from")} ${fg(theme, "accent", String(section.moveFrom))}`);
				}
				rows.push(...diffFrameRows(R, theme, diff, languageFor(R, section.path)));
				for (const resolution of section.blockResolutions ?? []) {
					rows.push(
						`${fg(theme, "dim", "block")} ${fg(theme, "accent", `${resolution.anchor}*`)} ${fg(theme, "dim", "→")} ${fg(theme, "accent", `${resolution.start}.=${resolution.end}`)}`,
					);
				}
				for (const warning of section.warnings ?? []) {
					rows.push(`${statusIcon(theme, "warning")} ${fg(theme, "warning", warning)}`);
				}
				if (headerLine === undefined) {
					headerLine = line;
					boxSections.push({ rows });
				} else {
					boxSections.push({ label, rows });
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
					return ["", ...inline.map(line => fit(R, line, Math.max(10, width || FALLBACK_WIDTH))), ...box.render(width).slice(1)];
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
			return pendingCall(R, context, [line]);
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
		const hit = row.isMatch !== false;
		const marker = hit ? "*" : " ";
		const gutterNum = `${marker}${String(row.n)}`.padStart(width + 1);
		const gutter = hit
			? fg(theme, "accent", `${gutterNum}│`)
			: fg(theme, "dim", `${gutterNum}│`);
		let content = row.text;
		if (matchRe && hit) {
			try {
				matchRe.lastIndex = 0;
				content = content.replace(matchRe, m => inverse(theme, m));
			} catch {
				/* keep plain */
			}
		}
		out.push(gutter + fg(theme, hit ? "toolOutput" : "toolDiffContext", content));
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
		fg(theme, matches > 0 ? "success" : "warning", `${matches} match${matches === 1 ? "" : "es"}`),
		fg(theme, "accent", `${opts.files.length} file${opts.files.length === 1 ? "" : "s"}`),
	];
	if (opts.scope) meta.push(`in ${opts.scope}`);
	if (opts.summary && /next: skip/.test(opts.summary)) meta.push(fg(theme, "warning", "truncated"));
	const header = statusLine(theme, {
		icon: fg(theme, "accent", "⌕"),
		title: opts.title,
		description: fg(theme, "accent", opts.pattern),
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
			description: fg(theme, "accent", pattern),
			meta: [fg(theme, "warning", "0 matches")],
		}),
		`${statusIcon(theme, "warning")} ${fg(theme, "warning", extra ?? "No matches found")}`,
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
			return pendingCall(R, context, [line]);
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
			return pendingCall(R, context, [line]);
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
			return pendingCall(R, context, [line]);
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
				icon: fg(theme, "accent", "⌕"),
				title: "Find",
				description: fg(theme, "accent", scope),
				meta: [
					fg(theme, "success", `${details.total} path${details.total === 1 ? "" : "s"}`),
					"newest first",
				],
			});
			const cap = expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS;
			const entries = (details.paths as Any[]).slice(0, cap);
			const hidden = Math.max(0, (details.total ?? details.paths.length) - entries.length);
			const rows = entries.map((entry, index) => {
				const last = index === entries.length - 1 && hidden === 0;
				const prefix = fg(theme, "dim", last ? TREE.last : TREE.branch);
				const mark = entry.isDir === true ? fg(theme, "accent", "d") : fg(theme, "muted", "f");
				const label = entry.isDir ? fg(theme, "accent", `${entry.path}/`) : fg(theme, "accent", entry.path);
				return `${prefix}${mark} ${label}`;
			});
			if (hidden > 0) rows.push(fg(theme, "dim", TREE.last) + moreLine(R, theme, hidden, expanded, "files"));
			return lineText(R, [header, ...rows]);
		},
	};
}

/* --------------------------------- todo -------------------------------- */

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function strike(theme: Any, text: string): string {
	try {
		if (typeof theme.strikethrough === "function") return theme.strikethrough(text);
	} catch {
		/* fall through */
	}
	return text;
}

function todoTaskRow(theme: Any, task: Any): string {
	const content = String(task.content ?? "");
	switch (task.status) {
		case "completed":
			return `${fg(theme, "success", "[x]")} ${fg(theme, "success", strike(theme, content))} ${fg(theme, "dim", "done")}`;
		case "in_progress":
			return `${fg(theme, "warning", "[>]")} ${bold(theme, fg(theme, "accent", content))} ${fg(theme, "warning", "in progress")}`;
		case "dropped":
			return `${fg(theme, "error", "[-]")} ${fg(theme, "error", strike(theme, content))} ${fg(theme, "dim", "dropped")}`;
		case "blocked":
			return `${fg(theme, "warning", "[!]")} ${fg(theme, "warning", content)}${task.reason ? fg(theme, "dim", ` (blocked: ${task.reason})`) : fg(theme, "dim", " (blocked)")}`;
		default:
			return `${fg(theme, "muted", "[ ]")} ${fg(theme, "muted", content)} ${fg(theme, "dim", "pending")}`;
	}
}

export function todoRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const meta: string[] = [];
			if (typeof args?.task === "string") meta.push(args.task);
			else if (typeof args?.phase === "string") meta.push(args.phase);
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Todo",
				description: fg(theme, "muted", argText(args?.op)),
				meta,
			});
			return pendingCall(R, context, [line]);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			if (context?.isError) return errorBox(R, theme, "Todo", argText(callArgs?.op), result);
			const phases = details?.phases as Any[] | undefined;
			if (!Array.isArray(phases)) return lineText(R, [fg(theme, "toolOutput", textOf(result))]);

			const total = phases.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
			if (phases.length === 0 || total === 0) {
				return lineText(R, [
					`${fg(theme, "accent", "☑")} ${fg(theme, "toolTitle", bold(theme, "Todo"))} ${fg(theme, "muted", textOf(result).replace(/^Todo /, ""))}`,
				]);
			}

			const multi = phases.length > 1;
			const rows: string[] = [];
			const completedTotal = phases.reduce(
				(sum, phase) => sum + ((phase.tasks ?? []) as Any[]).filter(task => task.status === "completed").length,
				0,
			);
			phases.forEach((phase, index) => {
				const tasks = (phase.tasks ?? []) as Any[];
				const done = tasks.filter(task => task.status === "completed").length;
				const active = tasks.some(task => task.status === "in_progress");
				const named = callArgs?.phase === phase.name || tasks.some(task => task.content === callArgs?.task);
				const numeral = ROMAN[index] ?? String(index + 1);
				if (multi) {
					if (!expanded && !active && !named) {
						const fraction = `${done}/${tasks.length}`;
						const fractionColor = done === tasks.length ? "success" : done > 0 ? "warning" : "dim";
						rows.push(
							`${fg(theme, "dim", bold(theme, `${numeral}. ${phase.name}`))}  ${fg(theme, fractionColor, bold(theme, fraction))}`,
						);
						return;
					}
					rows.push(fg(theme, "accent", bold(theme, `${numeral}. ${phase.name}`)));
				}
				const indent = multi ? "  " : "";
				tasks.forEach((task, taskIndex) => {
					const prefix = fg(theme, "dim", taskIndex === tasks.length - 1 ? TREE.last : TREE.branch);
					rows.push(`${indent}${prefix}${todoTaskRow(theme, task)}`);
				});
			});
			const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_TREE_LINES);
			const tail = moreLine(R, theme, hidden, expanded, "tasks");
			if (tail) shown.push(tail);
			const progress =
				total > 0 ? fg(theme, completedTotal === total ? "success" : "warning", `${completedTotal}/${total}`) : "";
			return boxed(R, theme, {
				header: plainHeader(theme, fg(theme, "accent", "☑"), "Todo", [
					`${total} task${total === 1 ? "" : "s"}`,
					...(progress ? [progress] : []),
				]),
				sections: [{ rows: shown }],
			});
		},
	};
}

/* -------------------------------- github ------------------------------- */

const GITHUB_OP_TITLES: Record<string, string> = {
	repo_view: "GitHub Repo",
	issue_view: "GitHub Issue",
	pr_view: "GitHub PR",
	pr_diff: "GitHub PR Diff",
	file_read: "GitHub File",
	pr_create: "GitHub PR Create",
	pr_checkout: "GitHub PR Checkout",
	pr_push: "GitHub PR Push",
	search_issues: "GitHub Search Issues",
	search_prs: "GitHub Search PRs",
	search_code: "GitHub Search Code",
	search_commits: "GitHub Search Commits",
	search_repos: "GitHub Search Repos",
	run_watch: "GitHub Run Watch",
};

const STATE_BADGE_COLORS: Record<string, string> = {
	open: "success",
	success: "success",
	completed: "success",
	pushed: "success",
	ready: "success",
	approved: "success",
	merged: "accent",
	in_progress: "accent",
	running: "accent",
	watching: "accent",
	closed: "error",
	failure: "error",
	failed: "error",
	timed_out: "error",
	cancelled: "error",
	action_required: "error",
	changes_requested: "error",
	draft: "dim",
	queued: "warning",
	pending: "warning",
	waiting: "warning",
};

function stateBadge(theme: Any, state: unknown): string {
	if (typeof state !== "string" || state.length === 0) return "";
	const color = STATE_BADGE_COLORS[state.toLowerCase()] ?? "muted";
	return fg(theme, color, `⟦${state.toUpperCase()}⟧`);
}

/** Relative age (`2h ago`) for GitHub timestamps; empty when unparsable. */
function ageOf(iso: unknown): string {
	if (typeof iso !== "string") return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
	if (minutes < 60 * 24 * 30) return `${Math.round(minutes / (60 * 24))}d ago`;
	return iso.slice(0, 10);
}

function githubMeta(theme: Any, args: Any): string[] {
	const meta: string[] = [];
	if (typeof args?.repo === "string") meta.push(fg(theme, "accent", args.repo));
	if (typeof args?.pr === "string") meta.push(`${fg(theme, "dim", "pr")} ${fg(theme, "accent", args.pr)}`);
	if (typeof args?.query === "string") meta.push(fg(theme, "accent", args.query));
	if (typeof args?.path === "string") meta.push(fg(theme, "accent", args.path));
	return meta;
}

/** Dim-label field rows, one pair per row — narrow panes truncate values, never whole facts. */
function fieldGrid(theme: Any, pairs: Array<[string, string]>): string[] {
	const labelWidth = Math.max(...pairs.map(pair => pair[0].length));
	return pairs.map(pair => `${fg(theme, "dim", pair[0].padEnd(labelWidth))}  ${pair[1]}`);
}

function statPair(theme: Any, additions: unknown, deletions: unknown): string {
	return fg(theme, "toolDiffAdded", `+${typeof additions === "number" ? additions : 0}`) + fg(theme, "dim", "/") + fg(theme, "toolDiffRemoved", `-${typeof deletions === "number" ? deletions : 0}`);
}

/** `├─ 🟦 path  +a/-d` rows for PR file listings. */
function ghFileRows(theme: Any, files: Any[], cap: number): string[] {
	const width = Math.min(60, Math.max(...files.map(file => String(file.path ?? "").length)));
	const rows = files.slice(0, cap).map((file, index) => {
		const last = index === Math.min(files.length, cap) - 1 && files.length <= cap;
		const prefix = fg(theme, "dim", last ? TREE.last : TREE.branch);
		const label = String(file.path ?? "(unknown file)");
		const icon = fg(theme, "muted", fileIcon(label));
		return `${prefix}${icon} ${fg(theme, "toolOutput", label.padEnd(width))}  ${statPair(theme, file.additions, file.deletions)}`;
	});
	if (files.length > cap) rows.push(fg(theme, "dim", `${TREE.last}… ${files.length - cap} more files`));
	return rows;
}

/** First non-empty body line, whitespace-collapsed, for list rows. */
function snippetOf(body: unknown, max = 70): string {
	if (typeof body !== "string") return "";
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function ghUserLabel(value: Any): string {
	if (typeof value?.login === "string") return `@${value.login}`;
	return typeof value?.name === "string" ? value.name : "";
}

function ghRepoBox(R: RenderSupport, theme: Any, repo: Any): Any {
	const badges: string[] = [];
	if (repo.visibility) badges.push(fg(theme, repo.visibility === "PUBLIC" ? "success" : "warning", `⟦${repo.visibility}⟧`));
	if (typeof repo.stargazerCount === "number") badges.push(fg(theme, "warning", `★${repo.stargazerCount}`));
	const meta: string[] = [];
	if (repo.primaryLanguage?.name) meta.push(repo.primaryLanguage.name);
	if (repo.defaultBranchRef?.name) meta.push(repo.defaultBranchRef.name);
	const header = [
		fg(theme, "accent", "⎇"),
		fg(theme, "toolTitle", bold(theme, String(repo.nameWithOwner ?? "GitHub repository"))),
		...badges.filter(badge => badge.length > 0),
		...(meta.length > 0 ? [fg(theme, "dim", meta.join(" · "))] : []),
	].join(" ");

	const rows: string[] = [fg(theme, "toolOutput", String(repo.description ?? "").trim() || "No description provided."), ""];
	const pairs: Array<[string, string]> = [];
	if (typeof repo.forkCount === "number") pairs.push(["Forks", String(repo.forkCount)]);
	if (repo.viewerPermission) pairs.push(["Permission", String(repo.viewerPermission)]);
	if (repo.updatedAt) pairs.push(["Updated", ageOf(repo.updatedAt) || String(repo.updatedAt)]);
	const topics = (repo.repositoryTopics ?? [])
		.map((item: Any) => item.name ?? item.topic?.name)
		.filter(Boolean)
		.join(", ");
	if (topics) pairs.push(["Topics", topics]);
	if (repo.homepageUrl) pairs.push(["Homepage", String(repo.homepageUrl)]);
	if (repo.isArchived === true) pairs.push(["Archived", "yes"]);
	if (repo.isFork === true) pairs.push(["Fork", "yes"]);
	rows.push(...fieldGrid(theme, pairs));
	if (repo.url) rows.push(`${fg(theme, "dim", "URL".padEnd(Math.max(...pairs.map(pair => pair[0].length), 3)))}  ${fg(theme, "accent", String(repo.url))}`);
	return boxed(R, theme, { header, sections: [{ rows }] });
}

function ghIssuePrBox(
	R: RenderSupport,
	theme: Any,
	kind: "PR" | "Issue",
	data: Any,
	expanded: boolean,
): Any {
	const state = data.isDraft === true ? "draft" : data.state;
	const header = [
		fg(theme, "accent", "⎇"),
		fg(theme, "toolTitle", bold(theme, `${kind} #${data.number ?? "?"}`)),
		fg(theme, "toolOutput", String(data.title ?? "Untitled")),
		stateBadge(theme, state),
	]
		.filter(part => part.length > 0)
		.join(" ");

	const factParts: string[] = [];
	if (kind === "PR" && data.headRefName) {
		factParts.push(`${fg(theme, "accent", String(data.headRefName))} ${fg(theme, "dim", "→")} ${fg(theme, "accent", String(data.baseRefName ?? "?"))}`);
	}
	const author = ghUserLabel(data.author);
	if (author) factParts.push(fg(theme, "accent", author));
	const age = ageOf(data.createdAt);
	if (age) factParts.push(fg(theme, "dim", `opened ${age}`));
	const facts: string[] = [factParts.join(fg(theme, "dim", " · "))];

	const factParts2: string[] = [];
	if (data.reviewDecision) factParts2.push(`Review ${fg(theme, data.reviewDecision === "APPROVED" ? "success" : "warning", String(data.reviewDecision))}`);
	if (data.mergeStateStatus) factParts2.push(`Merge state ${fg(theme, "muted", String(data.mergeStateStatus))}`);
	const labelNames = (data.labels ?? []).map((label: Any) => label.name).filter(Boolean);
	if (labelNames.length > 0) factParts2.push(`Labels ${fg(theme, "muted", labelNames.join(", "))}`);
	if (data.stateReason) factParts2.push(`Reason ${fg(theme, "muted", String(data.stateReason))}`);
	if (factParts2.length > 0) facts.push(factParts2.join(fg(theme, "dim", " · ")));
	if (data.url) facts.push(fg(theme, "accent", String(data.url)));

	const sections: BoxSection[] = [{ rows: facts }];

	const bodyText = String(data.body ?? "").trim();
	const bodyRows = (bodyText || "No description provided.").split("\n").map(line => fg(theme, "toolOutput", line));
	const bodyWindowed = bodyWindow(bodyRows, expanded, COLLAPSED_CODE_LINES);
	const bodyTail = moreLine(R, theme, bodyWindowed.hidden, expanded);
	if (bodyTail) bodyWindowed.shown.push(bodyTail);
	sections.push({ label: "Body", rows: bodyWindowed.shown });

	const files = (data.files ?? []) as Any[];
	if (files.length > 0) {
		const additions = files.reduce((sum: number, file: Any) => sum + (file.additions ?? 0), 0);
		const deletions = files.reduce((sum: number, file: Any) => sum + (file.deletions ?? 0), 0);
		sections.push({
			label: `Files ${files.length} · +${additions}/-${deletions}`,
			rows: ghFileRows(theme, files, expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS),
		});
	}

	const reviews = (data.reviews ?? []) as Any[];
	const comments = (data.comments ?? []) as Any[];
	if (reviews.length > 0 || comments.length > 0) {
		const rows: string[] = [];
		for (const review of reviews) {
			rows.push(
				`${ghUserLabel(review.author) || "unknown"} ${stateBadge(theme, review.state)}${review.body ? ` ${fg(theme, "dim", "·")} ${fg(theme, "toolOutput", snippetOf(review.body))}` : ""}`,
			);
		}
		for (const comment of comments) {
			const age2 = ageOf(comment.createdAt);
			rows.push(
				`${ghUserLabel(comment.author) || "unknown"}${age2 ? ` ${fg(theme, "dim", `· ${age2}`)}` : ""} ${fg(theme, "dim", "·")} ${fg(theme, "toolOutput", snippetOf(comment.body))}`,
			);
		}
		const capped = bodyWindow(
			rows.map((row, index) => fg(theme, "dim", index === rows.length - 1 ? TREE.last : TREE.branch) + row),
			expanded,
			6,
		);
		const tail = moreLine(R, theme, capped.hidden, expanded, "entries");
		if (tail) capped.shown.push(tail);
		const labels: string[] = [];
		if (reviews.length > 0) labels.push(`Reviews ${reviews.length}`);
		if (comments.length > 0) labels.push(`Comments ${comments.length}`);
		sections.push({ label: labels.join(" · "), rows: capped.shown });
	}

	return boxed(R, theme, { header, sections });
}

/** One `#N title ⟦STATE⟧ @author · age` row per search hit. */
function ghSearchRows(theme: Any, items: Any[], cap: number): string[] {
	const rows = items.slice(0, cap).map((item, index) => {
		const last = index === Math.min(items.length, cap) - 1 && items.length <= cap;
		const prefix = fg(theme, "dim", last ? TREE.last : TREE.branch);
		const title = String(item.title ?? item.name ?? item.full_name ?? item.path ?? "Untitled");
		const parts: string[] = [];
		if (typeof item.number === "number") parts.push(fg(theme, "accent", `#${item.number}`));
		parts.push(fg(theme, "toolOutput", title));
		const badge = stateBadge(theme, item.state);
		if (badge) parts.push(badge);
		const author = ghUserLabel(item.author ?? item.user);
		const age = ageOf(item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at);
		const trail = [author, age].filter(part => part.length > 0).join(" · ");
		if (trail) parts.push(fg(theme, "dim", trail));
		return `${prefix}${parts.join(" ")}`;
	});
	if (items.length > cap) rows.push(fg(theme, "dim", `${TREE.last}… ${items.length - cap} more results`));
	return rows;
}

const RUN_ICON_BY_STATE: Record<string, StatusKindName> = {
	success: "success",
	neutral: "success",
	skipped: "done",
	completed: "success",
	failure: "error",
	timed_out: "error",
	cancelled: "error",
	action_required: "error",
	startup_failure: "error",
	in_progress: "running",
	queued: "pending",
	requested: "pending",
	waiting: "pending",
	pending: "pending",
};

type StatusKindName = keyof typeof STATUS;

function runStateIcon(theme: Any, conclusion: unknown, status: unknown): string {
	const key = String(conclusion || status || "").toLowerCase();
	return statusIcon(theme, RUN_ICON_BY_STATE[key] ?? "info");
}

function jobDuration(job: Any): string {
	const start = Date.parse(String(job.startedAt ?? ""));
	const end = Date.parse(String(job.completedAt ?? ""));
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
	const seconds = Math.round((end - start) / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function ghRunWatchBox(R: RenderSupport, theme: Any, details: Any, expanded: boolean): Any {
	const runs: Any[] = Array.isArray(details.runs)
		? details.runs
		: [
				{
					status: details.status,
					conclusion: details.conclusion,
					jobs: details.jobs,
					url: details.url,
					databaseId: details.runId,
					workflowName: details.workflowName,
					displayTitle: details.displayTitle,
					headBranch: details.headBranch,
					headSha: details.headSha,
				},
			];
	const first = runs[0] ?? {};
	const header = [
		fg(theme, "accent", "⎇"),
		fg(theme, "toolTitle", bold(theme, "Run Watch")),
		fg(theme, "toolOutput", String(first.workflowName ?? first.displayTitle ?? "")),
		stateBadge(theme, details.state === "completed" ? (first.conclusion ?? "completed") : "running"),
		fg(theme, "dim", [details.repo, first.headBranch, first.headSha?.slice(0, 7)].filter(Boolean).join(" · ")),
	]
		.filter(part => part.length > 0)
		.join(" ");

	const rows: string[] = [];
	for (const run of runs) {
		if (rows.length > 0) rows.push("");
		const runLabel = String(run.workflowName ?? run.displayTitle ?? "workflow");
		const runState = String(run.conclusion || run.status || "");
		rows.push(
			`${runStateIcon(theme, run.conclusion, run.status)} ${fg(theme, "toolOutput", runLabel)} ${runState ? stateBadge(theme, runState) : ""}`,
		);
		const jobs = (run.jobs ?? []) as Any[];
		jobs.forEach((job, index) => {
			const prefix = fg(theme, "dim", `  ${index === jobs.length - 1 ? TREE.last : TREE.branch}`);
			const duration = jobDuration(job);
			rows.push(
				`${prefix}${runStateIcon(theme, job.conclusion, job.status)} ${fg(theme, "toolOutput", String(job.name ?? "job"))}${duration ? ` ${fg(theme, "dim", duration)}` : ""}${!job.conclusion && job.status ? ` ${fg(theme, "dim", String(job.status))}` : ""}`,
			);
		});
	}
	const sections: BoxSection[] = [{ rows }];
	if (typeof details.failedLog === "string" && details.failedLog.length > 0) {
		const logRows = details.failedLog.split("\n").map((line: string) => fg(theme, "error", line));
		const windowed = bodyWindow(logRows, expanded, COLLAPSED_CODE_LINES);
		const tail = moreLine(R, theme, windowed.hidden, expanded);
		if (tail) windowed.shown.push(tail);
		sections.push({ label: "Failed log", rows: windowed.shown });
	}
	return boxed(R, theme, {
		header,
		borderColor: details.failedLog ? "error" : undefined,
		sections,
	});
}

export function githubRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const title = GITHUB_OP_TITLES[argText(args?.op)] ?? "GitHub";
			const line = statusLine(theme, { icon: statusIcon(theme, "pending"), title, meta: githubMeta(theme, args) });
			return pendingCall(R, context, [line]);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const op = argText(details?.op ?? callArgs?.op);
			const title = GITHUB_OP_TITLES[op] ?? "GitHub";
			if (context?.isError) return errorBox(R, theme, title, stripAnsi(githubMeta(theme, callArgs).join(" ")), result);
			const icon = fg(theme, "accent", "⎇");
			const data = details?.data as Any;

			if (op === "repo_view" && data?.nameWithOwner) return ghRepoBox(R, theme, data);
			if ((op === "pr_view" || op === "issue_view") && data?.number !== undefined) {
				return ghIssuePrBox(R, theme, op === "pr_view" ? "PR" : "Issue", data, expanded);
			}
			if (op === "pr_diff" && Array.isArray(data?.files)) {
				const files = data.files as Any[];
				const additions = files.reduce((sum: number, file: Any) => sum + (file.additions ?? 0), 0);
				const deletions = files.reduce((sum: number, file: Any) => sum + (file.deletions ?? 0), 0);
				const header = plainHeader(theme, icon, "GitHub PR Diff", [`${files.length} file${files.length === 1 ? "" : "s"}`]) + ` ${statPair(theme, additions, deletions)}`;
				return lineText(R, [header, ...ghFileRows(theme, files, expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS)]);
			}
			if (op === "search_code" && Array.isArray(data?.items)) {
				const items = data.items as Any[];
				if (items.length === 0) return noMatches(R, theme, title, argText(callArgs?.query));
				const groups: string[][] = items.map(item => {
					const scope = [item.repository?.full_name, item.path].filter(Boolean).join(":");
					const group = [fg(theme, "accent", scope || String(item.name ?? "match"))];
					const fragments = ((item.text_matches ?? []) as Any[])
						.map((match: Any) => match?.fragment)
						.filter((fragment: unknown): fragment is string => typeof fragment === "string");
					fragments.forEach((fragment, index) => {
						if (index > 0) group.push(fg(theme, "dim", "⋮"));
						for (const row of fragment.split("\n")) {
							group.push(fg(theme, "toolOutput", row.replace(/\t/g, "  ")));
						}
					});
					return group;
				});
				const header = statusLine(theme, {
					icon: fg(theme, "accent", "⌕"),
					title,
					description: fg(theme, "accent", argText(callArgs?.query)),
					meta: [fg(theme, "success", `${items.length} result${items.length === 1 ? "" : "s"}`)],
				});
				const body = treeRows(theme, groups);
				const windowed = bodyWindow(body, expanded, COLLAPSED_TREE_LINES);
				const tail = moreLine(R, theme, windowed.hidden, expanded);
				if (tail) windowed.shown.push(fg(theme, "dim", TREE.blank) + tail);
				return lineText(R, [header, ...windowed.shown]);
			}
			if (op.startsWith("search_") && Array.isArray(data?.items)) {
				const items = data.items as Any[];
				if (items.length === 0) return noMatches(R, theme, title, argText(callArgs?.query));
				const header = statusLine(theme, {
					icon: fg(theme, "accent", "⌕"),
					title,
					description: fg(theme, "accent", argText(callArgs?.query)),
					meta: [fg(theme, "success", `${items.length} result${items.length === 1 ? "" : "s"}`)],
				});
				return lineText(R, [header, ...ghSearchRows(theme, items, expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS)]);
			}
			if (op === "pr_create" && typeof details?.url === "string") {
				const refs = [details.head, details.base].filter(Boolean);
				const headerParts = [
					statusIcon(theme, "success"),
					fg(theme, "toolTitle", bold(theme, "GitHub PR Create:")),
					details.title ? fg(theme, "toolOutput", String(details.title)) : "",
					stateBadge(theme, details.draft === true ? "draft" : "open"),
				].filter((part: string) => part.length > 0);
				const factRow =
					fg(theme, "dim", TREE.last) +
					fg(theme, "accent", String(details.url)) +
					(refs.length === 2 ? fg(theme, "dim", ` · ${refs[0]} → ${refs[1]}`) : "");
				return lineText(R, [headerParts.join(" "), factRow]);
			}
			if (op === "pr_checkout" && Array.isArray(details?.checkouts)) {
				const checkouts = details.checkouts as Any[];
				const lines = [
					plainHeader(theme, icon, "GitHub PR Checkout", [`${checkouts.length} pull request${checkouts.length === 1 ? "" : "s"}`]),
				];
				checkouts.forEach((checkout, index) => {
					const prefix = fg(theme, "dim", index === checkouts.length - 1 ? TREE.last : TREE.branch);
					lines.push(
						`${prefix}${fg(theme, "accent", `#${checkout.prNumber}`)} ${stateBadge(theme, checkout.reused ? "ready" : "open") || ""} ${fg(theme, "toolOutput", String(checkout.worktreePath))} ${fg(theme, "dim", `· ${checkout.branch} · remote ${checkout.remoteBranch}${checkout.reused ? " · reused" : ""}`)}`,
					);
				});
				return lineText(R, lines);
			}
			if (op === "pr_push" && typeof details?.remoteBranch === "string") {
				const header = [
					icon,
					fg(theme, "toolTitle", bold(theme, "GitHub PR Push:")),
					fg(theme, "accent", String(details.branch ?? "HEAD")),
					fg(theme, "dim", "→"),
					fg(theme, "accent", String(details.remoteBranch)),
					stateBadge(theme, "pushed"),
				].join(" ");
				const rows = [header];
				if (details.url) rows.push(fg(theme, "dim", TREE.last) + fg(theme, "accent", String(details.url)));
				return lineText(R, rows);
			}
			if (op === "file_read" && typeof details?.output === "string") {
				const filePath = argText(callArgs?.path);
				const fileLines = details.output.replace(/\n$/, "").split("\n");
				const rows = codeRows(
					R,
					theme,
					fileLines.map((text: string, index: number) => ({ n: index + 1, text })),
					{ language: languageFor(R, filePath) },
				);
				const windowed = bodyWindow(rows, expanded, COLLAPSED_CODE_LINES);
				const tail = moreLine(R, theme, windowed.hidden, expanded);
				if (tail) windowed.shown.push(tail);
				const scope = [details.repo, filePath].filter(Boolean).join(":") + (details.branch ? ` @ ${details.branch}` : "");
				return boxed(R, theme, {
					header: `${icon} ${fg(theme, "muted", fileIcon(filePath))} ${fg(theme, "toolTitle", bold(theme, "GitHub File:"))} ${fg(theme, "accent", scope)}${fg(theme, "dim", ` · ${fileLines.length} line${fileLines.length === 1 ? "" : "s"}`)}`,
					sections: [{ rows: windowed.shown }],
				});
			}
			if (op === "run_watch" && (Array.isArray(details?.runs) || Array.isArray(details?.jobs))) {
				return ghRunWatchBox(R, theme, details, expanded);
			}

			// Fallback: text lines, boxed when multi-line.
			const lines = textOf(result).split("\n");
			while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
				return lineText(R, [statusLine(theme, { icon, title, description: fg(theme, "dim", "no output") })]);
			}
			if (lines.length === 1) {
				return lineText(R, [statusLine(theme, { icon, title, description: fg(theme, "toolOutput", lines[0] as string) })]);
			}
			const rows = lines.map(line => fg(theme, "toolOutput", line));
			const { shown, hidden } = bodyWindow(rows, expanded, 20);
			const tail = moreLine(R, theme, hidden, expanded);
			if (tail) shown.push(tail);
			return boxed(R, theme, { header: plainHeader(theme, icon, title, githubMeta(theme, callArgs)), sections: [{ rows: shown }] });
		},
	};
}

/* ------------------------------ web_search ----------------------------- */

export function webSearchRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const query = argText(args?.query);
			const line = statusLine(theme, {
				icon: statusIcon(theme, "pending"),
				title: "Web Search",
				description: fg(theme, "muted", query.length > 80 ? `${query.slice(0, 79)}…` : query),
			});
			return pendingCall(R, context, [line]);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const query = typeof details?.query === "string" ? details.query : argText(callArgs?.query);
			if (context?.isError) return errorBox(R, theme, "Web Search", query, result);
			if (typeof details?.provider !== "string") return lineText(R, [fg(theme, "toolOutput", textOf(result))]);

			const citations = (Array.isArray(details.citations) ? details.citations : []) as Any[];
			const text = textOf(result);
			const marker = text.indexOf("\nSources:");
			const answer = (marker >= 0 ? text.slice(0, marker) : text).trimEnd();
			const answerRows = answer.split("\n").map(line => fg(theme, "toolOutput", line));
			const { shown, hidden } = bodyWindow(answerRows, expanded, COLLAPSED_CODE_LINES);
			const tail = moreLine(R, theme, hidden, expanded);
			if (tail) shown.push(tail);

			const sourceCap = expanded ? EXPANDED_LINES : COLLAPSED_LIST_ITEMS;
			const sourceRows = citations.slice(0, sourceCap).map((citation, index) => {
				const last = index === Math.min(citations.length, sourceCap) - 1 && citations.length <= sourceCap;
				let domain = "";
				try {
					domain = new URL(String(citation.url ?? "")).hostname.replace(/^www\./, "");
				} catch {
					/* keep empty */
				}
				const label = fg(theme, "accent", String(citation.title ?? citation.url ?? ""));
				const suffix = domain ? ` ${fg(theme, "dim", `(${domain})`)}` : "";
				return `${fg(theme, "dim", last ? TREE.last : TREE.branch)}${label}${suffix}`;
			});
			if (citations.length > sourceCap) {
				sourceRows.push(fg(theme, "dim", TREE.last) + moreLine(R, theme, citations.length - sourceCap, expanded, "sources"));
			}
			if (sourceRows.length === 0) sourceRows.push(fg(theme, "muted", "No sources returned"));

			const ok = citations.length > 0;
			return boxed(R, theme, {
				header: statusLine(theme, {
					icon: ok ? fg(theme, "accent", "⌕") : statusIcon(theme, "warning"),
					title: "Web Search",
					description: fg(theme, "accent", details.provider),
					meta: [fg(theme, ok ? "success" : "warning", `${citations.length} source${citations.length === 1 ? "" : "s"}`)],
				}),
				sections: [
					{ rows: [`${fg(theme, "muted", "Query:")} ${fg(theme, "accent", query)}`] },
					{ label: "Answer", rows: shown },
					{ label: "Sources", rows: sourceRows },
					{ label: "Metadata", rows: [`${fg(theme, "muted", "Provider:")} ${fg(theme, "accent", details.provider)}`] },
				],
			});
		},
	};
}

/* ----------------------------- inspect_image --------------------------- */

export function inspectImageRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const question = argText(args?.question);
			const lines = [
				statusLine(theme, {
					icon: statusIcon(theme, "pending"),
					title: "Inspect",
					description: fg(theme, "accent", argText(args?.path)),
				}),
				`${fg(theme, "dim", TREE.last)}${fg(theme, "muted", "Question:")} ${fg(theme, "accent", question.length > 100 ? `${question.slice(0, 99)}…` : question)}`,
			];
			return pendingCall(R, context, lines);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const path = typeof details?.imagePath === "string" ? details.imagePath : argText(callArgs?.path);
			if (context?.isError) return errorBox(R, theme, "Inspect", path, result);
			const meta: string[] = [];
			if (typeof details?.model === "string") meta.push(details.model);
			if (typeof details?.mimeType === "string") meta.push(details.mimeType);
			const header = statusLine(theme, {
				icon: fg(theme, "accent", "▣"),
				title: "Inspect",
				description: fg(theme, "accent", path) + (meta.length > 0 ? fg(theme, "dim", ` · ${meta.join(" · ")}`) : ""),
			});
			const parts = (result?.content ?? []) as Any[];
			if (parts.some((part: Any) => part.type === "image")) {
				// No vision provider: the tool passed the image through for the model.
				return lineText(R, [header, fg(theme, "dim", "image passed through to the model")]);
			}
			const question = argText(callArgs?.question);
			const rows = [
				`${fg(theme, "muted", "Question:")} ${fg(theme, "accent", question.length > 100 ? `${question.slice(0, 99)}…` : question)}`,
				"",
				...textOf(result)
					.split("\n")
					.map(line => fg(theme, "toolOutput", line)),
			];
			const { shown, hidden } = bodyWindow(rows, expanded, COLLAPSED_CODE_LINES + 2);
			const tail = moreLine(R, theme, hidden, expanded);
			if (tail) shown.push(tail);
			return boxed(R, theme, { header, sections: [{ rows: shown }] });
		},
	};
}

/* -------------------------------- browser ------------------------------ */

function browserTitle(action: string, args: Any): string {
	const name = typeof args?.name === "string" ? args.name : "main";
	if (action === "open") return `Open tab "${name}"`;
	if (action === "close") {
		if (args?.all === true) return `Close all tabs${args?.kill === true ? " (kill)" : ""}`;
		return `Close tab "${name}"`;
	}
	return `tab "${name}"`;
}

export function browserRenderers(R: RenderSupport): Renderers {
	return {
		renderCall(args, theme, context) {
			const action = argText(args?.action);
			if (action === "run") {
				const state = stateOf(context);
				const header = `${statusIcon(theme, "running")} ${fg(theme, "toolTitle", bold(theme, browserTitle(action, args)))}`;
				const code = typeof args?.code === "string" ? args.code : "";
				return {
					render(width: number): string[] {
						if (state?.done) return [];
						const rows = highlight(R, code.replace(/\n$/, ""), "javascript", theme);
						const capped = rows.slice(0, COLLAPSED_CODE_LINES);
						if (rows.length > capped.length) capped.push(fg(theme, "dim", `… ${rows.length - capped.length} more lines`));
						return boxed(R, theme, { header, sections: [{ rows: capped }] }).render(width);
					},
					invalidate(): void {},
				};
			}
			const description = typeof args?.url === "string" ? fg(theme, "accent", args.url) : undefined;
			const line = statusLine(theme, { icon: statusIcon(theme, "pending"), title: browserTitle(action, args), description });
			return pendingCall(R, context, [line]);
		},
		renderResult(result, { expanded }, theme, context) {
			markDone(context);
			const details = result?.details as Any;
			const callArgs = context?.args as Any;
			const action = argText(details?.action ?? callArgs?.action);
			const title = browserTitle(action, callArgs);
			const lines = textOf(result)
				.split("\n")
				.filter(line => line.length > 0);
			if (context?.isError) {
				return errorBox(R, theme, title, typeof details?.url === "string" ? details.url : "", result);
			}
			if (action !== "run") {
				const meta: string[] = [];
				if (typeof details?.url === "string") meta.push(fg(theme, "accent", details.url));
				return lineText(R, [
					plainHeader(theme, fg(theme, "accent", "⌂"), title, meta),
					...lines.map(line => fg(theme, "toolOutput", line)),
				]);
			}
			const code = typeof callArgs?.code === "string" ? callArgs.code : "";
			const codeRowsShown = highlight(R, code.replace(/\n$/, ""), "javascript", theme);
			const { shown, hidden } = bodyWindow(codeRowsShown, expanded, COLLAPSED_CODE_LINES);
			const codeTail = moreLine(R, theme, hidden, expanded);
			if (codeTail) shown.push(codeTail);
			const outputRows = lines.map(line => fg(theme, "toolOutput", line));
			const outputWindow = bodyWindow(outputRows, expanded, COLLAPSED_LIST_ITEMS);
			const outputTail = moreLine(R, theme, outputWindow.hidden, expanded);
			if (outputTail) outputWindow.shown.push(outputTail);
			const sections: BoxSection[] = [{ rows: shown }];
			if (outputWindow.shown.length > 0) sections.push({ label: "Output", rows: outputWindow.shown });
			return boxed(R, theme, {
				header: `${statusIcon(theme, "done")} ${fg(theme, "toolTitle", bold(theme, title))}`,
				sections,
			});
		},
	};
}
