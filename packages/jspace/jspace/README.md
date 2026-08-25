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
    verifierTools: []
    requireVerifiedEvidence: false
    engageAfterTurns: 0
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master allow. False keeps the seat loaded and `status.active === false`. Mutations throw `JSPACE_DISABLED` and write nothing. |
| `mode` | `available` | `available` waits for `open()`. `always-open` is reserved for the prompt Consumer. |
| `requireCoverage` | `true` | `checkpoint()` refuses a `by` string that matches no coverage term. |
| `coverageTerms` | `[]` | Extra literal terms merged with the built-in English list. |
| `verifierTools` | `[]` | Tool names whose completed non-error calls mark a cited `evidence` call-id evidence-grade (`verified: true` on the Checked line). Empty leaves classification dormant. |
| `requireVerifiedEvidence` | `false` | When true, `jspace_ship` refuses unless the current Goal epoch has an evidence-grade checkpoint. |
| `engageAfterTurns` | `0` | Completed turns a session must close before Consumers engage. `0` engages from the first request. |

`installSettingsSection` owns the namespace. Unknown keys fail at load. The seat remounts when the document changes.

## Engagement

`engaged(session)` is the single predicate both Consumers read, so the prompt sections and the four tool schemas appear and disappear together. An active seat engages a session when its card is already open — an open card must never lose its driver or its tools across a resume, a fork, or a threshold change — or when the session has closed at least `engageAfterTurns` turns. `engageAfterTurns` reads through `ctx.jspace.engageAfterTurns`, which resolves a document that omits the field to `0`. A caller with no session, such as a scope-only assembly, carries no horizon and stays unengaged under a non-zero threshold.

Both inputs are folds of the session log — `turn/end` count and card status — so engagement adds no session event and keeps the model-visible prompt reconstructable from the log alone. The [adaptive-engagement note](../../../.agents/notes/implemented/feature/2026-08-25-jspace-adaptive-engagement.md) owns the measurement behind the default.

## Service

`ctx.jspace` accepts a live `Session`. `open`, `openGoal`, `note`, `checkpoint`, and `close` append `{ ignorable: true }` events. `card(session)` and `fold(session)` replay the log. A fork with an inherited parent card receives a native copy (`seq` 1, child `sessionId`) while the seat is active.

`open` refuses while a card is open (`JSPACE_ALREADY_OPEN`). `openGoal` opens a new Goal epoch on an open card: a Goal identity change resets Core and Checked and moves the `goalOpenedSeq` anchor so ship requires a checkpoint under the new Goal; a same-Goal call updates Goal and Next in place and keeps Core, Checked, and Open. `note` rejects a Goal identity change (`JSPACE_NOTE_GOAL_CHANGE`); Goal epochs open only through `openGoal`. `note` also rejects a patch whose Goal, Next, Core, and Open match the current card (`JSPACE_NOTE_NOOP`). Line validation refuses a Core, Checked, or Open string whose trimmed text `JSON.parse`s to an array (`JSPACE_LINE_PACKED`); a line that merely starts with `[` or that parses to a JSON object or string is accepted. Open questions carry over unchanged across an epoch change. `checkpoint()` still applies `requireCoverage` to `by`. When `evidence` names a completed non-error `tool/call` whose `name` is in `verifierTools`, the Checked line carries `verified: true`.

`watch(listener)` fires on remount so later consumers can dispose tools and the prompt section. `watch` carries the seat-wide toggle; per-session engagement is a read of `engaged(session)` at request time.

`JSPACE_ALWAYS_OPEN_GOAL` (`J-Space is on`) and `JSPACE_ALWAYS_OPEN_NEXT` (`State the first action`) are the stock lines for `always-open` and bare `/j-space on`.

## Durable record

`jspace/card` is a whole-card snapshot. `jspace/closed` is a tombstone. The fold takes the highest native `seq`. A regressing native `seq`, a foreign write after the native origin, or a shape failure keeps the last good native snapshot and records `fault`. Inherited parent-seed events are not the live card.

`SESSION_FORMAT_VERSION` stays `0`.

## Model Experience

None, as this seat stores logged card state; the prompt Consumer owns request text, including reprint caps and the untrusted card frame.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`always-open` does not auto-open** — the field is stored; the prompt Consumer opens on the first pre-step with `JSPACE_ALWAYS_OPEN_GOAL` / `JSPACE_ALWAYS_OPEN_NEXT`.
- **Coverage is a term match** — `requireCoverage` still only matches `by` against configured terms. `evidence` must name a `tool/call` id with a logged, non-error `tool/result`. Evidence-grade status (`verified: true`) is a separate class: the cited call's tool name must be in `verifierTools`.
- **Workspace fingerprint is deferred** — evidence-grade classification does not yet record or compare a git status/diff hash, so a re-cited verifier result still counts after the workspace changes. The [evidence-grade note](../../../.agents/notes/implemented/feature/2026-08-25-jspace-evidence-grade-checkpoints.md) owns the deferral.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit card events. The fold and invariant detect inconsistency; they do not isolate plugins.
- **Copy-on-fork inherits Checked** — copy-on-fork copies the parent's Checked lines into the child card while resetting the epoch anchor, so the child's prompt shows checkpoints it has not earned; ship still refuses until a native checkpoint.
