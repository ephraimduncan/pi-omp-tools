# pi-bash

The `bash` tool gives pi and prime-agent a workspace shell with optional PTY and background-job dispatch, replicating oh-my-pi's Runtime bash contract.

When the optional `@oh-my-pi/pi-natives` addon is installed (omp's published napi bundle that vendors brush-core and portable-pty), commands run on omp's own embedded brush shell: one persistent session per host session, so `cd`, exports, functions, and aliases survive across calls, and `pty: true` allocates a real PTY. Without the addon the tool falls back to a per-call system shell (`$SHELL -c`) with a `script`-based PTY. `OMP_TOOLS_BASH_NO_BRUSH=1` forces the fallback.

The tool takes `cwd`/`env` params and a clamped timeout (default 300s, `0` disables). `async: true` dispatches a background job that returns an id immediately and auto-delivers its settled result; slow foreground commands auto-background after 60s. `op: jobs|output|wait|kill` manages jobs.

This package is part of [pi-omp-tools](../../README.md). The package has the MIT license.

## Evidence

| Claim | Source |
|---|---|
| brush shell loads from @oh-my-pi/pi-natives (Bun entry or platform leaf under Node) | `../omp-tools-core/src/tools/bash.ts:146-198` |
| One persistent brush session per host session, with cwd tracking | `../omp-tools-core/src/tools/bash.ts:200-221` |
| Real PTY via the addon; `script` fallback otherwise | `../omp-tools-core/src/tools/bash.ts:404-449` |
| Background jobs auto-deliver via the host's sendUserMessage | `../omp-tools-core/src/tools/bash.ts:625-640` |
| Foreground commands auto-background after a threshold | `../omp-tools-core/src/tools/bash.ts:713-736` |
