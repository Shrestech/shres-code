# J-Space

J-Space is a settings-toggled, event-sourced working-memory card the prompt Consumer reprints into every model request while the seat is active. The card holds five lines — Goal, Core (at most two live items), Checked, Open, and Next — and ships default-off. Protocol copy in [shres-jspace-prompt](../../packages/jspace/jspace-prompt/README.md) is a first-party rewrite of Tiger3807861189 J-Space Cognition Suite V3.6 (Apache-2.0, DOI 10.5281/zenodo.21971181); it is not their `SKILL.md` and does not implement a Jacobian lens. The [design note](../../.agents/notes/implemented/feature/2026-08-18-jspace-settings-toggle.md) owns the product decision; package READMEs own model experience and [Known Limitations](../../packages/jspace/jspace/README.md#known-limitations-and-deferred-work).

Source: [`packages/jspace/jspace/src/index.ts`](../../packages/jspace/jspace/src/index.ts), [`packages/jspace/jspace/src/types.ts`](../../packages/jspace/jspace/src/types.ts)

## Packages

| Package | Role |
|---|---|
| [shres-jspace](../../packages/jspace/jspace/README.md) | Host seat (`ctx.jspace`), settings namespace, `jspace/card` and `jspace/closed` events, fold, copy-on-fork |
| [shres-jspace-prompt](../../packages/jspace/jspace-prompt/README.md) | `jspace:card` at order 45; protocol and tool-driver at 46; capacity and broadcast at 47–48; extra modules from 49; pass gate `fast` / `full` / `loop` |
| [shres-tool-jspace](../../packages/jspace/tool-jspace/README.md) | `jspace_open`, `jspace_note`, `jspace_checkpoint`, `jspace_ship`; remounts from `status.active`; repeat-refusal while a card is open |
| [shres-command-jspace](../../packages/jspace/command-jspace/README.md) | Human `/j-space on\|off`; session-local card control |
| [shres-client-ui-jspace](../../packages/client/ui-jspace/README.md) | Composer chip and open-card dock; Trajectory badges; Settings section lives in [shres-client-ui-settings-jspace](../../packages/client/ui-settings-jspace/README.md) |

## Card fields

`jspace/card` carries a whole-card snapshot. `goalOpenedSeq` is the session event seq of the mutation that last set `goal`; `jspace_ship` requires a checkpoint recorded at or after that anchor for the current Goal epoch.

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
}
```

Event declarations and fold semantics are in the [persistence log event catalog](../persistence-catalog.md#jspacecard--log-only).

## Lifecycle and epochs

`open` refuses while a native card is already open (`JSPACE_ALREADY_OPEN`). The `jspace_open` tool routes an open card to `openGoal`: a changed Goal — exact trimmed-string identity — resets Core and Checked, moves `goalOpenedSeq` to the current session seq, and carries Open forward; a same-Goal call updates Goal and Next in place and keeps Core, Checked, Open, and the anchor. `note` patches Core (swap requires `departing` and incoming `core`), Open, and Next, and rejects a Goal identity change with `JSPACE_NOTE_GOAL_CHANGE`; Goal epochs open only through `openGoal`. `checkpoint` appends a Checked line; when `requireCoverage` is true, `by` must match a configured coverage term, and optional `evidence` must name a completed, non-error `tool/call` in the session log. `jspace_ship` is a register check only — non-empty Goal and Next plus a checkpoint at or after `goalOpenedSeq` — and never closes the card. `close` appends a `jspace/closed` tombstone.

While a card is open, `tool-jspace` refuses an identical non-card tool retry within the same turn until a later `jspace/card` write records a diagnosis.

## Durable record and fold

Writers pass `{ ignorable: true }` on card and close events. The native fold is last-wins by monotonic `seq`; a regressing native `seq`, a foreign write after native origin, or a malformed payload keeps the last good snapshot and records `fault`. Inherited parent-seed events are candidates for copy-on-fork only. When the seat becomes active on a forked session with an inherited card and no native card yet, copy-on-fork writes `seq` 1 for the child and resets `goalOpenedSeq` to the child session seq.

## Relation to goals

The [goal subsystem](goal.md) and J-Space use separate session stores with no automatic sync. The dock reads both projections and omits its Goal line only when the live GoalBar objective equals the card Goal by exact string match ([ui-jspace](../../packages/client/ui-jspace/README.md)).
