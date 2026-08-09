# pi-write

`write` tool for [pi](https://pi.dev) / prime-agent: create or overwrite a file, a zip/tar archive entry, or a SQLite row.

- `path/to/file` — create/overwrite (mkdir -p, `#!` → chmod +x); response includes the new `[path#TAG]` anchor
- `archive.zip:member/path` — write/replace an archive member
- `db.sqlite:table` — insert JSON row(s); `db.sqlite:table:key` — update (JSON) or delete (empty content)

Part of [pi-omp-tools](../../README.md). MIT.
