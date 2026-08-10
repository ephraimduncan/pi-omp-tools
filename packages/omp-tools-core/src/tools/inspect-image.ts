import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { ToolError, type ToolCtx, type ToolResult } from "../host.ts";
import type { PiApi } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { inspectImageRenderers, loadRenderSupport } from "../render.ts";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff]);

export const INSPECT_IMAGE_SYSTEM_PROMPT = `You are an image-analysis assistant.

Core behavior:
- Be evidence-first: distinguish direct observations from inferences.
- If something is unclear, say uncertain rather than guessing.
- NEVER fabricate unreadable or occluded details.
- Keep output compact and useful.

Default output format (unless the requested question asks for another format):
1) Answer
2) Key evidence
3) Caveats / uncertainty

For OCR-style requests:
- Preserve exact visible text, including casing and punctuation.
- If text is partially unreadable, mark the unreadable segments explicitly.

For UI/screenshot debugging requests:
- Focus on visible states, labels, toggles, error messages, disabled controls, and relevant affordances.
- Separate observed UI state from probable root cause.`;

export const INSPECT_IMAGE_DESCRIPTION = `Inspects an image file with a vision-capable model and returns compact text analysis.

<instruction>
- Use this for image understanding tasks (OCR, UI/screenshot debugging, scene/object questions)
- Provide \`path\` as a local image file path
- Write a specific \`question\`:
  - what to inspect
  - constraints (for example: "quote visible text verbatim", "only report confirmed findings")
  - desired output format (bullets/table/JSON/short answer)
- Keep \`question\` grounded in observable evidence and ask for uncertainty when details are unclear
- Use this tool over \`read\` when the goal is image analysis
</instruction>

<output>
- Returns text-only analysis from the vision model
- When no vision API key is configured, returns the image and question for direct host-model analysis
</output>

<examples>
# OCR with strict formatting
<example>
inspect_image({ path: "screenshots/error.png", question: "Extract all visible text verbatim. Return as bullet list in reading order." })
</example>
# Screenshot debugging
<example>
inspect_image({ path: "screenshots/settings.png", question: "Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence." })
</example>
# Scene/object question
<example>
inspect_image({ path: "photos/shelf.jpg", question: "List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable." })
</example>
</examples>`;

export interface InspectImageParams {
	path: string;
	question: string;
}

export interface VisionRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type VisionProvider = "anthropic" | "openai" | "google";

interface VisionModel {
	provider: VisionProvider;
	id: string;
	key: string;
}

export async function executeInspectImage(
	params: InspectImageParams,
	ctx?: ToolCtx,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (!params.path?.trim()) throw new ToolError("image path is required");
	if (!params.question?.trim()) throw new ToolError("question about image is required");

	const imagePath = path.resolve(ctx?.cwd ?? process.cwd(), params.path);
	let stat;
	try {
		stat = await fs.stat(imagePath);
	} catch {
		throw new ToolError(`Unable to read image file: ${imagePath}`);
	}
	if (!stat.isFile()) throw new ToolError(`Unable to read image file: ${imagePath}`);
	if (stat.size > MAX_IMAGE_INPUT_BYTES) throw imageTooLarge(stat.size);

	let bytes: Buffer;
	try {
		bytes = await fs.readFile(imagePath);
	} catch {
		throw new ToolError(`Unable to read image file: ${imagePath}`);
	}
	if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) throw imageTooLarge(bytes.byteLength);

	const mimeType = sniffImageMimeType(bytes);
	if (!mimeType) {
		throw new ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.");
	}
	const data = bytes.toString("base64");
	const selected = selectVisionModel(process.env);
	if (!selected) {
		return {
			content: [
				{
					type: "text",
					text: "no vision API key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY); attaching image for direct analysis",
				},
				{ type: "image", data, mimeType },
				{ type: "text", text: params.question },
			],
			details: { imagePath, mimeType },
		};
	}

	const request = buildRequest(selected, data, mimeType, params.question);
	const timeoutMs = readTimeout(process.env.OMP_TOOLS_VISION_TIMEOUT_MS);
	const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	const requestSignal = timeoutSignal
		? signal
			? AbortSignal.any([signal, timeoutSignal])
			: timeoutSignal
		: signal;

	let payload: unknown;
	try {
		payload = await fetchVision(request, requestSignal);
	} catch (error) {
		if (timeoutSignal?.aborted && !signal?.aborted) {
			const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
			throw new ToolError(
				`inspect_image request timed out after ${seconds}s. Increase OMP_TOOLS_VISION_TIMEOUT_MS (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`,
			);
		}
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			throw new ToolError("inspect_image request aborted.");
		}
		throw error;
	}

	const text = extractResponseText(selected.provider, payload);
	if (!text) throw new ToolError("model returned no text output");
	return {
		content: [{ type: "text", text }],
		details: { model: `${selected.provider}/${selected.id}`, imagePath, mimeType },
	};
}

