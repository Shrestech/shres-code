# Agent Note: Keyless e2e for the researcher changes (PR #37, PR #38)

Status: implemented

## Problem

The two merged researcher changes shipped with only unit coverage: PR #37 (jspace goal-epoch reset) and PR #38 (tracker-shrestech real-fetch transport). Unit tests stub the transport and assert on tool return values and in-memory card state, so they cannot prove the real behaviors the PRs claim — that a different-Goal open resets Core and Checked on the folded card as recorded in the session log, and that the tracker lands/spools/drains runs over a real HTTP server. The e2e lane self-skips without `DEEPSEEK_API_KEY`, so these keyless behaviors had no always-running proof.

## Decision

Add two keyless e2e files that always run in `pnpm run test:e2e` (no model, no API key, no `describe.skipIf`):

- `packages/jspace/tool-jspace/tests/goal-epoch-reset.e2e.ts` mounts the jspace seat plus tool-jspace exactly as the unit spec does, then drives `jspace_open` → `jspace_note` → `jspace_checkpoint` → `jspace_ship` → a different-Goal `jspace_open` → `jspace_ship` (refused) → `jspace_checkpoint` → `jspace_ship` (passes) → a same-Goal `jspace_open`. It asserts the folded card state from the session event log — the last `jspace/card` event's whole-card snapshot — not from tool return values alone, proving Core and Checked reset on a different Goal and are preserved on a same-Goal open.
- `packages/tracker/tracker-shrestech/tests/transport.e2e.ts` spins a real `node:http` server on an ephemeral `127.0.0.1` port implementing `POST /api/runs` (records the body; 200 `{ok:true}` or 500) and `POST /api/sync` (200 `{landedRunIds}`). It mounts the provider with `baseUrl` pointing at the live server and a `credentialRef` resolved from an in-memory credentials stub, then proves a run lands (server saw it, index holds it), a 500 holds the next run in the spool as `unreachable`, and a healthy `sync()` drains the spool (server saw the batch, index updated). The server closes in `afterEach`.

Both files match the e2e include pattern `packages/*/*/tests/**/*.e2e.ts`, so they run in the real-API suite without a key.

## Alternatives considered

**Asserting the jspace reset from tool return values or `ctx.jspace.card()`.** Rejected: the task and the PR's intent are that the reset is a property of the durable session log, not of the tool's self-report; reading the last `jspace/card` event is the world, not the tool's claim.

**Reusing the unit spec's stubbed `fetch` for the tracker.** Rejected: PR #38 is specifically the real-fetch path; a stub cannot prove the wire behavior against a live server.

## Consequences

The two behaviors now have always-running proof in the e2e lane regardless of key presence. The tracker e2e depends on Node's global `fetch` (available on the supported Node range) and on ephemeral-port binding, so it is hermetic and parallel-safe. No product code changed; the notes are test-only.

## Testing

`pnpm run test:e2e` runs both files to completion and passes them; `pnpm vitest run packages/jspace packages/tracker` reports 20 files / 191 tests with no unit regressions.

## Related

- [J-Space W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) — the measurement instrument for the jspace seat; this note adds the keyless e2e proof for the goal-epoch reset it measures.
