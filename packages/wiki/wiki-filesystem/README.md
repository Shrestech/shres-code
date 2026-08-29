# @shres-code/shres-code-wiki-filesystem

Markdown Service Provider for `ctx.wiki`. Pages, the generated `index.md`, day-sharded `log/YYYY-MM-DD.md` files, `archive/`, and project `config.yaml` live at `<projectRoot>/.shres/wiki`. The directory is created on the first write — an enabled seat does not pollute a project that has never stored a page.

Writes go through `@shres-code/shres-code-atomic-write`. A Chokidar watcher plus `fs/observed` invalidation keep the in-memory page cache coherent with host edits. `index.md` is regenerated after every write and is never a hand-edited source of truth.

## Plugin (namespace: `wiki-filesystem`)

```yaml
- id: wiki-filesystem
  name: '@shres-code/shres-code-wiki-filesystem'
  config:
    enabled: true
    root: .shres/wiki
    watch: true
    hotDays: 7
    warmDays: 30
    demoteDays: 90
    indexMaxLines: 200
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `.shres/wiki` | Wiki directory. Relative values resolve under the `.git`-walk project root of `cwd`. Absolute values are used as-is. Empty string fails at mount. |
| `cwd` | `process.cwd()` | Origin of the `.git` walk when `root` is relative. |
| `watch` | `true` | Watch the materialized root for external edits. |

Engine tunables (`enabled`, `hotDays`, `warmDays`, `demoteDays`, `indexMaxLines`, `roles`) are the Service Definition's Config, accepted here so a single plugin row configures the seat.

Project `config.yaml` overlays engine tunables and the librarian role for this repository. It is not a substitute for the `wiki` settings namespace.

## Layout

```
.shres/wiki/
  config.yaml      # optional project overlay
  index.md         # generated projection; do not edit
  <page>.md        # knowledge pages
  log/YYYY-MM-DD.md
  archive/         # COLD-past-demoteDays pages; never deleted
```

## Model Experience

None, as this provider persists markdown on disk; the tool Consumer owns every model-visible byte.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Single-process cache** — a second process over the same wiki root does not see the other's writes until the watcher or the next load. There is no cross-writer lock beyond atomic rename of individual files.
- **Recursive `readdir` follows the host filesystem** — pages behind a dangling symlink are skipped when the native read fails.
