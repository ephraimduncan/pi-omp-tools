# pi-ast-grep

`ast_grep` tool for [pi](https://pi.dev) / prime-agent: structural code search via [ast-grep](https://ast-grep.github.io) patterns (`$NAME`, `$$$ARGS` metavariables).

- js/ts/tsx/css/html built in via `@ast-grep/napi`; python/rust/go/java/c/cpp/json/yaml via optional `@ast-grep/lang-*` grammars
- Output matches the `search` shape: `[path#TAG]` headers + numbered rows, `skip` pagination, parse errors reported as query failures (not absence)

Part of [pi-omp-tools](../../README.md). MIT.
