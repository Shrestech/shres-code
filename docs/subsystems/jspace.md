# J-Space

J-Space is a settings-toggled, event-sourced working-memory card the prompt Consumer reprints into every model request while the seat is active. The card holds Goal, Core (at most two live items), Checked, Open, Next, and an optional Charter list of typed checks and prose, and ships default-off. The prompt Consumer reprints the last `checkedReprintLimit` Checked lines and last `openReprintLimit` Open questions (both default 5), frames the open card as untrusted session-authored working memory, and leaves the durable `jspace/card` snapshot whole. Protocol copy in [shres-jspace-prompt](../../packages/jspace/jspace-prompt/README.md) is a first-party rewrite of Tiger3807861189 J-Space Cognition Suite V3.6 (Apache-2.0, DOI 10.5281/zenodo.21971181); it is not their `SKILL.md` and does not implement a Jacobian lens. The [design note](../../.agents/notes/implemented/feature/2026-08-18-jspace-settings-toggle.md) owns the product decision; [card reprint bounds and framing](../../.agents/notes/implemented/feature/2026-08-25-jspace-card-reprint-bounds-and-framing.md) owns the reprint caps and untrusted frame; the [executor-enforced charter](../../.agents/notes/implemented/feature/2026-08-26-jspace-executor-enforced-charter.md) owns typed checks; package READMEs own model experience and [Known Limitations](../../packages/jspace/jspace/README.md#known-limitations-and-deferred-work).

Source: [`packages/jspace/jspace/src/index.ts`](../../packages/jspace/jspace/src/index.ts), [`packages/jspace/jspace/src/types.ts`](../../packages/jspace/jspace/src/types.ts)

## Packages

| Package | Role |
|---|---|
| [shres-jspace](../../packages/jspace/jspace/README.md) | Host seat (`ctx.jspace`), settings namespace, `jspace/card` and `jspace/closed` events, fold, copy-on-fork |
| [shres-jspace-prompt](../../packages/jspace/jspace-prompt/README.md) | `jspace:charter-seed` at order 44; `jspace:card` at 45; protocol and tool-driver at 46; capacity and broadcast at 47–48; extra modules from 49; pass gate `fast` / `full` / `loop` |
| [shres-tool-jspace](../../packages/jspace/tool-jspace/README.md) | `jspace_open`, `jspace_note`, `jspace_checkpoint`, `jspace_ship`, `jspace_charter_amend`; remounts from `status.active`; repeat-refusal while a card is open |
| [shres-command-jspace](../../packages/jspace/command-jspace/README.md) | Human `/j-space on\|off`; session-local card control |
| [shres-client-ui-jspace](../../packages/client/ui-jspace/README.md) | Composer chip and open-card dock; Trajectory badges; Settings section lives in [shres-client-ui-settings-jspace](../../packages/client/ui-settings-jspace/README.md) |

Both Consumers read one per-session predicate, `ctx.jspace.engaged(session)`: the prompt sections render and the five tool schemas reach the request only for an engaged session. [The seat README](../../packages/jspace/jspace/README.md#engagement) owns the rule and the `engageAfterSteps` threshold.

## Card fields

`jspace/card` carries a whole-card snapshot. `goalOpenedSeq` is the session event seq of the mutation that last set `goal`; `jspace_ship` requires a checkpoint recorded at or after that anchor for the current Goal epoch. When seat `requireVerifiedEvidence` is true, that checkpoint must be evidence-grade (`verified: true`).

```ts type-equiv
/** Whole-card snapshot carried by `jspace/card`. */
interface JspaceCard {
  /** Card sequence; the fold takes the highest native `seq`. */
  readonly seq: number
  /** Session that authored this snapshot. */
  readonly sessionId: string
  /** What done means. */
  readonly goal: string
  /** At most two live items. */
  readonly core: readonly string[]
  /** Append-only checked lines. */
  readonly checked: readonly JspaceCheckedLine[]
  /** Unsettled questions. */
  readonly open: readonly JspaceOpenLine[]
  /** Single next action. Never empty while the card is open. */
  readonly next: string
  /** Session event seq of the mutation that last set `goal`. */
  readonly goalOpenedSeq: number
  /**
   * Standing constraints this work must honor. Missing on older snapshots;
   * the fold defaults the field to `[]`.
   */
  readonly charter: readonly JspaceCharterEntry[]
}
```

```ts type-equiv
/** One append-only Checked line. `verified` is set only for evidence-grade lines. */
interface JspaceCheckedLine {
  /** Positive number, never reused on this card. */
  readonly n: number
  /** What was claimed checked. */
  readonly check: string
  /** Named verifier and coverage claim. */
  readonly by: string
  /** Optional session `callId` that exists in the log. */
  readonly evidence?: string
  /**
   * Present when `evidence` resolved to a completed non-error call of a
   * configured verifier tool. Reconstructable from this payload; writers omit
   * the field when the line is not evidence-grade.
   */
  readonly verified?: true
}
```

```ts type-equiv
/** Whether a check has been shown to fail a seeded violation. */
type CharterDiscrimination = 'demonstrated' | 'unverified'
```

```ts type-equiv
/**
 * Why a check is `unverified`. Omitted when `discrimination` is
 * `demonstrated`.
 */
type CharterUnverifiedReason =
  | 'discrimination-off'
  | 'policy-denied'
  | 'probe-timeout'
  | 'probe-infeasible'
```

```ts type-equiv
/** Content-only mutation applied to `failProbe.path` at registration. */
type CharterFailProbe =
  | { readonly kind: 'insert'; readonly content: string }
  | { readonly kind: 'prepend'; readonly content: string }
  | { readonly kind: 'replace'; readonly from: string; readonly to: string }
```

```ts type-equiv
/** Model- and seeder-authored check input (no runtime status). */
interface CharterCheckInput {
  readonly kind: 'check'
  readonly id?: CharterEntryId
  /** Constraint text this command enforces. Reprinted; the command is not a substitute. */
  readonly constraint: string
  /** Foreground bash command. Exit 0 passes; any other exit fails. */
  readonly command: string
  /**
   * Workspace-relative paths or globs the command is declared to read.
   * At least one. Every path must resolve inside session cwd.
   */
  readonly reads: readonly string[]
  /**
   * Content mutation applied to `failProbe.path` that must make `command` fail.
   * Required when tool `charterDiscrimination` is `'required'`.
   */
  readonly failProbe?: {
    readonly path: string
    readonly mutation: CharterFailProbe
  }
}
```

```ts type-equiv
/** Model- and seeder-authored prose input. */
interface CharterProseInput {
  readonly kind: 'prose'
  readonly id?: CharterEntryId
  readonly constraint: string
}
```

```ts type-equiv
/** Folded check: input plus discrimination status. */
interface JspaceCharterCheck extends CharterCheckInput {
  readonly kind: 'check'
  readonly id: CharterEntryId
  readonly discrimination: CharterDiscrimination
  /** Why `unverified`, when that marker is set. Omitted when demonstrated. */
  readonly unverifiedReason?: CharterUnverifiedReason
}
```

```ts type-equiv
/** Folded prose entry. */
interface JspaceCharterProse {
  readonly kind: 'prose'
  readonly id: CharterEntryId
  readonly constraint: string
}
```

```ts type-equiv
/** Folded card charter list. Commands stay on the snapshot so checkpoint/ship can re-run. */
type JspaceCharterEntry =
  | JspaceCharterCheck
  | JspaceCharterProse
```

Event declarations and fold semantics are in the [persistence log event catalog](../persistence-catalog.md#jspacecard--log-only).

## Lifecycle and epochs

`open` refuses while a native card is already open (`JSPACE_ALREADY_OPEN`). The `jspace_open` tool routes an open card to `openGoal`: a changed Goal — exact trimmed-string identity — resets Core and Checked, moves `goalOpenedSeq` to the current session seq, and carries Open and the charter forward; a same-Goal call updates Goal and Next in place and keeps Core, Checked, Open, charter, and the anchor. `note` patches Core (swap requires `departing` and incoming `core`), Open, and Next, and rejects a Goal identity change with `JSPACE_NOTE_GOAL_CHANGE`; Goal epochs open only through `openGoal`. `note` rejects a patch whose Goal, Next, Core, and Open match the current card (`JSPACE_NOTE_NOOP`). Line validation refuses a Core, Checked, or Open string whose trimmed text `JSON.parse`s to an array (`JSPACE_LINE_PACKED`). `checkpoint` appends a Checked line; when `requireCoverage` is true, `by` must match a configured coverage term, and optional `evidence` must name a completed, non-error `tool/call` in the session log. When that call's tool name is in `verifierTools`, or when `evidence` names a passed `jspace/charter-run`, the line carries `verified: true`. A non-empty charter always runs at checkpoint and at ship through nested `bash` (`ctx.tools.execute` with the parent token); `check` and `by` may be omitted then and the harness synthesizes them; the first failing check refuses and names the entry id plus `fix:`. `jspace_ship` is a register check only — non-empty Goal and Next plus a checkpoint at or after `goalOpenedSeq` — re-runs every charter check, and never closes the card. When `requireVerifiedEvidence` is true it also requires an evidence-grade checkpoint in the current Goal epoch. `close` appends a `jspace/closed` tombstone.

Constraint capture is opt-in on the tool Consumer. With `requireCoreOnOpen`, a `jspace_open` that would create the card is refused unless it carries a `core` item; a call that only replaces Goal and Next is not gated, because the seat applies `core` on the first open only. With `requireCoreForShip`, `jspace_ship` is refused while Core is empty, which is also the state a Goal change leaves behind. Both ship default-off; the [constraint-capture note](../../.agents/notes/implemented/feature/2026-08-26-jspace-constraint-capture.md) owns the evidence and [shres-tool-jspace](../../packages/jspace/tool-jspace/README.md) owns the refusal text.

Charter enablement is also opt-in on the tool Consumer (`requireCharter`, `requireExecutableCharter`, `charterSeed`, `charterDiscrimination`), all default-off. A first `jspace_open` may confirm a harness proposal (`kind: accept-proposal`) or send explicit check and prose entries; `jspace_charter_amend` replaces the list on an open card. Floor and discrimination run at registration; a missing `ctx.fs` while `charterDiscrimination` is `'required'` fails at the first probe. Code Mode is unsupported for charter. The [executor-enforced charter note](../../.agents/notes/implemented/feature/2026-08-26-jspace-executor-enforced-charter.md) owns the decision.

While a card is open, `tool-jspace` refuses an identical non-card tool retry within the same turn until a later `jspace/card` write records a diagnosis. The same `tools/pre-execute` hook counts `jspace_note` `tool/call` events since the last `turn/start` and refuses further notes once `maxNotesPerTurn` (default 8) is reached.

## Durable record and fold

Writers pass `{ ignorable: true }` on card and close events. The native fold is last-wins by monotonic `seq`; a regressing native `seq`, a foreign write after native origin, or a malformed payload keeps the last good snapshot and records `fault`. Inherited parent-seed events are candidates for copy-on-fork only. When the seat becomes active on a forked session with an inherited card and no native card yet, copy-on-fork writes `seq` 1 for the child and resets `goalOpenedSeq` to the child session seq.

## Relation to goals

The [goal subsystem](goal.md) and J-Space use separate session stores with no automatic sync. The dock reads both projections and omits its Goal line only when the live GoalBar objective equals the card Goal by exact string match ([ui-jspace](../../packages/client/ui-jspace/README.md)).