export async function registerInspectImage(pi: PiApi): Promise<void> {
	registeredTools.add("inspect_image");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...inspectImageRenderers(support) } : {}),
		name: "inspect_image",
		label: "InspectImage",
		description: INSPECT_IMAGE_DESCRIPTION,
		promptSnippet: INSPECT_IMAGE_DESCRIPTION,
		promptGuidelines: ["Prefer inspect_image over read for image analysis to spare context."],
		parameters: Type.Object({
			path: Type.String({ description: "image file path" }),
			question: Type.String({ description: "question about image" }),
		}),
		async execute(_id: string, params: InspectImageParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolCtx) {
			return executeInspectImage(params, ctx, signal);
		},
	});
}

export function sniffImageMimeType(bytes: Uint8Array): ImageMimeType | null {
	if (hasBytes(bytes, 0, PNG_MAGIC)) return "image/png";
	if (hasBytes(bytes, 0, JPEG_MAGIC)) return "image/jpeg";
	if (hasText(bytes, 0, "GIF87a") || hasText(bytes, 0, "GIF89a")) return "image/gif";
	if (hasText(bytes, 0, "RIFF") && hasText(bytes, 8, "WEBP")) return "image/webp";
	return null;
}

export function buildAnthropicRequest(
	model: string,
	key: string,
	data: string,
	mimeType: ImageMimeType,
	question: string,
): VisionRequest {
	return {
		url: "https://api.anthropic.com/v1/messages",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": key,
		},
		body: {
			model,
			max_tokens: 1024,
			system: INSPECT_IMAGE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: mimeType, data } },
						{ type: "text", text: question },
					],
				},
			],
		},
	};
}

export function buildOpenAIRequest(
	model: string,
	key: string,
	data: string,
	mimeType: ImageMimeType,
	question: string,
	baseUrl = "https://api.openai.com/v1",
): VisionRequest {
	return {
		url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: {
			model,
			max_tokens: 1024,
			messages: [
				{ role: "system", content: INSPECT_IMAGE_SYSTEM_PROMPT },
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
						{ type: "text", text: question },
					],
				},
			],
		},
	};
}

export function buildGeminiRequest(
	model: string,
	key: string,
	data: string,
	mimeType: ImageMimeType,
	question: string,
): VisionRequest {
	return {
		url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		headers: { "Content-Type": "application/json", "x-goog-api-key": key },
		body: {
			systemInstruction: { parts: [{ text: INSPECT_IMAGE_SYSTEM_PROMPT }] },
			contents: [
				{
					role: "user",
					parts: [{ inlineData: { mimeType, data } }, { text: question }],
				},
			],
			generationConfig: { maxOutputTokens: 1024 },
		},
	};
}

