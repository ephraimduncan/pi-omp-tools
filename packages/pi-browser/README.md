# pi-browser

The `browser` tool for [pi](https://pi.dev) and prime-agent controls Obscura or a Chromium browser through CDP. The tool includes page actions and accessibility snapshots.

Use `read` for static web content. Use `browser` for JavaScript and interactive pages.

Install Obscura on `PATH`. If Obscura is in a different directory, set `OBSCURA_PATH`. Set `LAZY_PRIME_BROWSER_ENGINE=chrome` to control the automatic search.

Part of [Lazy Prime](../../README.md). MIT.

| Claim | Evidence |
| --- | --- |
| The tool first finds Obscura and then finds a Chromium browser. | `packages/lazy-prime-core/src/tools/browser-launch.ts:45-83` |
| The tool includes page actions and accessibility snapshots. | `packages/lazy-prime-core/src/tools/browser.ts:17` |
| The tool is for JavaScript and interactive pages. | `packages/lazy-prime-core/src/tools/browser.ts:13` |
