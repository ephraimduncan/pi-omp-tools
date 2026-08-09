# pi-find

`find` tool for [pi](https://pi.dev) / prime-agent: glob-based path lookup — newest-first, gitignore-aware (via rg's walker, tinyglobby fallback), directories end in `/`.

Use `search` when you need content matches; `find` only matches paths. Retires the built-in `glob`/`ls` tools from the active set (opt out: `OMP_TOOLS_KEEP_BUILTINS=1`).

Part of [pi-omp-tools](../../README.md). MIT.
