# Agent Note: Shield engine-side repo exclusion contract

Status: proposed

## Problem

The shres-code seat gates Shield per repo at mount time ([per-repo exemption](../../implemented/feature/2026-08-24-shield-per-repo-exemption.md)): the engine unmounts only when *every* live session's repo is exempt. When enabled and exempt repos have live sessions concurrently, the engine stays mounted for the enabled ones and still screens the exempt repos. Over-screening is fail-secure, but the exemption the user configured is not honored exactly, and the seat cannot fix this alone — verdict interception lives inside the paid engine's own registrations.

## Proposal

Extend the payload contract in the sibling `shres-shield` repo (`docs/integration-shres-code.md`) with an exclusion the engine itself enforces, either:

- an `apply(ctx, { posture, repos: { disabled: string[] } })` config the engine consults per verdict (realpath-normalized cwds, same identity as its stats store), or
- a suppression callback the seat registers and the engine calls before acting on a verdict.

The seat already computes the exempt set (`repoDisabled` over live session cwds); it would forward it on `apply` and refresh it through the existing push/pull re-evaluation. The engine-side check is the enforcement point — a seat-side wrapper stays bypassable.

## Alternatives considered

**Per-session engine instances.** Rejected: one `apply` per boot is the contract; per-session instances multiply the paid payload's own state (stats store, approval manager, seed packs) with no current consumer.

**Accept over-screening permanently.** Rejected as the end state: it is the correct interim direction (fail-secure for a guard) but silently ignoring a configured exemption erodes trust in the Settings page.

## Consequences

Landing this removes the seat README's over-screening limitation and the per-repo snapshot's honest-but-awkward `'repo-disabled'`-while-screened report. The seat change is additive: forward `repos` only when the contract exists, keep the mount gate as the coarse first cut. Work lives in the sibling repo; this note tracks the harness side so the follow-up is not lost.

## Acceptance criteria

- The engine suppresses verdicts for sessions whose realpath cwd appears in the excluded set, in every channel (user message, tool args, tool result).
- The seat forwards the exempt set at `apply` and refreshes it through the existing push/pull re-evaluation without a remount.
- The mixed-live-repos e2e scenario passes: the exempt session is unscreened while the concurrent enabled session still gets verdicts.
- The seat README's over-screening limitation is removed together with the contract.

## Risks

- The contract crosses the paid payload boundary: a stale exclusion set after rapid session churn could over- or under-screen until the next refresh; the refresh must ride the same serialized chain as the mount gate.
- Widening `apply`'s config is a compatibility surface for every payload version the seat can resolve; the field must be optional so older payloads ignore it.

## Testing

Engine side (sibling repo): verdict suppression per disabled cwd including symlinked paths. Harness side: the mixed-live-repos scenario in `shield-e2e.spec.ts` asserts an exempt session passes unscreened while an enabled concurrent session still gets its verdicts.

## Related

- [Shield per-repo exemption](../../implemented/feature/2026-08-24-shield-per-repo-exemption.md) — the shipped seat-side gate this builds on.
