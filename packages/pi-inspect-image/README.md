# pi-inspect-image

The `inspect_image` tool reads PNG, JPEG, GIF, and WebP files. It sends an image to an Anthropic, OpenAI-compatible, or Gemini API.

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`. Set `LAZY_PRIME_VISION_MODEL=provider/model` to select a model. If you do not set a key, the tool sends the image and the question to the host model.

This package is part of [Lazy Prime](../../README.md). MIT.

| Claim | Evidence |
| --- | --- |
| The tool identifies an image type from the file bytes. | `packages/lazy-prime-core/src/tools/inspect-image.ts:185-190` |
| The tool selects provider keys and model defaults. | `packages/lazy-prime-core/src/tools/inspect-image.ts:339-361` |
| The request body contains the image and the question. | `packages/lazy-prime-core/src/tools/inspect-image.ts:193-272` |
| The tool sends the image to the host model when no API key exists. | `packages/lazy-prime-core/src/tools/inspect-image.ts:118-131` |
