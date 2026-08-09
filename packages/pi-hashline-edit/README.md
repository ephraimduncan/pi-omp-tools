# pi-hashline-edit

Hashline `edit` tool for [pi](https://pi.dev) / prime-agent — a lean reimplementation of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s line-anchored patch language.

- `[path#TAG]` sections anchored on 4-hex content hashes minted by `read`/`search`
- `PUT A.=B:` replace · `PUT <A:`/`PUT >A:` insert · `PUT A*:` block replace (tree-sitter/markdown/indent resolution) · `CUT`/paste registers that persist across calls · `REM`/`MV`
- Stale-anchor recovery: changed files are line-diffed against the recorded snapshot; intact anchors are remapped, anything ambiguous fails closed with a re-read hint
- Responses show post-edit numbered lines + the fresh tag for chained edits

Overrides the built-in `edit`. Pair with [pi-read](../pi-read) and [pi-search](../pi-search) for anchors.

Part of [pi-omp-tools](../../README.md). MIT.
