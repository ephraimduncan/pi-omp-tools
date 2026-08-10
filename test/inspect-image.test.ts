import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildAnthropicRequest,
	buildGeminiRequest,
	buildOpenAIRequest,
	executeInspectImage,
	extractAnthropicText,
	extractGeminiText,
	extractOpenAIText,
	INSPECT_IMAGE_SYSTEM_PROMPT,
	MAX_IMAGE_INPUT_BYTES,
	sniffImageMimeType,
	ToolError,
} from "../packages/omp-tools-core/index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from("GIF87a", "ascii");
const GIF89 = Buffer.from("GIF89a", "ascii");
const WEBP = Buffer.from("RIFF\0\0\0\0WEBP", "binary");
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "inspect-image-test-"));
}

test("inspect_image: sniffs supported image types from magic bytes", () => {
	assert.equal(sniffImageMimeType(PNG), "image/png");
	assert.equal(sniffImageMimeType(JPEG), "image/jpeg");
	assert.equal(sniffImageMimeType(GIF87), "image/gif");
	assert.equal(sniffImageMimeType(GIF89), "image/gif");
	assert.equal(sniffImageMimeType(WEBP), "image/webp");
	assert.equal(sniffImageMimeType(Buffer.from("plain text")), null);
});

test("inspect_image: rejects files whose content is not a supported image", async () => {
	const dir = await tempDir();
	await fs.writeFile(path.join(dir, "not-image.png"), "plain text");
	await assert.rejects(
		executeInspectImage({ path: "not-image.png", question: "What is shown?" }, { cwd: dir }),
		(error: unknown) =>
			error instanceof ToolError &&
			error.message === "inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.",
	);
});

test("inspect_image: rejects files over the input cap with downscale guidance", async () => {
	const dir = await tempDir();
	const file = await fs.open(path.join(dir, "large.png"), "w");
	try {
		await file.truncate(MAX_IMAGE_INPUT_BYTES + 1);
	} finally {
		await file.close();
	}
	await assert.rejects(
		executeInspectImage({ path: "large.png", question: "What is shown?" }, { cwd: dir }),
		(error: unknown) =>
			error instanceof ToolError && /Image file too large:.*20\.0MB limit.*Downscale the image/.test(error.message),
	);
});

test("inspect_image: builds an Anthropic image request", () => {
	assert.deepEqual(buildAnthropicRequest("claude-test", "ant-key", "YWJj", "image/png", "Read it"), {
		url: "https://api.anthropic.com/v1/messages",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "ant-key",
		},
		body: {
			model: "claude-test",
			max_tokens: 1024,
			system: INSPECT_IMAGE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
						{ type: "text", text: "Read it" },
					],
				},
			],
		},
	});
});

test("inspect_image: builds an OpenAI-compatible image request", () => {
	assert.deepEqual(
		buildOpenAIRequest("vision-test", "open-key", "YWJj", "image/jpeg", "Describe", "https://router.test/v1/"),
		{
			url: "https://router.test/v1/chat/completions",
			headers: { "Content-Type": "application/json", Authorization: "Bearer open-key" },
			body: {
				model: "vision-test",
				max_tokens: 1024,
				messages: [
					{ role: "system", content: INSPECT_IMAGE_SYSTEM_PROMPT },
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } },
							{ type: "text", text: "Describe" },
						],
					},
				],
			},
		},
	);
});

test("inspect_image: builds a Gemini image request", () => {
	assert.deepEqual(buildGeminiRequest("gemini/test", "gem-key", "YWJj", "image/webp", "List objects"), {
		url: "https://generativelanguage.googleapis.com/v1beta/models/gemini%2Ftest:generateContent",
		headers: { "Content-Type": "application/json", "x-goog-api-key": "gem-key" },
		body: {
			systemInstruction: { parts: [{ text: INSPECT_IMAGE_SYSTEM_PROMPT }] },
			contents: [
				{
					role: "user",
					parts: [{ inlineData: { mimeType: "image/webp", data: "YWJj" } }, { text: "List objects" }],
				},
			],
			generationConfig: { maxOutputTokens: 1024 },
		},
	});
});

test("inspect_image: extracts text from provider responses", () => {
	assert.equal(
		extractAnthropicText({ content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }] }),
		"answer",
	);
	assert.equal(extractOpenAIText({ choices: [{ message: { content: " openai answer " } }] }), "openai answer");
	assert.equal(
		extractGeminiText({ candidates: [{ content: { parts: [{ text: "first" }, { thought: true }, { text: "second" }] } }] }),
		"first\nsecond",
	);
});

test("inspect_image: returns image and question when no API key is configured", async () => {
	const keys = [
		"OMP_TOOLS_VISION_MODEL",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
	] as const;
	const saved: Record<string, string | undefined> = {};
	for (const key of keys) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		const dir = await tempDir();
		await fs.writeFile(path.join(dir, "pixel.png"), PIXEL_PNG);
		const result = await executeInspectImage({ path: "pixel.png", question: "Describe the pixel" }, { cwd: dir });
		assert.equal(result.content.length, 3);
		assert.deepEqual(result.content[0], {
			type: "text",
			text: "no vision API key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY); attaching image for direct analysis",
		});
		assert.deepEqual(result.content[1], { type: "image", data: PIXEL_PNG.toString("base64"), mimeType: "image/png" });
		assert.deepEqual(result.content[2], { type: "text", text: "Describe the pixel" });
	} finally {
		for (const key of keys) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("inspect_image: optional live vision call", async t => {
	if (!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
		t.skip("no vision API key configured");
		return;
	}
	const dir = await tempDir();
	await fs.writeFile(path.join(dir, "pixel.png"), PIXEL_PNG);
	const result = await executeInspectImage({ path: "pixel.png", question: "What color is this pixel? Answer briefly." }, { cwd: dir });
	assert.equal(result.content[0]?.type, "text");
	if (result.content[0]?.type === "text") assert.ok(result.content[0].text.length > 0);
});
