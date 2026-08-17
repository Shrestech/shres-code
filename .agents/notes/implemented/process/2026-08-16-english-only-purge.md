# Agent Note: English-only purge

Status: implemented

## Problem

The repository maintained English and Simplified Chinese documentation as equal-authority sibling files, plus pairing records, translation gates, a translate-docs skill, and a Chinese UI locale. That machinery is a product surface, not just a docs convenience: it forced every documentation change through pairing, shipped a Chinese VitePress locale, and treated `zh` as the browser client's fallback. The owner decided on 2026-08-16 that the product ships English-only. Conversation remains any-language because that is the model's job, not a harness translation layer.

The Agent Note archive was a frozen bilingual triplet tree. `--write` is append-only and refuses changed or missing seals, so deleting the 142 archived Chinese halves and sidecars would fail the verifier unless a sanctioned rebase replaced the sealed set.

## Decision

The product is English-only:

- Tracked `*.zh.md` and `*.i18n.yaml` outside `vendor/` are gone. `scripts/purge-zh.ts --apply/--check` is the idempotent re-run surface; `purge-zh:check` is a hygiene leaf.
- The `shres-translate-docs` skill and its `.claude` mirror are gone. Translation scripts, pairing records, merge drivers, and `docs/i18n/` policy pages are gone. `doc-sync` no longer runs pairing checks.
- The browser client ships `LOCALE_IDS = ['en']`. A persisted `zh` preference normalizes to `en` on read and is not rewritten on disk.
- The documentation site projects English sources onto the root locale only.
- `scripts/verify-no-zh-artifacts.ts` rejects leftover `*.zh.md` / `*.i18n.yaml` and CJK code points in tracked text outside an explicit allowlist. Frozen archived English notes, vendored upstream, and UTF-8 test fixtures are the legitimate remainders.

The archive boundary was rewritten once. `verify-archived-agent-notes --rebase` re-sealed the surviving English files after the purge. That rebase is not a general tool: the owner sanctioned it for this purge on 2026-08-16, and the boundary is frozen again afterward. Routine archival still uses append-only `--write`.

## Consequences

Documentation, READMEs, Agent Notes, generated catalogs, and the Web UI are English. Cherry-picks that restore a Chinese sibling fail `purge-zh:check` and `verify-no-zh-artifacts`. Re-run `pnpm run purge-zh --apply` after stacking later PRs that were cut before the purge. A leftover `zh` locale setting continues to validate on the Host document and becomes English in the client without a settings migration. Archived English notes keep their historical language-switcher line; that line is not a live link. `ci-static` now runs the brand/zh hygiene leaves so a restored sibling fails the PR static lane.

## Alternatives considered

**Keep Chinese as an optional locale and drop only the pairing gate.** Rejected because the owner dropped Chinese language support entirely: docs, READMEs, sidecars, UI locale, gates, and the sealed archive.

**Rewrite archived English bodies to remove switcher lines.** Rejected because the sanctioned rewrite is the manifest rebase plus deletion of Chinese halves. Frozen English text stays as sealed.

**Migrate persisted `zh` settings to `en` on disk.** Rejected because this is pre-release and the read-path normalize is enough.
