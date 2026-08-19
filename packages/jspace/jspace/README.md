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
| `requireCoverage` | `true` | `checkpoint()` requires a coverage term and a successful non-J-Space evidence call for the current Goal. |
| `coverageTerms` | `[]` | Extra literal terms merged with the built-in English list used for the `by` coverage claim. |

`installSettingsSection` owns the namespace. Unknown keys fail at load. The seat remounts when the document changes.

## Service

`ctx.jspace` accepts a live `Session`. `open`, `note`, `checkpoint`, and `close` append `{ ignorable: true }` events. `card(session)` and `fold(session)` replay the log. A fork with an inherited parent card receives a native copy (`seq` 1, child `sessionId`) while the seat is active.

`watch(listener)` fires on remount so later consumers can dispose tools and the prompt section.

`JSPACE_ALWAYS_OPEN_GOAL` (`J-Space is on`) and `JSPACE_ALWAYS_OPEN_NEXT` (`State the first action`) are the stock lines opened by bare `/j-space on`; the prompt Consumer's loop auto-open uses them only as the blank-text Goal fallback and the stock Next.

## Durable record

`jspace/card` is a whole-card snapshot. `jspace/closed` is a tombstone. The fold takes the highest native `seq`. A regressing native `seq`, a foreign write after the native origin, or a shape failure keeps the last good native snapshot and records `fault`. Inherited parent-seed events are not the live card.

`SESSION_FORMAT_VERSION` stays `0`.

## Model Experience

None, as this seat stores logged card state; the prompt Consumer owns request text.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Automatic open belongs to the prompt Consumer** — the seat stores `mode`; the prompt Consumer opens during assembly, seeds Goal from triggering human text with `JSPACE_ALWAYS_OPEN_GOAL` as the blank fallback, and uses `JSPACE_ALWAYS_OPEN_NEXT` as Next.
- **Evidence is not semantic verification** — `checkpoint()` requires a successful non-J-Space call for the current Goal when coverage is required; it cannot prove that call covered the claim.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit card events. The fold and invariant detect inconsistency; they do not isolate plugins.
