# Agent Note: Shield per-repo exemption (settings `repos`, mount gate, `repo-disabled`)

Status: implemented

## Problem

The Settings → Shield switch was harness-global: `enabled: false` unmounted the paid engine for every session and every repo. Users needed Shield generally on but off for specific repos — noisy fixtures, trusted internal checkouts — without letting a repo under audit steer its own audit, and without the seat reaching into engine internals it does not own.

## Decision

**Repo identity is `realpath(session.header.cwd)`** — the same key the engine's per-repo stats store and `ShieldHost.resolveCwd` already use. One identity serves UI, seat, and stats; git-toplevel was rejected because it forks that key, costs a subprocess per session, and breaks subdirectory and monorepo workspaces. Sessions without a cwd are unknown repos and default to enabled.

**Storage is a `repos` exception map inside the `shres-shield` settings namespace** (`packages/guard/shield/src/repos.ts`): absolute repo path → `{ enabled: boolean }`, validated by the namespace `validate` hook to reject relative or empty keys at the write. A repo-local config file was rejected outright: a guard's audited artifact must not author its own audit config, in either direction. The map lives in the host-owned `settings.yaml` outside every repo tree; the only write path is the user-gesture Web settings page — the API proxy serves the namespace to the Web client only, and no tool or automation surface writes settings.

**Carve-out-only precedence**, evaluated in one pure function (`repoGateBlocksMount`): `SHRES_SHIELD=off` (`panic`), then diagnostics (`engine-missing`, `unlicensed`), then global `enabled: false` (`disabled`), then a repo entry (`repo-disabled`), then on. The global switch stays master — an entry can only disable, never re-enable under a global off — so the operator's kill story stays absolute. Diagnostics beat preferences: a missing engine or license outranks any preference because flipping the switch cannot fix it. This reorders the seat's pre-existing check sequence (global-off used to precede engine resolution); no observable test depended on the old order.

**Enforcement is a seat-side mount gate, not verdict suppression.** The engine applies once per harness boot and owns its registrations; a seat-side suppression wrapper would not be enforcement (bypassable, and per `packages/AGENTS.md` wrappers are not enforcement). `sync()` unmounts with `'repo-disabled'` when every live session's repo is exempt; no live sessions (idle harness) stays mounted. Re-evaluation is both push (`session/created` / `session/disposed` fire `sync()`) and pull (every `snapshot()` call re-runs the gate and triggers `sync()` only on a decision flip — the safety net for scope-filtered session events). Known limit, accepted: while enabled and exempt repos both have live sessions, the engine stays mounted for the enabled ones and still screens the exempt repos. Over-screening is the fail-secure direction for a guard; exact suppression needs an engine-side exclusion contract, filed as the [repo exclusion proposal](../../proposed/feature/2026-08-24-shield-engine-side-repo-exclusion.md). The seat still forwards only `{ posture }` to `apply`.

**Status vocabulary splits harness mount from per-repo view.** `ShieldInactiveReason` gains `'repo-disabled'`; `ctx.shield.status` is the harness-wide mount status, while `snapshot(sessionId)` reports the requested repo's effective status — a mounted engine screening an exempt repo reports `'repo-disabled'` for that repo, and diagnostic or global-off reasons always pass through. The Settings brand mark follows the current session's snapshot `active` (with the global toggle's optimistic echo until the next snapshot corrects it); previously it echoed only the global switch.

**Settings UI** (`packages/client/ui-settings-shield`): a current-repo switch beside the global one (repo path from the snapshot cwd; disabled with "No repo for the current session" when null), a sorted exemption list with Remove, an empty state, and the one-sentence precedence copy. Writing removes the entry to re-enable — the map stays a pure exception list; `enabled: true` is legal but inert. No directory picker in v1: `ui-directory-picker-browse` fills workspace slot holes, not settings imports; a picker needs a new slot hole owned by the workspace entry, deferred.

## Alternatives considered

**Repo-local config file.** Rejected: the audited repo becomes the author of its audit config; also unkeyed to the engine's stats identity and invisible to the Settings page.

**Both-directions override (default-off + per-repo on).** Deferred: it makes the global off non-absolute, weakening the kill switch of a guard product and creating two ways to say "on". The inverse-default use case changes `resolveRepoGate` and one locale sentence if it ever lands, not storage or UI shape.

**Per-session engine instances or seat-side verdict suppression.** Rejected: one `apply` per boot is the engine contract; suppressing verdicts from the seat is bypassable wrapper enforcement the repo conventions forbid.

**Git-toplevel repo identity.** Rejected: splits the one existing repo key, subprocess cost per session, subdirectory/monorepo workspaces stop matching.

## Consequences

Single-session repos — the dominant GUI shape — get exact gating: the engine fully unmounts (no doctrine, no tool wrapping, no approval interception) while other repos keep screening. Concurrent mixed-repo sessions over-screen the exempt repos until the engine-side contract lands. The `settings.yaml` section grows `repos` (pre-release: no migration; old documents without the key resolve to `{}`). `test:gui` web snapshots for the pane change with the new controls. The config catalog entry for `shres-shield` regenerated; that regen also caught up `llm-cli-bridge` route fields whose JSDoc prose was missing on a clean tree (two-line drive-by, blocks the catalog gate).

## Testing

`packages/guard/shield/tests/repos.spec.ts` (gate precedence, symlinked-key normalization against the realpath cwd, vanished-key exact compare, live-cwd collection, key validation); `shield.spec.ts` per-repo block (unmount on exempt-only live set, stay mounted with one enabled repo, master-switch and diagnostic precedence, pull-driven unmount and remount, per-repo snapshot status); `shield-e2e.spec.ts` per-repo scenario (real sibling dist: gate flips through the snapshot pull, the same message then passes with no seam fired). Client: `section.client.spec.tsx` (exempt/restore writes, sorted list with remove, empty state and null-cwd disable, master-on + repo-exempt display, mark from per-session status). Pre-existing red on clean develop noted in the handoff: 14 shield-e2e detection scenarios drift against the locally rebuilt sibling dist, `test:gui` has ~30 unrelated failing files, and the config-catalog violation pair above.

## Related

- [Paid shres-shield default seat](2026-08-17-paid-shres-shield-default-seat.md) — the seat's mount, entitlement, and resolve legs this gate rides on.
- [Shield pane and trajectory badges](2026-08-17-shield-pane-and-trajectory-badges.md) — the Settings pane this section extends.
- [Shield edition provision](2026-08-24-shield-edition-provision.md) — the profile-installed payload leg the resolver walks.
- [Engine-side repo exclusion proposal](../../proposed/feature/2026-08-24-shield-engine-side-repo-exclusion.md) — the follow-up that removes the over-screening limit.
