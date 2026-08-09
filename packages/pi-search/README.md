# pi-search

`search` tool for [pi](https://pi.dev) / prime-agent: ripgrep-powered regex over files, directories, and globs (pure-JS fallback without rg).

- Semicolon-separated roots, `file.ts:50-100` line scopes, smart-case, literal mode, context lines, multiline, `skip` pagination
- Output groups matches under `[path#TAG]` snapshot headers with `N:text` rows — valid anchors for the hashline `edit` tool
- Retires the built-in `grep`/`rg` tools from the active set (opt out: `OMP_TOOLS_KEEP_BUILTINS=1`)

Part of [pi-omp-tools](../../README.md). MIT.
