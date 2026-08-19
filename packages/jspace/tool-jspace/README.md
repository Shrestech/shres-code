# @shres-code/shres-code-tool-jspace

Model-facing tools over [`ctx.jspace`](../jspace/README.md). The plugin registers them only while Settings `enabled` is true.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `jspace_open` | `goal`, `next`, optional `core[]` (≤2) | Opens a card, or replaces Goal, Next, and supplied Core on the open card. |
| `jspace_note` | optional `goal`, `core[]`, `open`, `next` | Replaces supplied fields. Core is the whole live list: current intermediate, then optional pinned constraint. |
| `jspace_checkpoint` | `check`, `by`, optional `evidence` | Appends Checked. With `requireCoverage`, `by` needs a coverage term and `evidence` is required. |
| `jspace_ship` | optional `path` | Requires a real Goal and an evidence-backed checkpoint for its Goal epoch, then closes the card. Does not write a file. |

`evidence` must name a successful non-J-Space tool call recorded after the current Goal opened. This proves that a call completed, not that its result semantically covers the claim, so the card says Checked rather than Verified. When `requireCoverage` is false, checkpoint evidence remains optional; ship still requires an evidence-backed Checked line.

While a card is open, a failed non-card call cannot repeat with identical arguments while Goal, Core, Open, and Next remain unchanged. A checkpoint-only write does not count as a diagnosis. The refusal resets when those working fields change or a new turn begins. Bare `/j-space on` opens a placeholder Goal; non-card tools and ship remain denied until Goal is replaced.

## Model Experience

### Tool schemas

#### What the model sees

The four schemas are visible while the seat is active; their generated definitions are in the [tool catalog](../../../docs/tool-catalog.md#shres-codeshres-code-tool-jspace). Core uses whole-list replacement. Checkpoint describes evidence as the successful call that performed the check. Ship states that success closes the card.

#### Token effect

Fixed schema cost on every active request. Zero while the seat is off.

#### KV Cache effect

Definitions are stable while active. Settings remount changes visibility. Calls and results append after the reusable prefix.

### Tool-call history and result

#### What the model sees

Success returns `Opened J-Space.`, `Updated J-Space.`, `Recorded checkpoint.`, or `Ship check passed.` Failures name the violated card rule. A successful ship appends `jspace/closed`, so the next request prints the availability state rather than the completed card.

#### Token effect

Tool results are compact. Call arguments remain until compaction; whole-list Core replacement is bounded to two lines.

#### KV Cache effect

Calls and results are append-only. Card mutations alter the earlier `jspace:card` prompt section on the following request.

## Known Limitations and Deferred Work

- **Evidence is structural, not semantic** — a completed command can still be unrelated to the claimed coverage.
- **Schemas remain visible on one-step work while enabled** — pass-scoped tool visibility is deferred.
- **Ship closes immediately** — a later continuation that needs the ledger must open a new card.
