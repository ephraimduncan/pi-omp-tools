/**
 * Minimal structural types for the pi extension surface. We intentionally do
 * NOT import types from the host package (`@earendil-works/pi-coding-agent`,
 * `@mariozechner/pi-coding-agent`, `@oh-my-pi/pi-coding-agent`, ...) so this
 * extension loads unmodified in pi, prime-agent, and other pi forks. The
 * structural shapes below match the shared `pi.registerTool()` contract.
 */

export interface TextPart {
	type: "text";
	text: string;
}

export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolResult {
	content: ContentPart[];
	details?: Record<string, unknown>;
}

/** Subset of the host ExtensionContext we rely on. */
export interface ToolCtx {
	cwd?: string;
	/** True in TUI/RPC modes; false in print/JSON (pi/prime extension ctx). */
	hasUI?: boolean;
	/** Host run mode ("tui" | "rpc" | "json" | "print") when exposed. */
	mode?: string;
	/** Host dialog surface (select/input/confirm/…), when the host passes its full ctx. */
	ui?: unknown;
}

export type ToolUpdate = (partial: ToolResult) => void;

export interface ToolDef<P = Record<string, unknown>> {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	execute(
		toolCallId: string,
		params: P,
		signal?: AbortSignal,
		onUpdate?: ToolUpdate,
		ctx?: ToolCtx,
	): Promise<ToolResult>;
}

export interface PiApi {
	// biome-ignore lint/suspicious/noExplicitAny: host tool defs are structurally wider
	registerTool(def: any): void;
	on?(event: string, handler: (...args: unknown[]) => unknown): void;
}

/** Error thrown by tools; hosts mark thrown errors as failed tool results. */
export class ToolError extends Error {}

/**
 * Host session id, when the host passes its full extension context as the
 * tool ctx (pi and prime do). Session-scoped tools key their state on it.
 */
export function sessionId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) return undefined;
	const manager = ctx.sessionManager;
	if (!manager || typeof manager !== "object" || !("getSessionId" in manager)) return undefined;
	if (typeof manager.getSessionId !== "function") return undefined;
	const id: unknown = manager.getSessionId.call(manager);
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: details ?? {} };
}
