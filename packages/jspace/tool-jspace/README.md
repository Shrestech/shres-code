# @shres-code/shres-code-tool-jspace

Model-facing tools over [`ctx.jspace`](../jspace/README.md). The plugin remounts from `watch()`: the four tools appear in `ctx.tools.schemas()` only while `status.active` is true.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `jspace_open` | `goal`, `next`, optional `core[]` (≤2) | Opens a card, or replaces Goal and Next when a card is already open. Core applies only on the first open. |
| `jspace_note` | optional `goal`, `departing`, `core`, `open`, `next` | Patches the open card. A Core swap without `departing` fails. |
| `jspace_checkpoint` | `check`, `by`, optional `evidence` | Appends a Checked line. `by` must name a verifier and coverage. `evidence` must be a completed, non-error tool-call id. |
| `jspace_ship` | optional `path` | Register check only. Rejects if Goal or Next is empty, or if no checkpoint exists for the current Goal. Does not write a file and does not close the card. |

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
```

## Model Experience

### Model-visible tools

#### What the model sees

The four tools `jspace_open`, `jspace_note`, `jspace_checkpoint`, and `jspace_ship` while the seat is active. Off remount removes them from the catalog. `jspace_checkpoint` says `by` must name a verifier and coverage, and that `evidence` is a call id that must exist and does not prove coverage.

#### Token effect

Fixed schema cost on every request where the tools are visible. Zero when the seat is off.

#### KV Cache effect

Prefix-stable while the definitions stay visible. Settings off or a remount that drops the tools invalidates reuse from this catalog.

### Tool-call history and result

#### What the model sees

Each call retains its arguments. Success returns exactly `Opened J-Space.`, `Updated J-Space.`, `Recorded checkpoint.`, or `Ship check passed.` A second `jspace_open` while a card is open updates Goal and Next and returns `Updated J-Space.` Stable seat failures keep the seat message, including `jspace core swap requires departing and incoming lines`, the coverage refusal that opens with `jspace checkpoint requires a verifier and coverage claim` and continues with what a passing `by` states, `jspace evidence "<id>" is not a completed, non-error tool call in this session`, and `jspace ship requires a checkpoint for the current Goal`. While a card is open, an identical non-card tool call is refused until a later `jspace/card` write records a diagnosis; the refusal is bounded by the turn, so a new user turn may re-issue a command. A non-agent caller fails with `jspace_<name> requires an owning agent session`. Card snapshots stay in the session log; they are not a second model message.

#### Token effect

Small fixed-shape results. Call arguments remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Coverage is a term match** — `by` is checked against configured coverage terms; the tool cannot tell whether the verifier ran.
- **Evidence does not prove coverage** — a named `tool/call` id must exist in the session log and still does not prove that run covered the claim.
- **Ship is not a file writer** — `jspace_ship` only checks the card; file delivery stays on existing fs tools.
