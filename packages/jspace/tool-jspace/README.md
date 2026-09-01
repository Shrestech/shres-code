# @shres-code/shres-code-tool-jspace

Model-facing tools over [`ctx.jspace`](../jspace/README.md). The plugin remounts from `watch()`: the five tools appear in `ctx.tools.schemas()` only while `status.active` is true.

Registration is seat-wide, so the per-session [engagement](../jspace/README.md#engagement) decision lands on the request instead. A `system-prompt/assemble` listener drops the five schemas from `assembly.tools` for a session the seat has not engaged, and the `tools/pre-execute` hook denies a call that arrives anyway with a refusal naming the threshold. The registrations themselves stay mounted so an engaged session in the same process still executes them.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `jspace_open` | `goal`, `next`, optional `core[]` (≤2), optional `charter[]` | Opens a card, or updates an already-open card. A changed Goal starts a new epoch: Core and Checked are cleared and ship needs a fresh checkpoint; charter and open questions carry over. A same-Goal call updates Goal and Next in place. Core applies only on the first open. First charter registration is the first `jspace_open` that carries `charter` while the card charter is empty, including after loop auto-open. A later `jspace_open` that carries `charter` onto a non-empty charter is refused; use `jspace_charter_amend`. When `requireCoreOnOpen` is true, a first open carrying no `core` line is refused. When `requireCharter` is true, first charter registration whose resolved charter is empty is refused. |
| `jspace_note` | optional `goal`, `departing`, `core`, `open`, `next` | Patches the open card. Goal identity changes are rejected (`JSPACE_NOTE_GOAL_CHANGE`); use `jspace_open` for a new Goal epoch. A no-op that leaves Goal, Next, Core, and Open unchanged is rejected (`JSPACE_NOTE_NOOP`). A Core, Checked, or Open line that `JSON.parse`s to an array is rejected (`JSPACE_LINE_PACKED`). A Core swap without `departing` fails. Charter changes use `jspace_charter_amend`. |
| `jspace_checkpoint` | optional `check`, `by`, optional `evidence` | Appends a Checked line. When the charter is non-empty, every `kind: 'check'` runs first through nested `bash`; a failure refuses and names the entry. `check` and `by` are optional then (the harness synthesizes them). Otherwise `by` must name a verifier and coverage. `evidence` must be a completed, non-error tool-call id; citing a configured verifier tool, or a passed `jspace/charter-run`, marks the line evidence-grade. |
| `jspace_ship` | optional `path` | Register check plus charter re-run. Rejects if Goal or Next is empty, or if no checkpoint exists for the current Goal. When `requireCoreForShip` is true, also rejects an empty Core; when `requireCharter` is true, also rejects an empty charter; when seat `requireVerifiedEvidence` is true, also requires an evidence-grade checkpoint in the current Goal epoch. Does not write a file and does not close the card. A passing ship appends `jspace/shipped` so the Goal epoch is settled and the prompt stops re-tending it. |
| `jspace_charter_amend` | optional `drop[]`, `add[]`, `replace[]` | Replaces charter entries on the open card. Floor and discrimination run on added and replaced checks. There is no skip-checks argument. |

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
    requireCoreOnOpen: false
    requireCoreForShip: false
    requireCharter: false
    requireExecutableCharter: false
    charterSeed: false
    charterDiscrimination: 'off'
    charterCheckTimeoutMs: 30000
    maxCharterEntries: 12
    charterChecksMustBeReadOnly: true
```

| Field | Default | Meaning |
|---|---|---|
| `maxNotesPerTurn` | `8` | Maximum `jspace_note` calls accepted in one user turn while a card is open. Zero and negative fail at load. Raising it is a deployment choice. |
| `requireCoreOnOpen` | `false` | Refuse a `jspace_open` that would create the card unless it carries at least one `core` item. A call that only replaces Goal and Next is not gated, because the seat applies `core` on the first open only. |
| `requireCoreForShip` | `false` | Refuse `jspace_ship` while the card's Core is empty, including after a Goal change cleared it. |
| `requireCharter` | `false` | Refuse first charter registration whose resolved charter is empty, and refuse checkpoint/ship on an empty charter. Incompatible with seat `mode: always-open`. |
| `requireExecutableCharter` | `false` | Require at least one `kind: 'check'`. Implies `requireCharter`; load throws otherwise. |
| `charterSeed` | `false` | Extract a `jspace/charter-proposal` from the first human user message during prompt assembly (claimed messages), so the first request reprints `jspace:charter-seed`. A prepended `agent/pre-step` listener is the backup when assemble did not run. |
| `charterDiscrimination` | `'off'` | `'off'` marks checks unverified; `'best-effort'` probes when a `failProbe` is present; `'required'` refuses registration unless the probe makes the command fail. `'required'` implies `requireExecutableCharter`. |
| `charterCheckTimeoutMs` | `30000` | Nested bash `timeoutMs` per check. Must be a positive safe integer. |
| `maxCharterEntries` | `12` | Cap on seeded proposal entries and on the registered charter list at open and amend. Safe integer 1–32. |
| `charterChecksMustBeReadOnly` | `true` | Refuse write-token charter commands at the floor. |

`requireCoreOnOpen` / `requireCoreForShip` are constraint-capture pressure: they force the card to carry the constraints a task states once, which is what survives compaction. The [constraint-capture note](../../../.agents/notes/implemented/feature/2026-08-26-jspace-constraint-capture.md) owns that measurement. Charter fields are the executor-enforced contract; the [charter note](../../../.agents/notes/implemented/feature/2026-08-26-jspace-executor-enforced-charter.md) owns them. A non-empty charter always runs at checkpoint and ship regardless of `requireCharter`.

## Model Experience

### Model-visible tools

#### What the model sees

The five tools `jspace_open`, `jspace_note`, `jspace_checkpoint`, `jspace_ship`, and `jspace_charter_amend` on every request of an engaged session. Off remount removes them from the catalog; an unengaged session never receives them in its request. `jspace_open` names `charter` as the standing checks the harness re-runs at every checkpoint and at ship, and `core` as the two-item working-memory stage. `jspace_checkpoint` names `by` as the verifier and coverage claim and recommends citing `evidence` — a completed non-error tool-call id from this session — over describing the check in prose, with a configured verifier tool or a passed charter run making the line evidence-grade. Citing `evidence` does not prove coverage.

#### Token effect

Fixed schema cost on every request of an engaged session. Zero when the seat is off and zero before the session reaches `engageAfterSteps`.

#### KV Cache effect

Prefix-stable while the definitions stay visible. Settings off, a remount that drops the tools, or the session crossing `engageAfterSteps` changes the catalog and invalidates reuse from it.

### Tool-call history and result

#### What the model sees

Each call retains its arguments. Success returns exactly `Opened J-Space.`, `Updated J-Space.`, `Recorded checkpoint.`, `Ship check passed.`, or `Amended charter.` A second `jspace_open` while a card is open updates Goal and Next and returns `Updated J-Space.`; a Goal identity change resets Core and Checked so `jspace_ship` requires a fresh checkpoint for the new Goal, while a same-Goal call updates Goal and Next in place. If that call carries `charter` and the card charter is still empty — including after loop auto-open — the harness registers it (floor and discrimination) as first charter registration. If the charter is already non-empty, the call is refused with `a charter is already registered on this card; call jspace_charter_amend to drop, replace, or add entries. jspace_open does not replace a non-empty charter.` `jspace_note` rejects a Goal identity change with `note cannot change the Goal; call jspace_open to open a new Goal epoch (resets Core and Checked).` A no-op note fails with `the card already says this; proceed with the work or write a checkpoint`. A JSON-array packed into one line fails with `jspace line must be one item per slot; Core holds at most 2 live items`. Stable seat failures keep the seat message, including `jspace core swap requires departing and incoming lines`, the coverage refusal that opens with `jspace checkpoint requires a verifier and coverage claim` and continues with what a passing `by` states, `jspace evidence "<id>" is not a completed, non-error tool call in this session`, `jspace ship requires a checkpoint for the current Goal`, and `jspace ship requires an evidence-grade checkpoint that cites a completed non-error verifier tool call` when `requireVerifiedEvidence` is true. When `requireCoreOnOpen` is true, a first `jspace_open` with no `core` line fails with `jspace_open requires at least one core item. Core carries the once-stated constraints, standing rules, and invariants this work must honor through context compaction, and it is the only card field reprinted whole. Re-read the task statement for them and pack related rules into one line; Core holds at most two.` When `requireCoreForShip` is true, a ship on an empty Core fails with `jspace ship on a card whose Core is empty certifies nothing: the card carries no constraint the work was held to. Write the once-stated constraints and standing rules this work honored onto Core with jspace_note, or, when the task states none, the acceptance criterion it is measured against.` A non-empty charter that fails at checkpoint or ship names the entry id and a `fix:` line. While a card is open, an identical non-card tool call is refused until a later `jspace/card` write records a diagnosis; the refusal is bounded by the turn, so a new user turn may re-issue a command. A ninth `jspace_note` in the same turn (default `maxNotesPerTurn` 8) is refused with `jspace_note is limited to 8 calls this turn; write a checkpoint or do the work instead.` A card tool called before the session engages is refused with `J-Space engages after <n> completed steps in this session; do the work directly until then.` A non-agent caller fails with `jspace_<name> requires an owning agent session`. Card snapshots stay in the session log; they are not a second model message.

#### Token effect

Small fixed-shape results. Call arguments remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Coverage is a term match** — `by` is checked against configured coverage terms; keyword coverage stays the floor for ordinary checkpoints.
- **Evidence-grade is a verifier citation** — `verified: true` is recorded only when `evidence` names a completed non-error call whose tool is in seat `verifierTools`, or a passed `jspace/charter-run`. A workspace fingerprint is recorded on charter runs but never gates and never skips a re-run; the [evidence-grade note](../../../.agents/notes/implemented/feature/2026-08-25-jspace-evidence-grade-checkpoints.md) defers the git-hash class.
- **Constraint capture is a presence check** — `requireCoreOnOpen` and `requireCoreForShip` require a Core line, not the right one; nothing compares Core against the task statement, so a placeholder satisfies both.
- **Code Mode is unsupported for charter** — nested `bash` with a parent token is allowed under native tool dispatch; model-direct `jspace_checkpoint` from `run_code` is not a proven binding path. Charter compositions stay native-tool.
- **pwsh charter runner is deferred** — floor tautology lists and comment-stripping are bash-shaped; checks dispatch the `bash` tool.
- **No ACP snapshot scenario** — assembled-application fixtures under `examples/acp-agent` do not pin the evidence-grade description, the constraint-capture refusals, or the charter seed and refusals. The keyless `jspace-charter` / `jspace-charter-pass` / `jspace-charter-loop` headless scenarios pin the charter transcript, including first registration after loop auto-open.
- **failProbe confinement follows realpath** — a workspace symlink whose resolved target sits outside session cwd is refused by name; the probe does not write it.
- **Ship is not a file writer** — `jspace_ship` only checks the card and stamps the Goal settled; file delivery stays on existing fs tools. The card stays open.
- **Goal identity is exact trimmed-string comparison** — a paraphrased Goal starts a new epoch and wipes Core and Checked, while a genuinely new goal phrased identically inherits the old epoch's evidence; net task-outcome effect is unmeasured (W0 pending).
- **Approval UX is unchanged** — each nested charter bash inherits the parent call's policy; there is no session-wide "allow charter checks" preset.
