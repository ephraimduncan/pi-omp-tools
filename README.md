# Lazy Prime

Lazy Prime is a set of focused file, search, workflow, and interface extensions for [pi](https://pi.dev) and [prime-agent](https://github.com/earendil-works).

| Package | Tool | Description |
|---------|------|-------------|
| [pi-read](packages/pi-read) | `read` | Read files, directories, archives, SQLite databases, PDFs, notebooks, images, and URLs through one path. |
| [pi-write](packages/pi-write) | `write` | Create or overwrite files, archive entries, and SQLite rows. |
| [pi-hashline-edit](packages/pi-hashline-edit) | `edit` | Apply line-anchored hashline patches with stale-anchor recovery. |
| [pi-search](packages/pi-search) | `search` | Search files and globs with regex. Results also provide edit anchors. |
| [pi-find](packages/pi-find) | `find` | Find paths by glob, newest first, with gitignore support. |
| [pi-ast-grep](packages/pi-ast-grep) | `ast_grep` | Search code structurally with tree-sitter patterns. |
| [pi-ast-edit](packages/pi-ast-edit) | `ast_edit` | Preview and apply structural code rewrites. |
| [pi-bash](packages/pi-bash) | `bash` | Run shell commands with optional PTY and background jobs. |
| [pi-todo](packages/pi-todo) | `todo` | Track phased session tasks by their full text. |
| [pi-task](packages/pi-task) | `task` | Run independent subagent tasks in parallel. |
| [pi-ask](packages/pi-ask) | `ask` | Ask structured follow-up questions in interactive sessions. |
| [pi-web-search](packages/pi-web-search) | `web_search` | Search the web through Exa or Parallel and return citations. |
| [pi-github](packages/pi-github) | `github` | Use the logged-in `gh` CLI for repository, issue, pull request, search, and Actions operations. |
| [pi-browser](packages/pi-browser) | `browser` | Drive persistent browser tabs through CDP. |
| [pi-inspect-image](packages/pi-inspect-image) | `inspect_image` | Analyze local images with a vision model. |
| [pi-tmp-scratch](packages/pi-tmp-scratch) | — | Keep temporary session work under the operating system temp directory. |
| [lazy-prime-statusline](packages/lazy-prime-statusline) | `/lazy-prime` | Add the Lazy Prime boxed editor and embedded status line. |
| [lazy-prime-gates](packages/lazy-prime-gates) | — | Enforce Git safety and pause code, test, React effect, and public prose changes for review. |

All tool wrappers share [lazy-prime-core](packages/lazy-prime-core) and one process-global snapshot store. Tags minted by `read` or `search` therefore validate in `edit` even when tools are installed as separate packages.

## Install

Install the full package from GitHub:

```bash
# pi
pi install git:github.com/ephraimduncan/lazy-prime

# prime-agent
prime-agent package install git:github.com/ephraimduncan/lazy-prime
```

Or use a local clone. `npm link` installs the `lazy-prime` launcher on `PATH`. The Prime package command loads the extensions and theme.

```bash
git clone https://github.com/ephraimduncan/lazy-prime
cd lazy-prime
npm install
npm link
prime-agent package install /path/to/lazy-prime
```

The Git package commands load resources only. They do not install executable files. Clone the repository and run `npm link` when you also want the `lazy-prime` command.

To load one wrapper from a local clone, point the host settings at that package:

```json
{ "packages": ["/path/to/lazy-prime/packages/pi-search"] }
```

Each `pi-*` wrapper under `packages/` remains separately publishable with its existing package name.

Try the full checkout without installing it:

```bash
prime-agent -e /path/to/lazy-prime
pi -e /path/to/lazy-prime
```

## System-prompt integration

Each tool wrapper adds three forms of host integration:

1. **`promptGuidelines`** add focused usage guidance for that tool.
2. **`before_agent_start`** adds the shared `## Lazy Prime` workflow block and the `read → edit` anchor loop.
3. **Built-in retirement** deactivates overlapping built-ins such as `grep`, `glob`, `rg`, and `ls` when their Lazy Prime replacements are installed. Set `LAZY_PRIME_KEEP_BUILTINS=1` to opt out.

## Policy gates

The root package loads `lazy-prime-gates` automatically. The extension permanently blocks AI commit attribution, `--no-verify`, and fill-derived pull request bodies. It combines overlapping code reviews into one pause, so a test that contains `useEffect` receives one review instead of three.

All gate guides ship with the package. The gates do not read files from user home directories. They cover the `bash` tool and Prime IPython shell cells.

## Temporary scratch space

[pi-tmp-scratch](packages/pi-tmp-scratch) creates a per-session directory under `/tmp/lazy-prime-scratch`, exports it as `$PI_SCRATCH_DIR`, and guides temporary probes, clones, downloads, and generated fixtures there. `/scratch` shows the current directory. `/scratch clean` empties it.

## Rich UI in prime-agent

The `lazy-prime` launcher runs prime-agent in-process through its public `main(args, { extensionFactories })` API. This keeps extension renderers available for colored diffs, gutters, search highlighting, the boxed editor, and usage rows.

The root package exposes the launcher as the `lazy-prime` binary. From a checkout, it can also be run directly:

```bash
node /path/to/lazy-prime/bin/lazy-prime.mjs
node /path/to/lazy-prime/bin/lazy-prime.mjs -p "..."
```

The in-process session remains saved and resumable, but it is tied to the terminal process and cannot use multi-client attach or the agents view. Heartbeats are persisted in the session artifact directory and run while that terminal is open. Plain `prime-agent` remains unchanged and continues to work alongside Lazy Prime.

## The hashline edit loop

```
read src/foo.ts          →  [src/foo.ts#1A2B]
                            1:import { x } from "./x";
                            2:export function main() {
                            ...

edit                     →  [src/foo.ts#1A2B]
                            PUT 2*:
                            +export function main(): void {
                            +  run();
                            +}

response                 →  [src/foo.ts#9F3E] updated
                            2:export function main(): void {
                            ...fresh numbers for the next edit
```

- `PUT A.=B:` replaces lines. `PUT <A:` and `PUT >A:` insert lines. `PUT A*:` replaces a block. `CUT A.=B [@r]` captures a range. `PUT >N @r` pastes it. `REM` and `MV` remove or move a file.
- Tags are four-character content hashes. Stale tags can recover when their anchor lines still match. Ambiguous edits fail with a re-read instruction.
- Markdown sections, tree-sitter syntax blocks, and bracket or indentation fallbacks provide block resolution.

## Requirements

- Node 20 or newer, or Bun, in the host agent.
- Recommended commands on `PATH`: `rg`, `unzip`, `zip`, `tar`, and `pdftotext`.
- The `github` tool requires the `gh` CLI and its existing login.
- `web_search` uses `EXA_API_KEY` or `PARALLEL_API_KEY`. Set `LAZY_PRIME_SEARCH_PROVIDER=exa|parallel` to choose a provider.
- `inspect_image` uses `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`. Set `LAZY_PRIME_VISION_MODEL=provider/model` to choose a model.
- The `browser` tool discovers Obscura and Chromium-family browsers. Set `LAZY_PRIME_BROWSER_ENGINE=obscura|chrome`, `OBSCURA_PATH`, `CHROME_PATH`, or `LAZY_PRIME_BROWSER` to control discovery.
- SQLite support uses `node:sqlite`, `bun:sqlite`, or the `sqlite3` CLI, whichever is available.
- Optional tree-sitter grammars add Python, Rust, Go, Java, C, C++, JSON, and YAML support.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT

## Evidence

| Claim | Evidence |
| --- | --- |
| Browser discovery checks Obscura before Chromium-family browsers. | `packages/lazy-prime-core/src/tools/browser-launch.ts` |
| Browser `run` code executes in an isolated worker. | `packages/lazy-prime-core/src/tools/browser.ts` |
| The root launcher preserves in-process extension renderers. | `bin/lazy-prime.mjs` |
