# pi-web-search

The `web_search` tool searches current web data through Exa or Parallel. It returns an answer and a list of source links.

Set either `EXA_API_KEY` or `PARALLEL_API_KEY`. By default, Exa has priority. Use `OMP_TOOLS_SEARCH_PROVIDER=exa|parallel` to select a provider.

This package is part of [pi-omp-tools](../../README.md). MIT.

| Claim | Evidence |
| --- | --- |
| The tool can use Exa and Parallel. | `../omp-tools-core/src/tools/web-search.ts:40-54` |
| The result includes an answer and source links. | `../omp-tools-core/src/tools/web-search.ts:56-81` |
| The selection supports a set provider and an Exa-first default. | `../omp-tools-core/src/tools/web-search.ts:84-101` |
