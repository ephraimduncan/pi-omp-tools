/**
 * pi-omp-statusline: oh-my-pi's input chrome for pi / prime-agent (in-process).
 *
 * Clones omp's signature input area:
 *  - the editor is a full rounded box (omp style), not a bare top rule
 *  - the status line renders INSIDE the editor's top border, exactly like
 *    omp's setTopBorderProvider wiring: π · model+thinking · path · git
 *    (*unstaged +staged ?untracked) · context% · cost, gap-filled with
 *    border-colored ─, session name in the right group
 *  - the bottom footer is emptied (omp has no bottom bar)
 *
 * Prime's startup logo/header is intentionally left untouched.
 * Toggle everything with /omp. In-process hosts only (pi, prime launcher).
 */
import { execFile } from "node:child_process";
import * as os from "node:os";
// Host-provided virtual modules (pi and prime both alias these for extensions).
// @ts-ignore -- resolved by the host's extension loader, not at compile time
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// biome-ignore lint/suspicious/noExplicitAny: host surfaces are structurally typed
type Any = any;

/* omp dark statusLine palette (oh-my-pi theme/dark.json) */
const FG_MODEL = "\x1b[38;2;215;135;175m"; // #d787af
const FG_PATH = "\x1b[38;2;0;175;175m"; // #00afaf
const FG_GIT_CLEAN = "\x1b[38;2;95;175;95m"; // #5faf5f
const FG_GIT_DIRTY = "\x1b[38;2;215;175;95m"; // #d7af5f
const FG_CONTEXT = "\x1b[38;2;135;135;175m"; // #8787af
const FG_COST = "\x1b[38;2;95;175;175m"; // #5fafaf
const FG_STAGED = "\x1b[38;5;70m";
const FG_UNSTAGED = "\x1b[38;5;178m";
const FG_UNTRACKED = "\x1b[38;5;39m";
const FG_SEP = "\x1b[38;5;244m";
const FG_ACCENT = "\x1b[38;2;254;188;56m"; // #febc38
const FG_WARN = "\x1b[38;2;228;192;15m";
const FG_ERR = "\x1b[38;2;252;58;75m";
const RESET_FG = "\x1b[39m";
const SEP = `${FG_SEP} ┆ ${RESET_FG}`;

const THINKING_GLYPHS: Record<string, string> = {
	off: "⦸ off",
	minimal: "○ min",
	low: "◔ low",
	medium: "◑ med",
	high: "◒ high",
	xhigh: "◕ xhigh",
	max: "◉ max",
};

interface GitInfo {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

function abbreviatePath(cwd: string, maxLength = 40): string {
	let display = cwd.startsWith(os.homedir()) ? `~${cwd.slice(os.homedir().length)}` : cwd;
	if (display.length <= maxLength) return display;
	const parts = display.split("/");
	const kept = parts.slice(-2);
	const head = parts.slice(0, -2).map(part => (part.length > 1 ? part[0] : part));
	display = [...head, ...kept].join("/");
	if (display.length > maxLength) display = `…${display.slice(-maxLength + 1)}`;
	return display;
}

export default function ompChrome(pi: Any): void {
	let enabled = true;
	let git: GitInfo = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
	let gitTimer: ReturnType<typeof setInterval> | undefined;

	const refreshGit = (cwd: string, onDone?: () => void): void => {
		execFile("git", ["status", "--porcelain=v1", "--branch"], { cwd, timeout: 3000 }, (error, stdout) => {
			if (error) {
				git = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
				onDone?.();
				return;
			}
			const info: GitInfo = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
			for (const line of stdout.split("\n")) {
				if (!line) continue;
				if (line.startsWith("## ")) {
					info.branch = line.slice(3).split("...")[0] ?? null;
					continue;
				}
				const x = line[0] ?? " ";
				const y = line[1] ?? " ";
				if (x === "?") info.untracked++;
				else {
					if (x !== " ") info.staged++;
					if (y !== " ") info.unstaged++;
				}
			}
			git = info;
			onDone?.();
		});
	};

	/** Left status group, omp segment order: π · model+thinking · path · git · ◫% · $ */
	const buildLeftStatus = (ctx: Any): string => {
		const segments: string[] = [];
		segments.push(`${FG_ACCENT}π${RESET_FG}`);

		const model = ctx.model;
		let modelName: string = model?.name ?? model?.id ?? "no-model";
		if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
		let thinking = "";
		const level: string | undefined = ctx.thinkingLevel;
		if (level && model?.reasoning !== false) thinking = ` ${THINKING_GLYPHS[level] ?? level}`;
		segments.push(`${FG_MODEL}${modelName}${thinking}${RESET_FG}`);

		segments.push(`${FG_PATH}${abbreviatePath(ctx.cwd ?? process.cwd())}${RESET_FG}`);

		if (git.branch) {
			const dirty = git.staged > 0 || git.unstaged > 0 || git.untracked > 0;
			const branchColor = dirty ? FG_GIT_DIRTY : FG_GIT_CLEAN;
			const indicators: string[] = [];
			if (git.unstaged > 0) indicators.push(`${FG_UNSTAGED}*${git.unstaged}${RESET_FG}`);
			if (git.staged > 0) indicators.push(`${FG_STAGED}+${git.staged}${RESET_FG}`);
			if (git.untracked > 0) indicators.push(`${FG_UNTRACKED}?${git.untracked}${RESET_FG}`);
			segments.push(`${branchColor}⑂ ${git.branch}${RESET_FG}${indicators.length ? ` ${indicators.join(" ")}` : ""}`);
		}

		const usage = ctx.getContextUsage?.();
		if (usage) {
			const window = usage.contextWindow ?? ctx.model?.contextWindow;
			const pct =
				typeof usage.percent === "number" ? usage.percent : window ? (usage.tokens / window) * 100 : undefined;
			if (pct !== undefined) {
				const color = pct >= 90 ? FG_ERR : pct >= 70 ? FG_WARN : FG_CONTEXT;
				segments.push(`${color}◫ ${pct.toFixed(0)}%${RESET_FG}`);
			}
		}

		let cost = 0;
		try {
			for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
				if (entry.type === "message" && entry.message?.role === "assistant") {
					cost += entry.message.usage?.cost?.total ?? 0;
				}
			}
		} catch {
			/* session shapes vary */
		}
		if (cost > 0) segments.push(`${FG_COST}$${cost.toFixed(2)}${RESET_FG}`);

		return segments.join(SEP);
	};

