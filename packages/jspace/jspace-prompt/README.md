# @shres-code/shres-code-jspace-prompt

Consumer that reprints the J-Space card as the `jspace:card` system-prompt section and mounts the protocol the current pass earns. The card text is derived from the session fold on every assembly, so compaction and resume do not drop it.

When the seat is inactive every J-Space section is empty. When the seat is active and no card is open, `jspace:card` is the availability line. The gate classifies `fast` / `full` / `loop` from the last human message, whether a card is open, and Settings `mode`. `fast` loads no protocol. `full` loads the protocol block plus capacity. `loop` also loads broadcast and opens a card when none exists. `mode: always-open` is always `loop`.

Protocol copy is a first-party rewrite of Tiger3807861189 J-Space Cognition Suite V3.6 (Apache-2.0, DOI 10.5281/zenodo.21971181). It is not their `SKILL.md` and does not implement a Jacobian lens.

## Model Experience

### J-Space card section

#### What the model sees

The five-line card from the fold, or the availability line while enabled and no card is open.

##### Availability line

```markdown
J-Space is available. Open a card for multi-stage or multi-file work.
```

#### Token effect

Zero when the seat is off. One stable line when on and no card is open. The five-line card when a card is open.

#### KV Cache effect

The availability line is prefix-stable until a card opens or Settings flips. Updating the card replaces the section and invalidates the prefix from this order onward.

### J-Space protocol sections

#### What the model sees

`jspace:protocol` plus `jspace:module:capacity` and `jspace:module:broadcast` when the pass earns them. `fast` leaves those three sections empty.

#### Token effect

Zero on `fast`. A short fixed protocol block plus one or two short modules on `full` / `loop`. Unused modules stay empty.

#### KV Cache effect

A pass change replaces the protocol sections and invalidates the prefix from `jspace:protocol` onward.

## Known Limitations and Deferred Work

- **Always-open uses a stock Goal/Next** — `J-Space is on` / `State the first action` (`JSPACE_ALWAYS_OPEN_*` from the seat). The model must rewrite those lines through `note`. Bare `/j-space on` uses the same constants.
- **The gate is a term-and-length heuristic** — it does not ask the model to classify the pass.
- **At most two extra modules plus untrusted introspection** — the nine-module suite is not concatenated. Markers as a harness retry check is still deferred.
