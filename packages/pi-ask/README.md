# pi-ask

The `ask` tool gives pi and prime-agent structured follow-up questions for interactive runs, replicating oh-my-pi's ask tool contract.

One call carries several `questions`; each renders as a dialog with the model's options plus an automatic "Other (type your own)" entry and a "Chat about this" escape. `recommended` marks the default option and `multi: true` allows multiple selections via a toggle loop. Non-interactive runs fail fast with an instruction to proceed on stated assumptions.

This package is part of [pi-omp-tools](../../README.md). The package has the MIT license.

## Evidence

| Claim | Source |
|---|---|
| Reserved runtime option labels are enforced | `../omp-tools-core/src/tools/ask.ts:19-23` |
| Other/Chat options are appended automatically | `../omp-tools-core/src/tools/ask.ts:116-124` |
| Multi-select is a checkbox toggle loop | `../omp-tools-core/src/tools/ask.ts:127-165` |
| Non-interactive runs fail with a proceed instruction | `../omp-tools-core/src/tools/ask.ts:186-190` |
