# pi-ast-edit

`ast_edit` tool for [pi](https://pi.dev) / prime-agent: structural AST rewrites via [ast-grep](https://ast-grep.github.io) patterns — for codemods where text replace is unsafe.

- Ops are `{pat, out}` pairs; metavariables captured in `pat` substitute into `out`
- **Dry-run by default**: matches render as unified diffs; re-issue with `"apply": true` to write
- Same language coverage as [pi-ast-grep](../pi-ast-grep)

Part of [pi-omp-tools](../../README.md). MIT.
