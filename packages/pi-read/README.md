# pi-read

Unified `read` tool for [pi](https://pi.dev) / prime-agent: files, dirs, archives, SQLite, PDFs, notebooks, images, and web URLs through one `path`.

```bash
pi install git:github.com/ephraimduncan/pi-omp-tools   # whole suite
```

Selectors: `:50-200`, `:50+150`, `:5-16,960-973`, `:raw`, `db.sqlite:users:42`, `archive.zip:member/path`, `?limit=/?where=/?q=SELECT…`.

Text reads emit `[path#TAG]` snapshot headers + `N:text` rows — the anchors consumed by the hashline `edit` tool ([pi-hashline-edit](../pi-hashline-edit)).

Part of [pi-omp-tools](../../README.md). MIT.
