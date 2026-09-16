# @shres-code/shres-code-research-protocol

Settings-toggled researcher-cycle protocol. Owns the `autoresearch` settings namespace and mounts two surfaces while enabled: the `research:protocol` system-prompt section (the hypothesis → design defense → experiment → evidence → verdict → ledger → digest cycle) and a `tools/pre-execute` design-defense gate that refuses the experiment tools until the current Goal epoch holds a completed non-error call from every configured debate seat.

## Composition

```yaml
- id: research-protocol
  name: '@shres-code/shres-code-research-protocol'
  config:
    enabled: false
```

Peer dependencies: `jspace` (optional epoch anchor via `ctx.get('jspace')`), `settings` (namespace wiring), `session`, `system-prompt`, `tools`, `invariants` (companion), `cordis`.

## Invariant companion

`./invariant` installs a global observer that re-walks the session log behind every design-defense denial and fails when a cited tool actually holds a completed non-error call at or after the epoch anchor, so the gate and the log walk cannot silently disagree.

## Model Experience

### research:protocol section

#### What the model sees

While enabled, the static cycle text: the researcher loop, the debate-before-run rule, the mechanical-verdict rule, the ledger citation rule, and the budget-scale-down rule. While disabled, nothing.

#### Token effect

Roughly 200 tokens per request while enabled; zero while disabled.

#### KV Cache effect

The text is static and prefix-stable for its whole lifetime; the enabled/disabled flip invalidates reuse from the section's order onward.

### Design-defense refusal

#### What the model sees

A gated call refused verbatim with the missing debate tools, for example `research protocol requires a design defense before logging a run: completed calls missing for: aegis, ward`.

#### Token effect

Only the refusal text, once per refused call.

#### KV Cache effect

The refusal is per-call tool output and invalidates nothing.

## Known Limitations and Deferred Work

- The gate proves a debate happened, not that its challenges were resolved; the probe-downgrade rule is prompt text, not enforcement.
- Seat matching is by tool name: any completed non-error call named `aegis` or `ward` satisfies the gate, whatever produced it. On compositions that remount those seats as Team-steer tools, a completed call is mailbox accept, not the teammate finishing its turn.
- A gated call carrying no owning session passes the gate; the gated tools themselves then reject the sessionless caller.
- `renderDigest` is exported for the digest-delivery stage; no harness surface consumes it yet.
- Seat-model diversity (a reviewer sharing the executor's model) is a composition concern and is not checked here.
