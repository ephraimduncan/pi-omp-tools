/** Event names used by the Lazy Prime gate extension. */
export type GateEventName =
	| "session_start"
	| "session_before_switch"
	| "session_switch"
	| "session_branch"
	| "session_compact"
	| "session_tree"
	| "agent_start"
	| "turn_start"
	| "tool_call"
	| "tool_result";

/** A notification surface shared by pi and Prime Agent. */
export interface GateUi {
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** The minimum event context needed by the gate extension. */
export interface GateContext {
	readonly hasUI?: boolean;
	readonly ui?: GateUi;
}

/** A text result block shared by pi and Prime Agent. */
export interface GateTextContent {
	readonly type: "text";
	readonly text: string;
}

/** An image result block shared by pi and Prime Agent. */
export interface GateImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** Tool-result content that the gate can preserve or append. */
export type GateContent = GateTextContent | GateImageContent;

/** A hook result accepted by the shared pi extension event contract. */
export interface GateHookResult {
	block?: boolean;
	reason?: string;
	content?: GateContent[];
}

/** A host event handler with no dependency on a specific host package. */
export type GateHandler = (
	event: unknown,
	context: GateContext,
) => GateHookResult | Promise<GateHookResult | void> | void;

/** The minimum extension API implemented by pi and Prime Agent. */
export interface GateHost {
	on(event: GateEventName, handler: GateHandler): void;
}

/** A parsed tool event at the shared extension boundary. */
export interface ToolEvent {
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly input: Record<string, unknown>;
	readonly content: GateContent[];
	readonly isError: boolean;
}

/** Return true when a boundary value is a string-keyed object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the common fields from a tool call or result event. */
export function parseToolEvent(value: unknown): ToolEvent | undefined {
	if (!isRecord(value) || typeof value.toolName !== "string" || !isRecord(value.input)) return undefined;
	return {
		toolName: value.toolName,
		toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		input: value.input,
		content: parseContent(value.content),
		isError: value.isError === true,
	};
}

function parseContent(value: unknown): GateContent[] {
	if (!Array.isArray(value)) return [];
	const content: GateContent[] = [];
	for (const part of value) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return content;
}

/** Send a gate notification only when the host exposes an active UI. */
export function notify(context: GateContext, message: string, level: "info" | "warning" = "warning"): void {
	if (context.hasUI && context.ui) context.ui.notify(message, level);
}
