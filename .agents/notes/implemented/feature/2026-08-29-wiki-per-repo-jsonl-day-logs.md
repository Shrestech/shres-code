# Agent Note: Per-repository wiki roots and JSONL day logs

Status: implemented

## Problem

`wiki-filesystem` resolved its relative `.shres/wiki` root from `config.cwd ?? process.cwd()` — the host process's launch directory. In a multi-session host whose sessions open on different repositories, every session read and wrote the launch repo's wiki, so a session working in repo A filed knowledge into repo B's `.shres/wiki`. The markdown day log compounded the problem: each append rewrote the shard and recorded only shard-level frontmatter instants, so no individual entry carried its own timestamp and nothing machine-readable recorded when an activity happened.

## Decision

Store-touching `ctx.wiki` members take the owning session and pass its recorded `cwd` to the provider hooks. The provider `.git`-walks from that directory and caches one `WikiMarkdownStore` per resolved root, so each session reads and writes `<its repo>/.shres/wiki`; sessions without a recorded `cwd` fall back to the configured `cwd`/`process.cwd()`, and an absolute `root` pins one store for every session. `hasPage` spans every materialized store root so the `wiki/page` invariant holds across repositories.

`appendLog` is a logger-style append: the service picks the system clock, selects `log/DD-MM-YY.jsonl` from the machine's local date, and appends one JSONL line `{"ts", "session", "body"}` carrying the full ISO append instant and the owning session id. The shard is never rewritten. `wiki_log` and the librarian proposal contract tell the model never to include a date or time.

## Alternatives considered

**Anchor the root on the host launch directory (previous behavior).** Rejected: a multi-session host collapses every repo onto one wiki that the user never chose.

**Keep markdown day shards and ask the model to stamp entries.** Rejected: model-supplied timestamps are unreliable, and shard-level frontmatter cannot timestamp individual appends; the format would need system-fabricated prefixes anyway.

**Store pages as JSONL too.** Rejected: pages are mutable current-state documents with per-page frontmatter lifecycle (`touched` bumps, status flips); JSONL either reintroduces read-modify-write or grows unbounded append history that needs compaction, while giving up editor rendering, grep, and per-page git diffs. The day log is the append-only event stream; pages stay the materialized view.

**UTC day shards.** Rejected for shard naming because the log follows the machine's local working day; line timestamps stay full ISO instants, so cross-machine analysis is unaffected.

## Consequences

Every repo a session starts in materializes its own `.shres/wiki` on first write; the host launch directory no longer decides where wiki files land. The librarian consolidates into the shipping session's repo because its `writePage`/`appendLog` calls carry the session. Existing markdown day shards remain loadable as pages but are never appended again; new appends go to the JSONL shard of the current local day and are machine-only — not pages, not searchable, not indexed. `engineConfig`/`projectConfig` resolve per repository, so project `config.yaml` overlays are per-repo.

## Testing

`wiki-filesystem` specs cover per-session-repo rooting with two sessions on two repositories, JSONL line fields across two appends, shard loading (`has` sees shards, page lists exclude them), and legacy markdown shard loading; `wiki` specs cover the local `DD-MM-YY` shard name and session-cwd threading through `MemoryWiki`; tool and librarian specs exercise the threaded signatures through the real provider.
