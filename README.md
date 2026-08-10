# pi-omp-tools

[oh-my-pi](https://github.com/can1357/oh-my-pi)-inspired file & search tools for [pi](https://pi.dev) and [prime-agent](https://github.com/earendil-works), packaged as separate extensions.

Lean reimplementations of omp's core tool suite — no omp runtime, just the ideas:

| Package | Tool | Description |
|---------|------|-------------|
| [pi-read](packages/pi-read) | `read` | Files, dirs, archives, SQLite, PDFs, notebooks, images, and URLs through one path — mints `[path#TAG]` hashline anchors |
| [pi-write](packages/pi-write) | `write` | Create/overwrite a file, zip/tar archive entry, or SQLite row |
| [pi-hashline-edit](packages/pi-hashline-edit) | `edit` | Hashline patches: line-anchored edits with content-hash anchors, block ops (`N*`), cut/paste registers, and stale-anchor recovery |
| [pi-search](packages/pi-search) | `search` | ripgrep-powered regex over files/globs; output rows double as edit anchors |
| [pi-find](packages/pi-find) | `find` | Glob path lookup, newest-first, gitignore-aware |
| [pi-ast-grep](packages/pi-ast-grep) | `ast_grep` | Structural code queries via tree-sitter (ast-grep patterns) |
| [pi-ast-edit](packages/pi-ast-edit) | `ast_edit` | Structural rewrites, previewed before apply |
| [pi-tmp-scratch](packages/pi-tmp-scratch) | — | Per-session scratch dir under `/tmp` + prompt steering: temporary work never lands in the repo, and wiping `/tmp` is always safe (`/scratch`, `/scratch clean`) |

All tools share one engine ([omp-tools-core](packages/omp-tools-core)) and one snapshot store (anchored on `globalThis`, so tags minted by `read`/`search` validate in `edit` even when the tools are installed as separate packages).

## Install

Everything at once (recommended — the tools are designed as a unit):

```bash
# pi
pi install git:github.com/ephraimduncan/pi-omp-tools

# prime-agent
prime-agent package install git:github.com/ephraimduncan/pi-omp-tools
```

Or from a local clone:

```bash
git clone https://github.com/ephraimduncan/pi-omp-tools
cd pi-omp-tools && npm install
prime-agent package install /path/to/pi-omp-tools        # or add to settings.json "packages"
```

Individual tools from a local clone — point settings at a single package:

```json
{ "packages": ["/path/to/pi-omp-tools/packages/pi-search"] }
```

Each package under `packages/` is also npm-publish-ready (`pi install npm:@ephraimduncan/pi-search`) if you want registry installs.

Try without installing:

```bash
prime-agent -e /path/to/pi-omp-tools
pi -e /path/to/pi-omp-tools
```

## System-prompt integration

Registering tools is not enough — models fall back to `bash`/`ipython` habits unless the prompt steers them. Every package wires three levers:

1. **`promptGuidelines`** per tool — bullets the host appends to its default system prompt ("Use search instead of shell grep/rg …").
2. **`before_agent_start`** — appends an `## omp-tools` workflow block describing the `read → edit` anchor loop for whichever tools are installed.
3. **Built-in retirement** — on `session_start`, same-purpose built-ins (`grep`, `glob`, `rg`, `ls`) are deactivated when `search`/`find` are present. Same-name built-ins (`read`/`write`/`edit`) are replaced by registration. Opt out with `OMP_TOOLS_KEEP_BUILTINS=1`.

## /tmp scratch discipline

omp roots its session scratch space under the OS temp dir so throwaway work never pollutes the repository. [pi-tmp-scratch](packages/pi-tmp-scratch) ports that habit: each session gets `/tmp/prime-scratch/<session-id>` (exported as `$PRIME_SCRATCH_DIR`), and a `## Scratch space` system-prompt block sends all probe scripts, one-off clones, downloads, and intermediate junk there. Clean `/tmp` whenever you like — nothing durable is stored in it. `/scratch` shows the dir, `/scratch clean` empties it.

## Rich UI in prime-agent: the `prime-omp` launcher

Interactive prime-agent attaches its TUI to a **daemon-hosted** session; extension render
functions cannot cross that RPC boundary, so custom tool UIs are dropped (only the `edit`
tool stays rich, via built-in replay). The bundled launcher uses prime's public
`main(args, { extensionFactories })` API to run the session **in-process**, where all
seven tools render with the full custom UI (colored diffs, gutters, match highlighting):

```bash
# alias it once (adjust the clone path if you use a local checkout)
alias prime='node ~/.prime/agent/git/github.com/ephraimduncan/pi-omp-tools/bin/prime-omp.mjs'

prime                  # prime-agent, in-process, full omp-tools UI
prime -p "..."         # all normal flags pass through
```

Trade-offs vs plain `prime-agent`: the session lives in your terminal process (still saved
and resumable, but not persistent in the background), no multi-client attach, no agents
view. Plain `prime-agent` keeps working unchanged alongside it.

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

- `PUT A.=B:` replace lines, `PUT <A:`/`PUT >A:` insert, `PUT A*:` replace the block starting at A, `CUT A.=B [@r]` delete/capture, `PUT >N @r` paste, `REM`/`MV` file ops.
- Tags are 4-hex content hashes. A stale tag with intact anchor lines is auto-recovered by remapping through a line diff; anything ambiguous fails closed with a re-read hint.
- Block resolution: markdown headings → sections; tree-sitter via `@ast-grep/napi` for js/ts/tsx/css/html (+ optional grammars); bracket/indentation heuristics elsewhere.

## Requirements

- Node ≥ 20 (or Bun) in the host agent.
- Recommended on PATH: `rg` (search/find/file-walking), `unzip`/`zip` (zip archives), `tar`, `pdftotext` (PDFs). Everything degrades gracefully without them.
- SQLite uses `node:sqlite` → `bun:sqlite` → `sqlite3` CLI, whichever exists.
- Optional tree-sitter grammars (python, rust, go, java, c, cpp, json, yaml) install as `optionalDependencies`; without them `ast_grep`/`ast_edit` cover js/ts/tsx/css/html.

## Development

```bash
npm install
npm run typecheck
npm test          # node --test test/smoke.test.ts
```

## Credits

- [oh-my-pi](https://github.com/can1357/oh-my-pi) — tool design, the hashline patch language, and the prompt texts these descriptions are adapted from.
- [ogulcancelik/pi-extensions](https://github.com/ogulcancelik/pi-extensions) — monorepo layout inspiration.

## License

MIT
