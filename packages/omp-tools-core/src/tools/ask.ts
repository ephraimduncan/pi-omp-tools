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

	const ui = uiOf(ctx);
	if (!ui) {
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
		const result = question.multi === true ? await askMulti(ui, question, title) : await askSingle(ui, question, title);
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
