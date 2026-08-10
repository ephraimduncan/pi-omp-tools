# @ephraimduncan/pi-tmp-scratch

[oh-my-pi](https://github.com/can1357/oh-my-pi)-style `/tmp` scratch discipline for [pi](https://pi.dev) and prime-agent.

omp keeps throwaway work out of the repository by rooting its session scratch space under the OS temp dir and steering the model there. This extension gives pi/prime-agent the same habit, so you can wipe `/tmp` whenever you like and lose nothing but junk.

## What it does

- **Per-session scratch dir** — on `session_start` it creates `/tmp/prime-scratch/<session-id>` (falls back to `os.tmpdir()` if `/tmp` is unwritable) and exports it as `$PRIME_SCRATCH_DIR`.
- **System-prompt steering** — on `before_agent_start` it appends a `## Scratch space` block: all temporary work (probe/repro scripts, one-off clones, downloads, generated fixtures, build junk, large intermediates) goes to the scratch dir, never into the repo/workspace; nothing durable is stored there because `/tmp` gets wiped.
- **`/scratch` command** — shows the directory and a contents summary; `/scratch clean` empties it.

`/tmp` is preferred over `os.tmpdir()` deliberately: on macOS `os.tmpdir()` is `/var/folders/...`, which survives a manual `/tmp` cleanout. The scratch dir lives where you actually clean.

## Install

Comes with the monorepo (recommended):

```bash
prime-agent package install git:github.com/ephraimduncan/pi-omp-tools
pi install git:github.com/ephraimduncan/pi-omp-tools
```

Or standalone from a local clone:

```json
{ "packages": ["/path/to/pi-omp-tools/packages/pi-tmp-scratch"] }
```

## License

MIT
