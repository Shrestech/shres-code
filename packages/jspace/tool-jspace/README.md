# @shres-code/shres-code-tool-jspace

Model-facing tools over [`ctx.jspace`](../jspace/README.md). The plugin remounts from `watch()`: the four tools appear in `ctx.tools.schemas()` only while `status.active` is true.

Registration is seat-wide, so the per-session [engagement](../jspace/README.md#engagement) decision lands on the request instead. A `system-prompt/assemble` listener drops the four schemas from `assembly.tools` for a session the seat has not engaged, and the `tools/pre-execute` hook denies a call that arrives anyway with a refusal naming the threshold. The registrations themselves stay mounted so an engaged session in the same process still executes them.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `jspace_open` | `goal`, `next`, optional `core[]` (≤2) | Opens a card, or updates an already-open card. A changed Goal starts a new epoch: Core and Checked are cleared and ship needs a fresh checkpoint; open questions carry over. A different Goal resets Core and Checked and returns `Updated J-Space.` A same-Goal call updates Goal and Next in place. Core applies only on the first open. |
| `jspace_note` | optional `goal`, `departing`, `core`, `open`, `next` | Patches the open card. Goal identity changes are rejected (`JSPACE_NOTE_GOAL_CHANGE`); use `jspace_open` for a new Goal epoch. A no-op that leaves Goal, Next, Core, and Open unchanged is rejected (`JSPACE_NOTE_NOOP`). A Core, Checked, or Open line that `JSON.parse`s to an array is rejected (`JSPACE_LINE_PACKED`). A Core swap without `departing` fails. |
| `jspace_checkpoint` | `check`, `by`, optional `evidence` | Appends a Checked line. `by` must name a verifier and coverage. `evidence` must be a completed, non-error tool-call id; citing a configured verifier tool marks the line evidence-grade. |
| `jspace_ship` | optional `path` | Register check only. Rejects if Goal or Next is empty, or if no checkpoint exists for the current Goal. When seat `requireVerifiedEvidence` is true, also requires an evidence-grade checkpoint in the current Goal epoch. Does not write a file and does not close the card. |

A non-agent caller is rejected. Seat refusals (`JspaceError`) become a plain `Error` with the same message.

Native results are compact acknowledgements. The dock and Trajectory read session events, not the tool result body.

## Composition

```yaml
- id: jspace
  name: '@shres-code/shres-code-jspace'
  config:
    enabled: true
- id: tool-jspace
  name: '@shres-code/shres-code-tool-jspace'
  config:
    maxNotesPerTurn: 8
```

| Field | Default | Meaning |
|---|---|---|
| `maxNotesPerTurn` | `8` | Maximum `jspace_note` calls accepted in one user turn while a card is open. Zero and negative fail at load. Raising it is a deployment choice. |

## Model Experience

### Model-visible tools

#### What the model sees

The four tools `jspace_open`, `jspace_note`, `jspace_checkpoint`, and `jspace_ship` on every request of an engaged session. Off remount removes them from the catalog; an unengaged session never receives them in its request. `jspace_checkpoint` names `by` as the verifier and coverage claim and recommends citing `evidence` — a completed non-error tool-call id from this session — over describing the check in prose, with a configured verifier tool making the line evidence-grade. Citing `evidence` does not prove coverage.

#### Token effect

Fixed schema cost on every request of an engaged session. Zero when the seat is off and zero before the session reaches `engageAfterTurns`.

#### KV Cache effect

Prefix-stable while the definitions stay visible. Settings off, a remount that drops the tools, or the session crossing `engageAfterTurns` changes the catalog and invalidates reuse from it.

### Tool-call history and result

#### What the model sees

Each call retains its arguments. Success returns exactly `Opened J-Space.`, `Updated J-Space.`, `Recorded checkpoint.`, or `Ship check passed.` A second `jspace_open` while a card is open updates Goal and Next and returns `Updated J-Space.`; a Goal identity change resets Core and Checked so `jspace_ship` requires a fresh checkpoint for the new Goal, while a same-Goal call updates Goal and Next in place. `jspace_note` rejects a Goal identity change with `note cannot change the Goal; call jspace_open to open a new Goal epoch (resets Core and Checked).` A no-op note fails with `the card already says this; proceed with the work or write a checkpoint`. A JSON-array packed into one line fails with `jspace line must be one item per slot; Core holds at most 2 live items`. Stable seat failures keep the seat message, including `jspace core swap requires departing and incoming lines`, the coverage refusal that opens with `jspace checkpoint requires a verifier and coverage claim` and continues with what a passing `by` states, `jspace evidence "<id>" is not a completed, non-error tool call in this session`, `jspace ship requires a checkpoint for the current Goal`, and `jspace ship requires an evidence-grade checkpoint that cites a completed non-error verifier tool call` when `requireVerifiedEvidence` is true. While a card is open, an identical non-card tool call is refused until a later `jspace/card` write records a diagnosis; the refusal is bounded by the turn, so a new user turn may re-issue a command. A ninth `jspace_note` in the same turn (default `maxNotesPerTurn` 8) is refused with `jspace_note is limited to 8 calls this turn; write a checkpoint or do the work instead.` A card tool called before the session engages is refused with `J-Space engages after <n> completed turns in this session; do the work directly until then.` A non-agent caller fails with `jspace_<name> requires an owning agent session`. Card snapshots stay in the session log; they are not a second model message.

#### Token effect

Small fixed-shape results. Call arguments remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Coverage is a term match** — `by` is checked against configured coverage terms; keyword coverage stays the floor for ordinary checkpoints.
- **Evidence-grade is a verifier citation** — `verified: true` is recorded only when `evidence` names a completed non-error call whose tool is in seat `verifierTools`. A workspace fingerprint is not recorded; the [evidence-grade note](../../../.agents/notes/implemented/feature/2026-08-25-jspace-evidence-grade-checkpoints.md) defers it.
- **No ACP snapshot scenario** — assembled-application fixtures under `examples/acp-agent` do not yet pin the evidence-grade description or ship refusal.
- **Ship is not a file writer** — `jspace_ship` only checks the card; file delivery stays on existing fs tools.
- **Goal identity is exact trimmed-string comparison** — a paraphrased Goal starts a new epoch and wipes Core and Checked, while a genuinely new goal phrased identically inherits the old epoch's evidence; net task-outcome effect is unmeasured (W0 pending).
