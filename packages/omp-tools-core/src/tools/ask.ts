/**
 * `ask` — structured follow-up questions for interactive runs, replicating
 * oh-my-pi's ask tool contract on pi's portable dialog surface
 * (`ctx.ui.select` / `ctx.ui.input`, available in TUI and RPC modes):
 *
 *  - One call carries several `questions`; each renders as a picker with the
 *    model's options plus an automatic "Other (type your own)" entry and a
 *    "Chat about this" escape that redirects the discussion to the chat.
 *  - `recommended` marks the default option (suffix added automatically);
 *    `multi: true` emulates omp's checkbox picker via a toggle loop.
 *  - Non-interactive runs (print/JSON) fail fast with a clear instruction to
 *    proceed on stated assumptions instead.
 */
import { Type } from "typebox";
import { textResult, ToolError, type PiApi, type ToolCtx, type ToolResult } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { askRenderers, loadRenderSupport } from "../render.ts";

export const OTHER_OPTION = "Other (type your own)";
export const CHAT_OPTION = "Chat about this";
const DONE_OPTION = "✓ Done";
const RESERVED_LABELS = new Set([OTHER_OPTION, CHAT_OPTION, DONE_OPTION]);
const MAX_OPTION_WIDTH = 100;

export const ASK_DESCRIPTION = `Ask the user structured follow-up questions during interactive runs.

<conditions>
- Multiple approaches with significantly different tradeoffs the user should weigh.
</conditions>

<instruction>
- Use one call with several \`questions\` for related decisions, not one call per question.
- \`recommended: <index>\` marks the default (0-indexed); " (Recommended)" is added automatically.
- Set \`multi: true\` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs go in \`description\`, not labels.
- Provide 2-5 concise, distinct options per question.
</instruction>

<critical>
- Default to action. Resolve ambiguity via repo conventions, existing patterns, and reasonable defaults; exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
- Do NOT include an "Other" option; the UI automatically adds "${OTHER_OPTION}" to every question.
- Requires an interactive session (TUI/RPC). In print/JSON runs, state your assumption and proceed instead.
</critical>`;

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	id?: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi?: boolean;
	recommended?: number;
}

export interface AskParams {
	questions: AskQuestion[];
}

export interface AskQuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	cancelled?: boolean;
}

/** Dialog surface subset used by ask; matches pi/prime's ExtensionUIContext. */
export interface AskUi {
	select(title: string, options: string[], opts?: Record<string, unknown>): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<string | undefined>;
}

function uiOf(ctx: ToolCtx | undefined): AskUi | undefined {
	const candidate = (ctx as { ui?: unknown; hasUI?: boolean } | undefined)?.ui as AskUi | undefined;
	if (!candidate || typeof candidate.select !== "function" || typeof candidate.input !== "function") return undefined;
	const hasUI = (ctx as { hasUI?: boolean } | undefined)?.hasUI;
	if (hasUI === false) return undefined;
	return candidate;
}

/* ---------------------------- omp-style dialog --------------------------- */

/** Host ui surface with pi's custom-component dialog (TUI mode only). */
interface AskCustomUi {
	custom<T>(factory: (tui: Any, theme: Any, keybindings: Any, done: (value: T) => void) => Any): Promise<T>;
}
// biome-ignore lint/suspicious/noExplicitAny: host TUI modules are structurally typed
type Any = any;

interface AskTuiDeps {
	Editor: new (tui: Any, theme: Any) => Any;
	Key: Record<string, Any>;
	matchesKey: (data: string, key: Any) => boolean;
	visibleWidth?: (text: string) => number;
}

