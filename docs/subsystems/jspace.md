# J-Space

J-Space is a default-off, model-visible external ledger stored in the session log. It is not Anthropic's activation J-space and does not provide a Jacobian lens. The [operational-ledger decision](../../.agents/notes/implemented/feature/2026-08-19-jspace-operational-ledger.md) owns the rationale and the distinction.

Source: [`packages/jspace/jspace/src/index.ts`](../../packages/jspace/jspace/src/index.ts), [`packages/jspace/jspace/src/types.ts`](../../packages/jspace/jspace/src/types.ts), and [`packages/jspace/jspace/src/fold.ts`](../../packages/jspace/jspace/src/fold.ts).

## Durable card

`jspace/card` is an ignorable whole-card snapshot. It records Goal, at most two Core lines, append-only Checked entries, Open questions, Next, a card-local sequence, the writing session id, and the session-event sequence at which the current Goal opened. `jspace/closed` is the ignorable tombstone. The fold accepts native events in increasing card sequence, keeps the last good native snapshot on malformed or regressing input, and treats an inherited parent snapshot as copy-on-fork input rather than the child's live card.

Core contains the current intermediate followed by an optional pinned constraint. A note replaces the complete Core list. Checked entries may cite a successful non-J-Space tool call; that evidence establishes that the call completed, not that it semantically covered the claim.

Forked sessions receive a native copy with their own session id. Cards are never shared mutable state between sessions.

## Consumers

[`jspace-prompt`](../../packages/jspace/jspace-prompt/README.md) reconstructs the card on every prompt assembly, so compaction cannot remove it. [`tool-jspace`](../../packages/jspace/tool-jspace/README.md) owns open, note, checkpoint, and ship operations plus the failed-repeat refusal. [`command-jspace`](../../packages/jspace/command-jspace/README.md) provides session-local human open and close.

The feature defaults disabled. While enabled, a text/config classifier chooses `fast`, `full`, or `loop`; loop and always-open policy may create a card during assembly. The rendered request remains reconstructable through the ordinary `request/header` event.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjspace--jspaceservice"></a>

### `ctx.jspace` — `JspaceService`

J-Space seat (`ctx.jspace`).

```ts cordis-catalog
/**
 * Subscribe to remount status.
 * @param listener - called with the new status.
 * @returns disposer.
 */
watch(listener: (status: JspaceStatus) => void): () => void

/**
 * Fold one session's J-Space events.
 * @param session - session whose log to fold.
 * @returns native projection plus inherited parent card.
 */
fold(session: Session): JspaceFold

/**
 * Current native open card, or `null`.
 * @param session - owning session.
 * @returns the card.
 */
card(session: Session): JspaceCard | null

/**
 * Settings-console snapshot for one session.
 * @param session - session whose log to fold.
 * @returns open/closed and checkpoint counts. Does not throw when inactive.
 */
snapshot(session: Session): JspaceSnapshot

/**
 * Open a card.
 * @param session - owning session.
 * @param input - goal, next, optional core.
 * @returns the recorded card.
 */
open(session: Session, input: OpenJspaceInput): JspaceCard

/**
 * Patch an open card.
 * @param session - owning session.
 * @param input - fields to replace.
 * @returns the recorded card.
 */
note(session: Session, input: NoteJspaceInput): JspaceCard

/**
 * Append a Checked line.
 * @param session - owning session.
 * @param input - check, by, optional evidence.
 * @returns the recorded card.
 */
checkpoint(session: Session, input: CheckpointJspaceInput): JspaceCard

/**
 * Close the card.
 * @param session - owning session.
 */
close(session: Session): void
```

Types: [Session](session.md)

Source: [`packages/jspace/jspace/src/index.ts:171`](../../packages/jspace/jspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
