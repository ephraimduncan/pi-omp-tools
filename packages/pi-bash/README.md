# pi-bash

The `bash` tool gives pi and prime-agent a workspace shell with optional PTY and background-job dispatch, replicating oh-my-pi's Runtime bash contract.

The tool runs one command per call with `cwd`/`env` params and a clamped timeout (default 300s, `0` disables). `pty: true` allocates a real PTY through the `script` binary. `async: true` dispatches a background job that returns an id immediately and auto-delivers its settled result; slow foreground commands auto-background after 60s. `op: jobs|output|wait|kill` manages jobs.

This package is part of [pi-omp-tools](../../README.md). The package has the MIT license.

## Evidence

| Claim | Source |
|---|---|
| The tool clamps timeouts to omp's bash range | `../omp-tools-core/src/tools/bash.ts:26` |
| PTY allocation goes through the `script` binary | `../omp-tools-core/src/tools/bash.ts:127-143` |
| Background jobs auto-deliver via the host's sendUserMessage | `../omp-tools-core/src/tools/bash.ts:365-380` |
| Foreground commands auto-background after a threshold | `../omp-tools-core/src/tools/bash.ts:430-455` |
