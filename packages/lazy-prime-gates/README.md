# Lazy Prime Gates

`@ephraimduncan/lazy-prime-gates` is a self-contained policy extension for pi and Prime Agent. Install the package as an extension. Its `pi.extensions` entry loads `index.ts`.

The extension provides these permanent blocks:

- AI agent or bot attribution in Git commits.
- `--no-verify` in Git commands.
- Fill-derived pull request bodies.

The extension also pauses matching writes for a focused review:

- Simple code structure and plain names.
- Tests that name an observable break and use real interfaces.
- Direct React `useEffect` calls.
- STE-100 prose for commits, tags, issues, releases, and documentation.
- Pull request titles, bodies, comments, and reviews.

A single tool-call dispatcher combines overlapping reviews. One test mutation with a direct `useEffect` call receives one pause, not three pauses. The matching successful tool result records one combined note.

The extension supports the root `bash` tool and Prime IPython `%%bash`, `%%sh`, and `!command` shell regions. It injects noninteractive Git editor variables into the shell region that contains Git.

All review guides ship in `guides/`. The package does not read user home directories and does not import a host package.

## State model

Review state is separate for each policy and target. A blocked review opens a reissue window. A matching successful result commits that review. A new `agent_start` abandons an unused window. Session start, context compaction, and session-tree navigation reset context review state.

Outward prose reviews repeat for each command. Code, test, effect, and documentation reviews stay open for their target path until the context resets.

## License

MIT
