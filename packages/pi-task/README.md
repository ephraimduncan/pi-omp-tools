# pi-task

The `task` tool gives pi and prime-agent parallel subagent fan-out, replicating oh-my-pi's task tool contract.

The tool takes one `tasks[]` batch plus shared `context` and spawns one host CLI process per item (`--mode json -p --no-session`), bounded to 4 concurrent subagents. Each item may name an agent definition (markdown + frontmatter from `.pi/agents/` or the user agents dir) for model/tools/system-prompt selection. `isolated: true` runs the item in a detached git worktree, captures its diff as a patch artifact, and applies it back to the parent checkout (retained on conflict).

This package is part of [pi-omp-tools](../../README.md). The package has the MIT license.

## Evidence

| Claim | Source |
|---|---|
| Batch shape and flat-form folding | `../omp-tools-core/src/tools/task.ts:560-575` |
| Subagents spawn the host CLI in json print mode | `../omp-tools-core/src/tools/task.ts:284-296` |
| Worktree isolation captures and applies a patch | `../omp-tools-core/src/tools/task.ts:231-258` |
| Concurrency is bounded and order-preserving | `../omp-tools-core/src/tools/task.ts:470-479` |
