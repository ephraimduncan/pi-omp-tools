import { onDefaultTerminalBackground } from "./lifecycle.ts";

const FG_BORDER = "\x1b[38;2;61;66;74m"; // #3d424a
const FG_ACCENT = "\x1b[38;2;254;188;56m"; // #febc38
const RESET_FG = "\x1b[39m";
const PATCH_KEY = Symbol.for("lazy-prime-statusline.user-message-card.v1");

export interface UserMessageFrameStyle {
	border(text: string): string;
	accent(text: string): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

export type UserMessageWidth = Pick<UserMessageFrameStyle, "visibleWidth" | "truncateToWidth">;

type UserMessageRender = (width: number) => string[];

interface UserMessagePrototype {
	render: UserMessageRender;
	[key: symbol]: unknown;
}

interface PatchState {
	original: UserMessageRender;
	patched: UserMessageRender;
	refs: number;
}

/** Frame Prime's already-rendered user-message body without changing its markdown or background. */
export function frameUserMessage(lines: string[], width: number, style: UserMessageFrameStyle): string[] {
	if (lines.length === 0 || width < 8) return lines;

	const contentWidth = width - 2;
	const label = " α ";
	const topFill = Math.max(0, width - 3 - label.length);
	const top = style.border("╭─") + style.accent(label) + style.border(`${"─".repeat(topFill)}╮`);
	const bottom = style.border(`╰${"─".repeat(width - 2)}╯`);
	const body = lines.map(line => {
		const fitted =
			style.visibleWidth(line) > contentWidth ? style.truncateToWidth(line, contentWidth, "") : line;
		const padding = " ".repeat(Math.max(0, contentWidth - style.visibleWidth(fitted)));
		return style.border("│") + fitted + padding + style.border("│");
	});

	return [top, ...body, bottom];
}

/** Install the submitted-user-message card through the host component exported to extensions. */
export function installUserMessageCard(UserMessageComponent: unknown, widthStyle: UserMessageWidth): () => void {
	const prototype = (UserMessageComponent as { prototype?: UserMessagePrototype } | undefined)?.prototype;
	if (!prototype || typeof prototype.render !== "function") return () => {};

	let state = prototype[PATCH_KEY] as PatchState | undefined;
	if (state) {
		state.refs++;
	} else {
		const original = prototype.render;
		const patched: UserMessageRender = function (this: unknown, width: number): string[] {
			if (width < 8) return original.call(this, width);
			const lines = original.call(this, width - 2);
			return frameUserMessage(lines, width, {
				border: text => `${FG_BORDER}${text}${RESET_FG}`,
				accent: text => `${FG_ACCENT}${text}${RESET_FG}`,
				visibleWidth: widthStyle.visibleWidth,
				truncateToWidth: widthStyle.truncateToWidth,
			}).map(onDefaultTerminalBackground);
		};
		state = { original, patched, refs: 1 };
		prototype[PATCH_KEY] = state;
		prototype.render = patched;
	}

	const installedState = state;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		installedState.refs--;
		if (installedState.refs > 0) return;
		if (prototype.render === installedState.patched) prototype.render = installedState.original;
		delete prototype[PATCH_KEY];
	};
}
