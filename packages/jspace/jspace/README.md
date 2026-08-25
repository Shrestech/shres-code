# @shres-code/shres-code-jspace

Default-off host seat for the J-Space card. This package remounts from the `jspace` settings namespace, publishes `ctx.jspace`, and writes `jspace/card` / `jspace/closed` session events. Prompt and tool consumers are separate packages that watch `status.active`.

## Plugin (namespace: `jspace`)

```yaml
- id: jspace
  name: '@shres-code/shres-code-jspace'
  config:
    enabled: false
    mode: available
    requireCoverage: true
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master allow. False keeps the seat loaded and `status.active === false`. Mutations throw `JSPACE_DISABLED` and write nothing. |
| `mode` | `available` | `available` waits for `open()`. `always-open` is reserved for the prompt Consumer. |
| `requireCoverage` | `true` | `checkpoint()` refuses a `by` string that matches no coverage term. |
| `coverageTerms` | `[]` | Extra literal terms merged with the built-in English list. |

`installSettingsSection` owns the namespace. Unknown keys fail at load. The seat remounts when the document changes.

## Service

`ctx.jspace` accepts a live `Session`. `open`, `openGoal`, `note`, `checkpoint`, and `close` append `{ ignorable: true }` events. `card(session)` and `fold(session)` replay the log. A fork with an inherited parent card receives a native copy (`seq` 1, child `sessionId`) while the seat is active.

`open` refuses while a card is open (`JSPACE_ALREADY_OPEN`). `openGoal` opens a new Goal epoch on an open card: a Goal identity change resets Core and Checked and moves the `goalOpenedSeq` anchor so ship requires a checkpoint under the new Goal; a same-Goal call updates Goal and Next in place and keeps Core, Checked, and Open. `note` rejects a Goal identity change (`JSPACE_NOTE_GOAL_CHANGE`); Goal epochs open only through `openGoal`. Open questions carry over unchanged across an epoch change.

`watch(listener)` fires on remount so later consumers can dispose tools and the prompt section.

`JSPACE_ALWAYS_OPEN_GOAL` (`J-Space is on`) and `JSPACE_ALWAYS_OPEN_NEXT` (`State the first action`) are the stock lines for `always-open` and bare `/j-space on`.

## Durable record

`jspace/card` is a whole-card snapshot. `jspace/closed` is a tombstone. The fold takes the highest native `seq`. A regressing native `seq`, a foreign write after the native origin, or a shape failure keeps the last good native snapshot and records `fault`. Inherited parent-seed events are not the live card.

`SESSION_FORMAT_VERSION` stays `0`.

## Model Experience

None, as this seat stores logged card state; the prompt Consumer owns request text.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`always-open` does not auto-open** — the field is stored; the prompt Consumer opens on the first pre-step with `JSPACE_ALWAYS_OPEN_GOAL` / `JSPACE_ALWAYS_OPEN_NEXT`.
- **Coverage is a term match** — `checkpoint()` cannot tell whether the verifier ran. `evidence` must name a `tool/call` id with a logged, non-error `tool/result` and still does not prove coverage.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit card events. The fold and invariant detect inconsistency; they do not isolate plugins.
- **Copy-on-fork inherits Checked** — copy-on-fork copies the parent's Checked lines into the child card while resetting the epoch anchor, so the child's prompt shows checkpoints it has not earned; ship still refuses until a native checkpoint.