	const installChrome = async (ctx: Any): Promise<void> => {
		// @ts-ignore -- host virtual module
		const host = (await import("@earendil-works/pi-coding-agent")) as Any;
		const BaseEditor = host.CustomEditor;
		if (!BaseEditor) return;

		refreshGit(ctx.cwd ?? process.cwd());
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = setInterval(() => refreshGit(ctx.cwd ?? process.cwd()), 5000);

		/* omp box border colors (theme/dark.json): borderMuted / bashMode / border */
		const BORDER_FG = "\x1b[38;2;61;66;74m"; // #3d424a
		const BORDER_BASH_FG = "\x1b[38;2;0;136;250m"; // #0088fa
		const BORDER_GAP_FG = "\x1b[38;2;23;143;185m"; // #178fb9

		class OmpEditor extends BaseEditor {
			// biome-ignore lint/complexity/noUselessConstructor: keeps typed ctor over `any` base
			constructor(tui: Any, theme: Any, keybindings: Any, options?: Any) {
				super(tui, theme, keybindings, options);
			}

			render(width: number): string[] {
				if (width < 24) return super.render(width) as string[];
				const innerContent = width - 4; // "│ " … " │"
				// omp's editor has no background surface — the box sits on the plain
				// terminal bg. Prime assigns a userMessageBg surface to the editor
				// (updateEditorBorderColor); clear it for the base render so we get
				// the surface-less path (plain rows + rules, which we strip).
				const editorState = this as Any;
				const savedBackground = editorState.backgroundColor;
				let base: string[];
				try {
					editorState.backgroundColor = undefined;
					base = super.render(innerContent) as string[];
				} finally {
					editorState.backgroundColor = savedBackground;
				}
				if (base.length < 2) return base;

				// The base editor frames content with a top and bottom rule; strip
				// them and preserve any scroll indicators they carried.
				const topRule = base[0] ?? "";
				const bottomRule = base[base.length - 1] ?? "";
				const body = base.slice(1, -1);
				const scrollUp = /↑\s*(\d+)/.exec(topRule)?.[1];
				const scrollDown = /↓\s*(\d+)/.exec(bottomRule)?.[1];

				// bash-mode ("!"/"!!") tints the box border, like omp.
				const firstLine = (this.getLines()[0] ?? "").trimStart();
				const borderFg = firstLine.startsWith("!") ? BORDER_BASH_FG : BORDER_FG;
				const border = (text: string): string => `${borderFg}${text}${RESET_FG}`;
				const gapFill = (count: number): string =>
					count > 0 ? `${BORDER_GAP_FG}${"─".repeat(count)}${RESET_FG}` : "";

				// Top border: ╭─ status ─── session ─╮  (status inside the border)
				const budget = width - 4; // corners + one ─ each side
				let left = ` ${buildLeftStatus(ctx)} `;
				if (visibleWidth(left) > budget) left = truncateToWidth(left, budget, "…");
				const sessionName: string = ctx.sessionManager?.getSessionName?.() ?? "";
				let right = sessionName ? `${FG_ACCENT} ${sessionName} ${RESET_FG}` : "";
				if (visibleWidth(left) + visibleWidth(right) > budget) right = "";
				const gap = budget - visibleWidth(left) - visibleWidth(right);
				const top = border("╭─") + left + gapFill(gap) + right + border("─╮");

				// Body rows: │ content │
				const rows = body.map(line => {
					const pad = " ".repeat(Math.max(0, innerContent - visibleWidth(line)));
					return `${border("│ ")}${line}${pad}${border(" │")}`;
				});

				// Bottom border, with preserved scroll hints: ╰─ ↑2 ↓3 ───╯
				let hint = "";
				if (scrollUp) hint += ` ↑${scrollUp}`;
				if (scrollDown) hint += ` ↓${scrollDown}`;
				if (hint) hint += " ";
				const bottomGap = Math.max(0, width - 4 - visibleWidth(hint));
				const bottom = border("╰─") + border(hint) + border("─".repeat(bottomGap)) + border("─╯");

				return [top, ...rows, bottom];
			}
		}

		ctx.ui.setEditorComponent((tui: Any, theme: Any, keybindings: Any) => new OmpEditor(tui, theme, keybindings));
		// omp has no bottom bar — the status lives in the editor's top border.
		ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	};

