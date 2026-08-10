# pi-todo

The `todo` tool gives pi and prime-agent a phased task list. The tool uses the full task text as the task key.

The tool sets the next open task to `in_progress`. The tool stores the list in a scratch file.

This package is part of [pi-omp-tools](../../README.md). The package has the MIT license.

## Evidence

| Claim | Source |
|---|---|
| The tool uses phased tasks and full task text | `../omp-tools-core/src/tools/todo.ts:9-30` |
| The tool changes the task state and sets the next task | `../omp-tools-core/src/tools/todo.ts:88-97` |
| The tool stores the list in a cwd-keyed scratch file | `../omp-tools-core/src/tools/todo.ts:355-378` |
