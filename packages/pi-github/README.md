# pi-github

`github` is a tool for [pi](https://pi.dev) and prime-agent. The tool uses GitHub CLI for repository and pull-request operations.

Install [GitHub CLI](https://cli.github.com/). Then authenticate the GitHub CLI session.

This package is part of [pi-omp-tools](../../README.md). MIT.

| Claim | Evidence |
| --- | --- |
| The package registers the `github` tool. | `packages/pi-github/index.ts:1-5` |
| The tool uses the `gh` executable. | `packages/omp-tools-core/src/tools/github.ts:377-384` |
