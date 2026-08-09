/**
 * pi-omp-statusline: oh-my-pi's status line for pi / prime-agent (in-process).
 *
 * Replicates omp's default footer preset — left: π · model+thinking · path ·
 * git (branch *unstaged +staged ?untracked) · context% · cost; right: session
 * name — with omp's exact segment colors (statusLine* values from omp's
 * dark theme). Toggle with /statusline.
 *
 * Note: footers are render functions; they only apply where the TUI runs in
 * the same process as extensions (pi, or prime via the prime-omp launcher).
 */
import { execFile } from "node:child_process";
import * as os from "node:os";

// biome-ignore lint/suspicious/noExplicitAny: host surfaces are structurally typed
type Any = any;

/* omp dark statusLine palette (packages/coding-agent/src/modes/theme/dark.json) */
const BG = { r: 18, g: 18, b: 18 }; // #121212
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
const BG_ON = `\x1b[48;2;${BG.r};${BG.g};${BG.b}m`;
const BG_OFF = "\x1b[49m";
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

function visibleWidthOf(text: string): number {
	// strip SGR sequences; assume single-width glyphs (footer content is curated)
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateVisible(text: string, max: number): string {
	let width = 0;
	let out = "";
	for (let i = 0; i < text.length; ) {
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) break;
			out += text.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (width >= max) break;
		out += text[i];
		width++;
		i++;
	}
	return out;
}

function abbreviatePath(cwd: string, maxLength = 40): string {
	let display = cwd.startsWith(os.homedir()) ? `~${cwd.slice(os.homedir().length)}` : cwd;
	if (display.length <= maxLength) return display;
	const parts = display.split("/");
	// fish-style: abbreviate all but the last two segments to one char
	const kept = parts.slice(-2);
	const head = parts.slice(0, -2).map(part => (part.length > 1 ? part[0] : part));
	display = [...head, ...kept].join("/");
	if (display.length > maxLength) display = `…${display.slice(-maxLength + 1)}`;
	return display;
}

export default function ompStatusline(pi: Any): void {
	let enabled = true;
	let git: GitInfo = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
	let gitTimer: ReturnType<typeof setInterval> | undefined;

	const refreshGit = (cwd: string, onDone?: () => void): void => {
		execFile(
			"git",
			["status", "--porcelain=v1", "--branch"],
			{ cwd, timeout: 3000 },
			(error, stdout) => {
				if (error) {
					git = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
					onDone?.();
					return;
				}
				const lines = stdout.split("\n").filter(Boolean);
				const info: GitInfo = { branch: null, staged: 0, unstaged: 0, untracked: 0 };
				for (const line of lines) {
					if (line.startsWith("## ")) {
						info.branch = line.slice(3).split("...")[0] ?? null;
						continue;
					}
					const x = line[0] ?? " ";
					const y = line[1] ?? " ";
					if (x === "?" ) info.untracked++;
					else {
						if (x !== " ") info.staged++;
						if (y !== " ") info.unstaged++;
					}
				}
				git = info;
				onDone?.();
			},
		);
	};

	const installFooter = (ctx: Any): void => {
		ctx.ui.setFooter((tui: Any, _theme: Any, footerData: Any) => {
			const unsubscribe = footerData?.onBranchChange?.(() => {
				refreshGit(ctx.cwd ?? process.cwd(), () => tui.requestRender());
			});
			refreshGit(ctx.cwd ?? process.cwd(), () => tui.requestRender());
			if (gitTimer) clearInterval(gitTimer);
			gitTimer = setInterval(() => refreshGit(ctx.cwd ?? process.cwd(), () => tui.requestRender()), 5000);

			return {
				dispose() {
					unsubscribe?.();
					if (gitTimer) clearInterval(gitTimer);
					gitTimer = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const segments: string[] = [];

					// π
					segments.push(`${FG_ACCENT}π${RESET_FG}`);

					// model + thinking
					const model = ctx.model;
					let modelName: string = model?.name ?? model?.id ?? "no-model";
					if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
					let thinking = "";
					const level: string | undefined = ctx.thinkingLevel;
					if (model?.reasoning !== false && level) {
						thinking = ` ${THINKING_GLYPHS[level] ?? level}`;
					}
					segments.push(`${FG_MODEL}${modelName}${thinking}${RESET_FG}`);

					// path
					segments.push(`${FG_PATH}${abbreviatePath(ctx.cwd ?? process.cwd())}${RESET_FG}`);

					// git
					if (git.branch) {
						const dirty = git.staged > 0 || git.unstaged > 0 || git.untracked > 0;
						const branchColor = dirty ? FG_GIT_DIRTY : FG_GIT_CLEAN;
						const indicators: string[] = [];
						if (git.unstaged > 0) indicators.push(`${FG_UNSTAGED}*${git.unstaged}${RESET_FG}`);
						if (git.staged > 0) indicators.push(`${FG_STAGED}+${git.staged}${RESET_FG}`);
						if (git.untracked > 0) indicators.push(`${FG_UNTRACKED}?${git.untracked}${RESET_FG}`);
						segments.push(
							`${branchColor}⑂ ${git.branch}${RESET_FG}${indicators.length ? ` ${indicators.join(" ")}` : ""}`,
						);
					}

					// context %
					const usage = ctx.getContextUsage?.();
					if (usage) {
						const window = usage.contextWindow ?? ctx.model?.contextWindow;
						const pct =
							typeof usage.percent === "number"
								? usage.percent
								: window
									? (usage.tokens / window) * 100
									: undefined;
						if (pct !== undefined) {
							const color = pct >= 90 ? FG_ERR : pct >= 70 ? FG_WARN : FG_CONTEXT;
							segments.push(`${color}◫ ${pct.toFixed(0)}%${RESET_FG}`);
						}
					}

					// cost
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

					const left = ` ${segments.join(SEP)}`;
					const sessionName: string = ctx.sessionManager?.getSessionName?.() ?? "";
					const right = sessionName ? `${FG_ACCENT}${sessionName}${RESET_FG} ` : "";

					const leftWidth = visibleWidthOf(left);
					const rightWidth = visibleWidthOf(right);
					let line: string;
					if (leftWidth + rightWidth + 1 <= width) {
						line = left + " ".repeat(width - leftWidth - rightWidth) + right;
					} else {
						line = `${truncateVisible(left, Math.max(0, width - 1))} `;
						const lineWidth = visibleWidthOf(line);
						if (lineWidth < width) line += " ".repeat(width - lineWidth);
					}
					return [`${BG_ON}${line}${RESET_FG}${BG_OFF}`];
				},
			};
		});
	};

	pi.on?.("session_start", async (_event: Any, ctx: Any) => {
		if (enabled && ctx.hasUI !== false && typeof ctx.ui?.setFooter === "function") {
			try {
				installFooter(ctx);
			} catch {
				/* host without footer API */
			}
		}
	});

	pi.registerCommand?.("statusline", {
		description: "Toggle the omp-style status line footer",
		handler: async (_args: Any, ctx: Any) => {
			enabled = !enabled;
			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("omp status line enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("default footer restored", "info");
			}
		},
	});
}