export function extractAnthropicText(payload: unknown): string {
	if (typeof payload !== "object" || payload === null || !("content" in payload) || !Array.isArray(payload.content)) {
		return "";
	}
	return payload.content
		.map(part => {
			if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function extractOpenAIText(payload: unknown): string {
	if (typeof payload !== "object" || payload === null || !("choices" in payload) || !Array.isArray(payload.choices)) {
		return "";
	}
	const first = payload.choices[0];
	if (typeof first !== "object" || first === null || !("message" in first)) return "";
	const message = first.message;
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	return typeof message.content === "string" ? message.content.trim() : "";
}

export function extractGeminiText(payload: unknown): string {
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("candidates" in payload) ||
		!Array.isArray(payload.candidates)
	) {
		return "";
	}
	const first = payload.candidates[0];
	if (typeof first !== "object" || first === null || !("content" in first)) return "";
	const content = first.content;
	if (typeof content !== "object" || content === null || !("parts" in content) || !Array.isArray(content.parts)) {
		return "";
	}
	return content.parts
		.map((part: unknown) => {
			if (typeof part !== "object" || part === null || !("text" in part)) return "";
			return typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export async function fetchVision(request: VisionRequest, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal,
	});
	if (!response.ok) {
		const message = (await response.text()).trim();
		throw new ToolError(`inspect_image request failed (HTTP ${response.status})${message ? `: ${message}` : "."}`);
	}
	return response.json();
}

function selectVisionModel(env: NodeJS.ProcessEnv): VisionModel | null {
	const forced = env.OMP_TOOLS_VISION_MODEL?.trim();
	if (forced) {
		const slash = forced.indexOf("/");
		const provider = forced.slice(0, slash);
		const id = forced.slice(slash + 1);
		if (slash < 1 || !id || (provider !== "anthropic" && provider !== "openai" && provider !== "google")) {
			throw new ToolError(
				'OMP_TOOLS_VISION_MODEL must be "anthropic/<id>", "openai/<id>", or "google/<id>".',
			);
		}
		const key = providerKey(provider, env);
		if (key) return { provider, id, key };
		if (!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY)) return null;
		throw new ToolError(`No API key configured for forced vision provider ${provider}.`);
	}
	if (env.ANTHROPIC_API_KEY) {
		return { provider: "anthropic", id: "claude-sonnet-4-5", key: env.ANTHROPIC_API_KEY };
	}
	if (env.OPENAI_API_KEY) return { provider: "openai", id: "gpt-4o-mini", key: env.OPENAI_API_KEY };
	const googleKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
	if (googleKey) return { provider: "google", id: "gemini-2.5-flash", key: googleKey };
	return null;
}

function buildRequest(model: VisionModel, data: string, mimeType: ImageMimeType, question: string): VisionRequest {
	if (model.provider === "anthropic") return buildAnthropicRequest(model.id, model.key, data, mimeType, question);
	if (model.provider === "openai") {
		return buildOpenAIRequest(model.id, model.key, data, mimeType, question, process.env.OPENAI_BASE_URL);
	}
	return buildGeminiRequest(model.id, model.key, data, mimeType, question);
}

function extractResponseText(provider: VisionProvider, payload: unknown): string {
	if (provider === "anthropic") return extractAnthropicText(payload);
	if (provider === "openai") return extractOpenAIText(payload);
	return extractGeminiText(payload);
}

function providerKey(provider: VisionProvider, env: NodeJS.ProcessEnv): string | undefined {
	if (provider === "anthropic") return env.ANTHROPIC_API_KEY;
	if (provider === "openai") return env.OPENAI_API_KEY;
	return env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
}

function readTimeout(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout < 0) {
		throw new ToolError("OMP_TOOLS_VISION_TIMEOUT_MS must be a non-negative number of milliseconds.");
	}
	return timeout;
}

function imageTooLarge(bytes: number): ToolError {
	const size = formatBytes(bytes);
	const limit = formatBytes(MAX_IMAGE_INPUT_BYTES);
	return new ToolError(`Image file too large: ${size} exceeds ${limit} limit. Downscale the image and retry.`);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function hasBytes(bytes: Uint8Array, offset: number, magic: ArrayLike<number>): boolean {
	if (bytes.length < offset + magic.length) return false;
	for (let index = 0; index < magic.length; index += 1) {
		if (bytes[offset + index] !== magic[index]) return false;
	}
	return true;
}

function hasText(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index += 1) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