	const removeChrome = (ctx: Any): void => {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = undefined;
	};

	// ── usage-row timing bridge ────────────────────────────────────────────
	// omp appends `time  ⤵ in  ⤴ out  💾 cache  ⏱ ttft  ⚡ tok/s` under every
	// assistant message. Rendering happens via the prime-omp launcher's
	// AssistantMessageComponent patch; the ⏱/⚡ numbers only exist as stream
	// timing, recorded here and bridged through globalThis.
	const TIMING_KEY = Symbol.for("omp-tools.usage-timings.v1");
	const globalRegistry = globalThis as Record<PropertyKey, unknown>;
	globalRegistry[TIMING_KEY] ??= [];
	const timings = globalRegistry[TIMING_KEY] as Array<Record<string, number>>;
	let messageStartedAt = 0;
	let firstTokenAt = 0;

	pi.on?.("message_start", async (event: Any) => {
		if (event?.message?.role !== "assistant") return;
		messageStartedAt = Date.now();
		firstTokenAt = 0;
	});
	pi.on?.("message_update", async (event: Any) => {
		if (event?.message?.role !== "assistant" || firstTokenAt !== 0) return;
		// TTFT counts from the first update that carries visible bytes, not the
		// initial empty delta.
		const content = event?.message?.content;
		const hasBytes =
			Array.isArray(content) &&
			content.some((block: Any) => (block?.text?.length ?? 0) > 0 || (block?.thinking?.length ?? 0) > 0);
		if (hasBytes) firstTokenAt = Date.now();
	});
	pi.on?.("message_end", async (event: Any) => {
		const message = event?.message;
		if (message?.role !== "assistant" || !message.usage || messageStartedAt === 0) return;
		const now = Date.now();
		timings.push({
			input: message.usage.input ?? 0,
			output: message.usage.output ?? 0,
			cacheRead: message.usage.cacheRead ?? 0,
			cacheWrite: message.usage.cacheWrite ?? 0,
			durationMs: now - messageStartedAt,
			ttftMs: firstTokenAt > 0 ? firstTokenAt - messageStartedAt : 0,
			at: now,
		});
		if (timings.length > 300) timings.splice(0, timings.length - 300);
		messageStartedAt = 0;
	});

	pi.on?.("session_start", async (_event: Any, ctx: Any) => {
		if (!enabled || ctx.hasUI === false) return;
		try {
			await installChrome(ctx);
		} catch {
			/* host without editor/footer APIs — leave defaults */
		}
	});

	// The TUI's footer slot may not exist yet when session_start fires during
	// startup; re-assert the empty footer when the first agent turn begins.
	pi.on?.("agent_start", async (_event: Any, ctx: Any) => {
		if (!enabled || ctx.hasUI === false) return;
		try {
			ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
		} catch {
			/* ignore */
		}
	});

	pi.registerCommand?.("omp", {
		description: "Toggle the omp input chrome (boxed editor with embedded status line)",
		handler: async (_args: Any, ctx: Any) => {
			enabled = !enabled;
			if (enabled) {
				await installChrome(ctx);
				ctx.ui.notify("omp chrome enabled", "info");
			} else {
				removeChrome(ctx);
				ctx.ui.notify("default chrome restored", "info");
			}
		},
	});
}
