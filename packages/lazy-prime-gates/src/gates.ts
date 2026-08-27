import { guidePath, guideText, guideTitle, type GuideName } from "./guides.ts";
import { notify, parseToolEvent, type GateContent, type GateContext, type GateHookResult, type GateHost } from "./host.ts";
import { parseMutations } from "./mutations.ts";
import { matchHardBlock, matchReviews, type ReviewMatch } from "./policies.ts";
import { injectGitEditors } from "./shell.ts";

interface PendingReview {
	readonly match: ReviewMatch;
	readonly blockedTurn: number;
}

interface GateState {
	readonly reviewed: Set<string>;
	readonly pending: Map<string, PendingReview>;
	readonly inFlight: Map<string, ReviewMatch[]>;
	readonly shown: Set<GuideName>;
	turn: number;
}

/** Register the full Lazy Prime policy gate extension on a structural pi host. */
export function registerLazyPrimeGates(host: GateHost): void {
	const state: GateState = {
		reviewed: new Set(),
		pending: new Map(),
		inFlight: new Map(),
		shown: new Set(),
		turn: 0,
	};

	const reset = (): void => {
		state.reviewed.clear();
		state.pending.clear();
		state.inFlight.clear();
		state.shown.clear();
		state.turn = 0;
	};
	const abandonPending = (): void => {
		state.pending.clear();
		state.inFlight.clear();
	};

	host.on("session_start", reset);
	host.on("session_before_switch", reset);
	host.on("session_switch", reset);
	host.on("session_branch", reset);
	host.on("session_compact", reset);
	host.on("session_tree", reset);
	host.on("agent_start", abandonPending);
	host.on("turn_start", () => {
		state.turn += 1;
	});
	host.on("tool_call", (value, context) => onToolCall(value, context, state));
	host.on("tool_result", (value, context) => onToolResult(value, context, state));
}

function onToolCall(value: unknown, context: GateContext, state: GateState): GateHookResult | undefined {
	const event = parseToolEvent(value);
	if (!event) return undefined;

	const hardBlock = matchHardBlock(event.toolName, event.input);
	if (hardBlock) {
		notify(context, `lazy-prime-gates: ${hardBlock.title}`);
		return { block: true, reason: hardBlock.reason };
	}

	injectGitEditors(event.toolName, event.input);
	const matches = matchReviews(event.toolName, event.input);
	discardRemovedPathReviews(event.toolName, event.input, matches, state);
	if (matches.length === 0) return undefined;

	const open = matches.filter(match => !state.reviewed.has(match.key));
	const fresh = open.filter(match => !state.pending.has(match.key));
	for (const match of fresh) state.pending.set(match.key, { match, blockedTurn: state.turn });
	const tooEarly = open.filter(match => {
		const pending = state.pending.get(match.key);
		return pending !== undefined && pending.blockedTurn >= state.turn;
	});
	if (fresh.length > 0 || tooEarly.length > 0) {
		let reason: string;
		try {
			reason = reviewReason(open, state.shown);
		} catch (error) {
			for (const match of fresh) state.pending.delete(match.key);
			const detail = error instanceof Error ? error.message : String(error);
			return {
				block: true,
				reason: `BLOCKED: a bundled Lazy Prime gate guide could not be loaded. Reinstall the package or ask the user for help. ${detail}`,
			};
		}
		notify(context, `lazy-prime-gates: review paused for ${open.map(match => match.label).join(", ")}`);
		return { block: true, reason };
	}

	const consumed = matches.filter(match => state.pending.has(match.key));
	if (consumed.length > 0 && !event.toolCallId) {
		return { block: true, reason: "BLOCKED: the extension host did not supply a tool-call identifier, so Lazy Prime cannot commit this review safely." };
	}
	if (consumed.length > 0 && event.toolCallId) state.inFlight.set(event.toolCallId, consumed);
	return undefined;
}

function onToolResult(value: unknown, context: GateContext, state: GateState): GateHookResult | undefined {
	const event = parseToolEvent(value);
	if (!event?.toolCallId) return undefined;
	const inFlight = state.inFlight.get(event.toolCallId);
	if (!inFlight) return undefined;
	state.inFlight.delete(event.toolCallId);
	if (event.isError) return undefined;

	const resultKeys = new Set(matchReviews(event.toolName, event.input).map(match => match.key));
	const committed = inFlight.filter(match => resultKeys.has(match.key) && state.pending.has(match.key));
	if (committed.length === 0) return undefined;

	for (const match of committed) {
		state.pending.delete(match.key);
		if (!match.recurring) state.reviewed.add(match.key);
	}
	const note = `[lazy-prime-gates] allowed after combined review: ${committed.map(match => match.label).join("; ")}`;
	notify(context, note, "info");
	return { content: appendNote(event.content, note) };
}

function discardRemovedPathReviews(
	toolName: string,
	input: Record<string, unknown>,
	matches: ReviewMatch[],
	state: GateState,
): void {
	const touched = new Set(parseMutations(toolName, input).map(change => change.path));
	if (touched.size === 0) return;
	const active = new Set(matches.map(match => match.key));
	for (const [key, pending] of state.pending) {
		if (touched.has(pending.match.target) && !active.has(key)) state.pending.delete(key);
	}
}

function reviewReason(matches: ReviewMatch[], shown: Set<GuideName>): string {
	const guides = [...new Set(matches.flatMap(match => match.guides))];
	const unseen = guides.filter(name => !shown.has(name));
	const seen = guides.filter(name => shown.has(name));
	const sections = unseen.map(name => `===== GUIDE: ${guideTitle(name)} =====\n\n${guideText(name)}`);
	for (const name of unseen) shown.add(name);

	return [
		"Instructional review paused this tool call.",
		"",
		...matches.flatMap((match, index) => [`${index + 1}. ${match.label}`, `   ${match.instruction}`]),
		"",
		"Read every applicable guide below. Recompose the change before you reissue the tool call.",
		...(matches.some(match => match.policy === "pr-writing")
			? ["Before you reissue PR prose, read skill://humanizer and remove every AI-writing pattern that it lists."]
			: []),
		"A successful matching tool result commits all listed reviews and adds one combined gate note.",
		...(seen.length > 0 ? ["", `Already shown in this context: ${seen.map(guideTitle).join(", ")}.`] : []),
		...(guides.includes("ste100-writing")
			? ["", `Use the bundled STE files at ${guidePath("ste100-writing")} and ${guidePath("ste100-wordlist")}.`]
			: []),
		...(sections.length > 0 ? ["", ...sections] : []),
	].join("\n");
}

function appendNote(content: GateContent[], note: string): GateContent[] {
	const next = [...content];
	const index = next.length - 1;
	const last = next[index];
	if (last?.type === "text") {
		next[index] = { ...last, text: `${last.text}\n\n${note}` };
	} else {
		next.push({ type: "text", text: note });
	}
	return next;
}
