# @shres-code/shres-code-jspace-prompt

Consumer that reprints the logged J-Space card as `jspace:card` and adds one operational `jspace:protocol` section. The card is derived from the session fold on every assembly, so compaction and resume do not drop it.

When the seat is inactive both sections are empty. When active with no open card, `jspace:card` is the availability line and `jspace:protocol` tells the model to open a card only when an intermediate or constraint must survive another tool, file, or compaction. An open card receives four operational rules: Core holds the current intermediate and at most one pinned constraint; update Core or Next before dependent work; cite the successful check call in `jspace_checkpoint`; a successful `jspace_ship` closes the card.

The gate still classifies `fast` / `full` / `loop` from the latest human message, whether a card is open, and Settings `mode`. `loop` auto-opens a card unless the session already has a native close. Automatic opens seed Goal from the first non-empty line of the triggering human text, cut within 200 characters; blank text uses `J-Space is on`. Next starts as `State the first action`.

The card is an external session ledger, not Anthropic's activation J-space or a Jacobian lens. Protocol copy names only card operations and harness enforcement.

## Model Experience

### Card and operational protocol

#### What the model sees

The model sees the folded five-line card when one is open, or the stable availability line and open driver otherwise.

##### Closed card

```markdown
J-Space is available. Open a card for multi-stage or multi-file work.

For work whose intermediate or constraint must survive another tool, file, or compaction, call jspace_open with Goal, Next, and up to two Core items. Skip the card for one-step work.
```

##### Open card

```markdown
Goal:      Ship the parser change
Core:      The parser rejects empty records; Preserve the wire format
Checked:   (none)
Open:      (none)
Next:      Run the parser tests

The J-Space card is durable external state. Keep Core to the current intermediate and at most one pinned constraint.
Before a later operation depends on changed state, update Core or Next with jspace_note.
After a check completes, call jspace_checkpoint with what it checked and the successful tool-call id as evidence.
A repeated failed tool call is refused until Core or Next changes. Call jspace_ship after the current Goal has an evidence-backed checkpoint; a successful ship closes the card.
```

#### Token effect

Zero while the seat is off. Active fast requests pay the availability line and short open driver. An open card pays the five card lines and four operational lines; the removed module blocks add no tokens.

#### KV Cache effect

The availability copy is stable until the card opens. A pass change can extend the closed-card driver by one line. Every card mutation changes `jspace:card` at order 45; successful ship closes it and returns later requests to the stable closed-card copy.

## Known Limitations and Deferred Work

- **The gate is a term-and-length heuristic** — it does not know whether an arbitrary task needs external state.
- **Automatic Next is generic** — the model must replace `State the first action` when the first concrete operation differs.
- **No cross-session carry** — forks copy cards, but independent headless chain phases start with separate sessions.