let askTuiDepsPromise: Promise<AskTuiDeps | null> | undefined;
function loadAskTuiDeps(): Promise<AskTuiDeps | null> {
	askTuiDepsPromise ??= (async () => {
		try {
			// @ts-ignore -- host-only module, resolved at runtime
			const tui = (await import("@earendil-works/pi-tui")) as Any;
			if (!tui?.Editor || !tui?.Key || typeof tui?.matchesKey !== "function") return null;
			return { Editor: tui.Editor, Key: tui.Key, matchesKey: tui.matchesKey, visibleWidth: tui.visibleWidth };
		} catch {
			return null;
		}
	})();
	return askTuiDepsPromise;
}

type AskDialogOutcome =
	| { kind: "selected"; labels: string[]; customInput?: string }
	| { kind: "custom"; text: string }
	| { kind: "chat" };

/**
 * omp-style ask dialog as a pi custom TUI component: bordered card with the
 * question in the top border, ◯/◉ radio or ▢/▣ checkbox markers, dim
 * descriptions under each label, "(Recommended)" suffix, an inline editor for
 * "Other (type your own)", and Esc as the chat-redirect escape.
 */
function runAskDialog(
	customUi: AskCustomUi,
	deps: AskTuiDeps,
	question: AskQuestion,
	progress: string,
): Promise<AskDialogOutcome | undefined> {
	const multi = question.multi === true;
	return customUi.custom<AskDialogOutcome>((tui, theme, _keybindings, done) => {
		const { Editor, Key, matchesKey } = deps;
		const fg = (color: string, text: string): string => {
			try {
				return theme.fg(color, text);
			} catch {
				return text;
			}
		};
		const bold = (text: string): string => {
			try {
				return theme.bold(text);
			} catch {
				return text;
			}
		};
		const vw = (text: string): number => {
			if (deps.visibleWidth) {
				try {
					return deps.visibleWidth(text);
				} catch {
					/* fall through */
				}
			}
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
			return text.replace(/\x1b\[[0-9;:]*m/g, "").length;
		};

		const OTHER_ROW = question.options.length;
		// Navigation order MUST match visual order: options, Other, Done?, Chat.
		const doneRowIndex = (): number | undefined =>
			multi && (checked.size > 0 || customText !== undefined) ? question.options.length + 1 : undefined;
		const chatRowIndex = (): number => question.options.length + (doneRowIndex() !== undefined ? 2 : 1);
		const rowCount = (): number => chatRowIndex() + 1;

		let cursor = typeof question.recommended === "number" && question.recommended >= 0 && question.recommended < question.options.length ? question.recommended : 0;
		let editMode = false;
		let customText: string | undefined;
		const checked = new Set<number>();
		let cachedLines: string[] | undefined;

		const editor = new Editor(tui, {
			borderColor: (text: string) => fg("accent", text),
			selectList: {
				selectedPrefix: (text: string) => fg("accent", text),
				selectedText: (text: string) => fg("accent", text),
				description: (text: string) => fg("muted", text),
				scrollInfo: (text: string) => fg("dim", text),
				noMatch: (text: string) => fg("warning", text),
			},
		});
		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				editMode = false;
				refresh();
				return;
			}
			if (multi) {
				customText = trimmed;
				editMode = false;
				refresh();
			} else {
				done({ kind: "custom", text: trimmed });
			}
		};

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function finishMulti(): void {
			const labels = [...checked].sort((a, b) => a - b).map(index => question.options[index]!.label);
			done({ kind: "selected", labels, customInput: customText });
		}

		function activate(row: number): void {
			if (row === OTHER_ROW) {
				editMode = true;
				refresh();
				return;
			}
			if (row === chatRowIndex()) {
				done({ kind: "chat" });
				return;
			}
			if (doneRowIndex() !== undefined && row === doneRowIndex()) {
				finishMulti();
				return;
			}
			if (row < question.options.length) {
				if (multi) {
					if (checked.has(row)) checked.delete(row);
					else checked.add(row);
					refresh();
				} else {
					done({ kind: "selected", labels: [question.options[row]!.label] });
				}
			}
		}

		function handleInput(data: string): void {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				cursor = (cursor - 1 + rowCount()) % rowCount();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				cursor = (cursor + 1) % rowCount();
				refresh();
				return;
			}
			if (data === " " && multi && cursor < question.options.length) {
				activate(cursor);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				activate(cursor);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ kind: "chat" });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const w = Math.max(40, width);
			const inner = w - 2;
			const border = (text: string) => fg("accent", text);
			const lines: string[] = [];
			const pad = (row: string): string => {
				const content = ` ${row}`;
				const fill = Math.max(0, inner - vw(content));
				return border("│") + content + " ".repeat(fill) + border("│");
			};

			// Header: `╭─ ? question ── 1/2 ─╮` with the question inset.
			const headerText = `${fg("accent", "?")} ${bold(question.header ? `[${question.header}] ${question.question}` : question.question)}`;
			const progressText = progress ? `${fg("dim", progress)} ` : "";
			const headWidth = vw(headerText);
			const progWidth = vw(progressText);
			const fill = Math.max(0, inner - 4 - headWidth - progWidth - (progress ? 2 : 0));
			lines.push(border("╭─") + ` ${headerText} ` + border("─".repeat(fill)) + (progress ? ` ${progressText}` : "") + border("─╮"));
			lines.push(pad(""));

			for (const [index, option] of question.options.entries()) {
				const hovered = !editMode && cursor === index;
				const recommended = question.recommended === index;
				const marker = multi ? (checked.has(index) ? fg("success", "▣") : fg("muted", "▢")) : recommended ? fg("accent", "◉") : fg("muted", "◯");
				const prefix = hovered ? fg("accent", "❯ ") : "  ";
				const suffix = recommended ? fg("dim", " (Recommended)") : "";
				const label = hovered ? fg("accent", option.label) : option.label;
				lines.push(pad(`${prefix}${marker} ${label}${suffix}`));
				if (option.description) lines.push(pad(`     ${fg("muted", option.description)}`));
			}

			const extraRow = (row: number, icon: string, text: string): void => {
				const hovered = !editMode && cursor === row;
				const prefix = hovered ? fg("accent", "❯ ") : "  ";
				lines.push(pad(`${prefix}${icon} ${hovered ? fg("accent", text) : fg("muted", text)}`));
			};
			lines.push(pad(""));
			extraRow(OTHER_ROW, fg("accent", "✎"), customText ? `${OTHER_OPTION}: ${customText}` : OTHER_OPTION);
			const doneRow = doneRowIndex();
			if (doneRow !== undefined) {
				const total = checked.size + (customText !== undefined ? 1 : 0);
				extraRow(doneRow, fg("success", "✓"), `Done (${total} selected)`);
			}
			extraRow(chatRowIndex(), fg("muted", "💬"), CHAT_OPTION);

			if (editMode) {
				lines.push(pad(""));
				lines.push(pad(fg("muted", "Your answer:")));
				for (const editorLine of editor.render(Math.max(1, inner - 4))) {
					lines.push(pad(` ${editorLine}`));
				}
			}

			lines.push(pad(""));
			const hint = editMode
				? "Enter submit · Esc back"
				: multi
					? "↑↓ move · Enter/Space toggle · Esc chat"
					: "↑↓ move · Enter select · Esc chat";
			lines.push(pad(fg("dim", hint)));
			lines.push(border(`╰${"─".repeat(inner)}╯`));
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate(): void {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

/** Map a dialog outcome onto the shared per-question result shape. */
function outcomeToResult(question: AskQuestion, outcome: AskDialogOutcome): AskQuestionResult {
	const base: AskQuestionResult = {
		id: question.id ?? question.question,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: question.multi === true,
		selectedOptions: [],
	};
	if (outcome.kind === "chat") return { ...base, cancelled: true };
	if (outcome.kind === "custom") return { ...base, customInput: outcome.text };
	return { ...base, selectedOptions: outcome.labels, customInput: outcome.customInput };
}

function fitLabel(text: string): string {
	return text.length <= MAX_OPTION_WIDTH ? text : `${text.slice(0, MAX_OPTION_WIDTH - 1)}…`;
}

function displayLabel(option: AskOption, recommended: boolean): string {
	const base = recommended ? `${option.label} (Recommended)` : option.label;
	return fitLabel(option.description ? `${base} — ${option.description}` : base);
}

/** Map a chosen display string back to the underlying option label. */
function resolveChoice(question: AskQuestion, display: string): string {
	const stripped = display.replace(/^\[[ x]\] /, "");
	for (let index = 0; index < question.options.length; index++) {
		const option = question.options[index]!;
		if (stripped === displayLabel(option, question.recommended === index)) return option.label;
	}
	return stripped;
}

async function askSingle(ui: AskUi, question: AskQuestion, title: string): Promise<AskQuestionResult> {
	const id = question.id ?? question.question;
	const base: AskQuestionResult = {
		id,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: false,
		selectedOptions: [],
	};
	const displays = question.options.map((option, index) => displayLabel(option, question.recommended === index));
	const choice = await ui.select(title, [...displays, OTHER_OPTION, CHAT_OPTION]);
	if (choice === undefined || choice === CHAT_OPTION) return { ...base, cancelled: true };
	if (choice === OTHER_OPTION) {
		const custom = await ui.input(title, "Type your answer");
		if (custom === undefined || !custom.trim()) return { ...base, cancelled: true };
		return { ...base, customInput: custom.trim() };
	}
	return { ...base, selectedOptions: [resolveChoice(question, choice)] };
}

async function askMulti(ui: AskUi, question: AskQuestion, title: string): Promise<AskQuestionResult> {
	const id = question.id ?? question.question;
	const base: AskQuestionResult = {
		id,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: true,
		selectedOptions: [],
	};
	const checked = new Set<number>();
	let customInput: string | undefined;
	for (let round = 0; round < 32; round++) {
		const displays = question.options.map((option, index) => {
			const mark = checked.has(index) ? "[x]" : "[ ]";
			return `${mark} ${displayLabel(option, question.recommended === index)}`;
		});
		const extras = [customInput ? `[x] ${OTHER_OPTION}: ${fitLabel(customInput)}` : `[ ] ${OTHER_OPTION}`];
		if (checked.size > 0 || customInput) extras.push(DONE_OPTION);
		extras.push(CHAT_OPTION);
		const choice = await ui.select(`${title} (toggle, then ${DONE_OPTION})`, [...displays, ...extras]);
		if (choice === undefined || choice === CHAT_OPTION) return { ...base, cancelled: true };
		if (choice === DONE_OPTION) break;
		if (choice.includes(OTHER_OPTION)) {
			const custom = await ui.input(title, "Type your answer");
			customInput = custom?.trim() ? custom.trim() : undefined;
			continue;
		}
		const label = resolveChoice(question, choice);
		const index = question.options.findIndex(option => option.label === label);
		if (index === -1) continue;
		if (checked.has(index)) checked.delete(index);
		else checked.add(index);
	}
	return {
		...base,
		selectedOptions: [...checked].sort((a, b) => a - b).map(index => question.options[index]!.label),
		customInput,
	};
}

function answerText(result: AskQuestionResult): string {
	if (result.cancelled) return "not answered (user redirected to chat)";
	const parts = [...result.selectedOptions];
	if (result.customInput) parts.push(`"${result.customInput}"`);
	return parts.length > 0 ? parts.join(", ") : "(nothing selected)";
}

export async function executeAsk(params: AskParams, ctx?: ToolCtx, _signal?: AbortSignal): Promise<ToolResult> {
	const questions = params.questions ?? [];
	if (questions.length === 0) throw new ToolError("`questions` must contain at least one question");
	for (const question of questions) {
		const reserved = question.options.find(option => RESERVED_LABELS.has(option.label));
		if (reserved) throw new ToolError(`Option label collides with a reserved runtime label: ${reserved.label}`);
	}

	// Prefer the omp-style custom dialog whenever the host exposes ui.custom
	// (pi TUI and prime interactive both do; pi additionally reports
	// ctx.mode === "tui" while prime's ctx has no mode field). RPC hosts
	// resolve custom() to undefined, which falls back to select/input below.
	const rawUi = (ctx as { ui?: unknown } | undefined)?.ui as (AskUi & Partial<AskCustomUi>) | undefined;
	const hasUiSurface = (ctx as { hasUI?: boolean } | undefined)?.hasUI !== false;
	const hostMode = (ctx as { mode?: string } | undefined)?.mode;
	const canCustom =
		hasUiSurface && typeof rawUi?.custom === "function" && (hostMode === undefined || hostMode === "tui");
	const tuiDeps = canCustom ? await loadAskTuiDeps() : null;
	const ui = uiOf(ctx);
	if (!ui && !tuiDeps) {
		throw new ToolError(
			"ask requires an interactive session (TUI/RPC); no dialog UI is available here. State your assumption and proceed.",
		);
	}

	const results: AskQuestionResult[] = [];
	let redirected = false;
	for (let index = 0; index < questions.length; index++) {
		const question = questions[index]!;
		const progress = questions.length > 1 ? ` (${index + 1}/${questions.length})` : "";
		const title = `${question.header ? `[${question.header}] ` : ""}${question.question}${progress}`;
		if (redirected) {
			results.push({
				id: question.id ?? question.question,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi === true,
				selectedOptions: [],
				cancelled: true,
			});
			continue;
		}
		let result: AskQuestionResult;
		let outcome: AskDialogOutcome | undefined;
		if (tuiDeps && rawUi) {
			// RPC-style hosts no-op custom() and resolve undefined — fall back.
			outcome = await runAskDialog(rawUi as AskCustomUi, tuiDeps, question, progress.trim().replace(/[()]/g, ""));
		}
		if (outcome !== undefined) {
			result = outcomeToResult(question, outcome);
		} else if (ui) {
			result = question.multi === true ? await askMulti(ui, question, title) : await askSingle(ui, question, title);
		} else {
			throw new ToolError("ask dialog UI became unavailable mid-run");
		}
		results.push(result);
		if (result.cancelled) redirected = true;
	}

	const lines = results.map(result => `**${result.question}** → ${answerText(result)}`);
	if (redirected) {
		lines.push(
			"",
			"The user chose to discuss instead of answering. Continue the conversation in chat; do not re-open this dialog.",
		);
	}
	return textResult(lines.join("\n"), { results, chatRedirect: redirected });
}

export async function registerAsk(pi: PiApi): Promise<void> {
	registeredTools.add("ask");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...askRenderers(support) } : {}),
		name: "ask",
		label: "Ask",
		description: ASK_DESCRIPTION,
		promptSnippet: "Structured follow-up questions for interactive runs",
		promptGuidelines: [
			"Use ask only when options have materially different tradeoffs the user must weigh; otherwise pick the conservative default and state your choice.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "question id (defaults to the question text)" })),
					question: Type.String({ description: "question text" }),
					header: Type.Optional(Type.String({ description: "optional short display chip" })),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "display label" }),
							description: Type.Optional(Type.String({ description: "explanatory tradeoff shown with the label" })),
						}),
						{ description: "available options" },
					),
					multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
					recommended: Type.Optional(Type.Number({ description: "recommended option index (0-based)" })),
				}),
				{ minItems: 1, description: "questions to ask" },
			),
		}),
		async execute(_id: string, call: AskParams, signal?: AbortSignal, _onUpdate?: unknown, callCtx?: ToolCtx) {
			return executeAsk(call, callCtx, signal);
		},
	});
}
