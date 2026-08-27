# Design: executor-enforced J-Space charter (Phase 1, items 1–5)

Working implementation design for [the contract plan](.agents/notes/proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) items 1–5. Not an Agent Note and not committed. Evidence and decision rules: [the W0 eval note](.agents/notes/proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md).

Scope: typed charter entries, check substance (floor + discrimination), seeding from the first user message, checkpoint/ship execution through the standard tool pipeline, amendment, session events, config, the w9 arm, and tests. Out of scope: compaction pointers (item 6), close hygiene (item 7), max-turns / default timeout (items 8–9).

## 1. Ownership and invariants

The charter is **card state**, not Core. Core stays the two-item working-memory stage. w8 stuffed house rules onto Core because that was the only gated field; six rules cannot live there, and verbatim Core prose did not change the qty failure class (`off` 7/16 vs `on-core` 6/16). The charter is a separate list of typed entries on the same `jspace/card` snapshot.

| Concern | Owner |
|---|---|
| Types, fold, seat methods (`open` / `amendCharter` / `charter`), `jspace/card` payload | `@shres-code/shres-code-jspace` |
| Tool schemas, floor, discrimination, nested `bash` dispatch, refusals | `@shres-code/shres-code-tool-jspace` |
| Seed reprint section `jspace:charter-seed`; driver-line edits | `@shres-code/shres-code-jspace-prompt` |
| Pure extraction + template catalog (no Cordis) | `packages/jspace/jspace/src/charter-seed.ts` (seat package: deterministic, host-free) |

Registrations stay effects (`ctx.tools.register`, `ctx.on`, `ctx.effect`). Opaque ids are branded. Closed unions `switch` on `kind` and end in `assertNever`. Enablement is Loader config; a missing `bash` tool when any registered entry is `kind: 'check'` fails at the first charter run (earliest resolvable point), not as a silent skip.

Incompatible composition fails at `tool-jspace` `apply`: `requireCharter === true` and `ctx.jspace.config.mode === 'always-open'` throw, because always-open writes a stock card with no model confirmation of the seed.

## 2. Typed charter entries

### 2.1 Brands and closed unions

```ts
import type { Branded } from '@shres-code/shres-code-brand'
import type { CallId } from '@shres-code/shres-code-llm/brand'

/** Stable per-card entry id. Factory in `shres-jspace`; not a `CallId`. */
export type CharterEntryId = Branded<'CharterEntryId'>
export function CharterEntryId(id: string): CharterEntryId {
  if (id.trim().length === 0 || id !== id.trim() || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new TypeError(`charter entry id must be a kebab-case token, got ${JSON.stringify(id)}`)
  }
  return id as CharterEntryId
}

export type CharterDiscrimination = 'demonstrated' | 'unverified'

export type CharterFailProbe =
  | { readonly kind: 'insert'; readonly content: string }
  | { readonly kind: 'prepend'; readonly content: string }
  | { readonly kind: 'replace'; readonly from: string; readonly to: string }

/** Model- and seeder-authored input (no runtime status). */
export type CharterEntryInput =
  | CharterCheckInput
  | CharterProseInput

export interface CharterCheckInput {
  readonly kind: 'check'
  readonly id?: CharterEntryId
  /** Constraint text this command enforces. Reprinted; the command is not a substitute. */
  readonly constraint: string
  /** Foreground bash command. Exit 0 passes; any other exit fails. */
  readonly command: string
  /**
   * Workspace-relative paths or globs the command is declared to read.
   * At least one. Every path must resolve inside session cwd.
   */
  readonly reads: readonly string[]
  /**
   * Content mutation applied to `failProbe.path` that MUST make `command` fail.
   * Required when seat/tool `charterDiscrimination` is `'required'`.
   */
  readonly failProbe?: {
    readonly path: string
    readonly mutation: CharterFailProbe
  }
}

export interface CharterProseInput {
  readonly kind: 'prose'
  readonly id?: CharterEntryId
  readonly constraint: string
}

/** Folded card state. Commands stay on the snapshot so checkpoint/ship can re-run without the model. */
export type JspaceCharterEntry =
  | JspaceCharterCheck
  | JspaceCharterProse

export interface JspaceCharterCheck extends CharterCheckInput {
  readonly kind: 'check'
  readonly id: CharterEntryId
  readonly discrimination: CharterDiscrimination
  /** Why `unverified`, when that marker is set. Omitted when demonstrated. */
  readonly unverifiedReason?: CharterUnverifiedReason
}

export interface JspaceCharterProse {
  readonly kind: 'prose'
  readonly id: CharterEntryId
  readonly constraint: string
}

export type CharterUnverifiedReason =
  | 'discrimination-off'
  | 'policy-denied'
  | 'probe-timeout'
  | 'probe-infeasible'
```

No `delete` fail-probe. Content-only mutations are the whole point: an existence check (`test -f`) cannot demonstrate discrimination against insert/prepend/replace, so it is refused at registration rather than credited.

### 2.2 Card payload

Add `charter: readonly JspaceCharterEntry[]` to `JspaceCard` (default `[]` in the fold when the field is absent, so existing snapshots stay readable). `jspace/card` remains `{ ignorable: true }`; the extra field does not bump `SESSION_FORMAT_VERSION`. Goal-identity change (`openGoal` different Goal) **keeps** the charter and resets Core and Checked: house rules outlive a Goal rewrite; Checked must be re-earned by a checkpoint that re-runs the same checks.

Seat API additions (same-process, typed; no bash):

- `charter(session): readonly JspaceCharterEntry[]`
- `open(..., { charter?: readonly JspaceCharterEntry[] })` — first open only, parallel to `core`
- `amendCharter(session, next: readonly JspaceCharterEntry[]): JspaceCard` — replacement list; the tool Consumer runs floor + discrimination **before** calling this

### 2.3 `jspace_open` JSON schema

Keep `goal`, `next`, `core`. Add `charter` (array of `oneOf` objects). Tool `oneOf` is already in `ParameterSchemaSpec`.

```ts
charter: {
  type: 'array',
  description:
    'Standing constraints this work must honor. Prefer kind=check (a bash command the harness will '
    + 'run at every checkpoint and at ship). Each check names the constraint text it enforces. '
    + 'kind=accept-proposal copies ids from the harness proposal in this turn. '
    + 'Applied only on the first open.',
  items: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'check' },
          id: { type: 'string', description: 'Kebab-case id. Omit to receive a harness-assigned id.' },
          constraint: { type: 'string', required: true, description: 'The rule this command enforces, in the task\'s words.' },
          command: { type: 'string', required: true, description: 'Foreground bash. Exit 0 = pass. Must read the paths in `reads`.' },
          reads: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Workspace-relative files or globs the command reads. At least one.',
          },
          failProbe: {
            type: 'object',
            additionalProperties: false,
            description: 'A content mutation that must make `command` fail. Required when this deployment demands demonstrated discrimination.',
            properties: {
              path: { type: 'string', required: true, description: 'Workspace-relative path; must be in `reads` or match a `reads` glob.' },
              mutation: {
                required: true,
                oneOf: [
                  {
                    type: 'object', additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'insert' },
                      content: { type: 'string', required: true },
                    },
                  },
                  {
                    type: 'object', additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'prepend' },
                      content: { type: 'string', required: true },
                    },
                  },
                  {
                    type: 'object', additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, const: 'replace' },
                      from: { type: 'string', required: true },
                      to: { type: 'string', required: true },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'prose' },
          id: { type: 'string' },
          constraint: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'accept-proposal' },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Proposal ids to accept. Omit to accept every proposed entry.',
          },
        },
      },
    ],
  },
}
```

Open-tool execute:

1. Resolve `accept-proposal` rows against the latest `jspace/charter-proposal` in this session (loud refuse if none, or if an id is unknown).
2. Assign ids for omitted ones (`e1`, `e2`, … skipping taken ids).
3. Run floor + discrimination on every `kind: 'check'` (section 3).
4. `openRefusal` gains a charter branch: when `requireCharter` and this call creates the card, refuse unless the resolved list has length ≥ 1; when `requireExecutableCharter`, refuse unless at least one entry is `kind: 'check'` with `discrimination: 'demonstrated'` (or `'unverified'` only when config allows it).
5. Seat `open` records the resolved list on the card.

`core` is unchanged. Constraint-capture flags `requireCoreOnOpen` / `requireCoreForShip` stay default-off and are **not** set on the w9 arm (w8 already priced them).

### 2.4 Enablement

Composition only. No runtime classifier of “constraint-bearing” work.

| Config (on `tool-jspace` unless noted) | Default | w9 |
|---|---|---|
| `requireCharter` | `false` | `true` |
| `requireExecutableCharter` | `false` | `true` |
| `charterSeed` | `false` | `true` |
| `charterDiscrimination` | `'off'` | `'required'` |
| `charterCheckTimeoutMs` | `30000` | `30000` |
| `maxCharterEntries` | `12` | `12` |
| `charterChecksMustBeReadOnly` | `true` | `true` |

Seat config is not the home for these flags (same split as `requireCoreOnOpen` living on the tool Consumer). A registered charter **always executes** at checkpoint and ship when the list is non-empty; the flags only force registration and the discrimination bar. Presence implies execution.

## 3. Check substance (floor + discrimination)

This is the item that decides whether w9 is a real gate or another ritual. A presence check on “has a command” is `echo ok` under pressure — the same placeholder move w7 measured in prose.

### 3.1 Mechanical floor: constant-success commands

**Do not use `fs/observed`.** That event is emitted only by `read` / `write` / `edit` (and relatives). Charter checks run as `bash`; bash never emits `fs/observed`. Do not add strace/Landlock file-access tracing in this phase (not portable; not a documented extension point).

The floor is a **named-read contract plus a static tautology reject**, all decided before any process starts.

#### Step A — `reads` is a workspace read set

- `reads.length >= 1`.
- Each entry is a non-empty workspace-relative path or glob (`*`, `**`, `?` allowed).
- Resolve against `agent.session.header.cwd` (same root the bash tool uses). Reject any result that escapes cwd (`JSPACE_CHARTER_READS_ESCAPE`), using the path-policy helper tool-fs already applies to relative paths — do not hand-roll a second one if an existing function applies; otherwise copy that comparison, do not invent a third.
- `failProbe.path`, when present, must be a literal member of `reads` or a path that matches at least one `reads` glob.

#### Step B — strip then demand a live path token

1. Strip bash comments: delete `#…` to end-of-line outside single/double quotes (no full bash parser; document the quote-escape failure mode below).
2. Tokenize on whitespace.
3. **Pass** if at least one token, after stripping surrounding quotes, equals a `reads` entry or is a path that matches a `reads` glob.
4. **Also pass** if the command matches a **test-runner prefix** (anchored, after strip): `node --test`, `node --test `, `vitest`, `npx vitest`, `npm test`, `pnpm test`, `yarn test` — **and** every `reads` entry still resolves inside cwd. The runner is the workspace read; `reads` still names what the harness is allowed to mutate for discrimination.
5. Otherwise **refuse** (`JSPACE_CHARTER_NO_READ`): *“charter entry `<id>` (`<constraint>`) names no workspace read: put a path from `reads` in the command, or use a listed test runner.”*

A path token that appears **only** as an argument to a tautology command still fails Step C.

#### Step C — tautology denylist

After comment-strip, split on `&&`, `||`, and `;` (not inside quotes). If **every** segment matches one of these (trim, collapse whitespace), refuse `JSPACE_CHARTER_CONSTANT`:

- empty, `true`, `:`, `exit`, `exit 0`
- `echo` / `printf` / `print` with no token that passed Step B
- `[ 1 -eq 1 ]`, `test 1 -eq 1`
- `true <path>`, `: <path>` (path as ignored operand)

#### Step D — write-token denylist (`charterChecksMustBeReadOnly`)

Refuse `JSPACE_CHARTER_MUTATING` if the stripped command contains (unquoted-operator scan, same quote rule as B): ` rm `, ` mv `, ` sed -i`, ` tee `, ` npm install`, ` pnpm add`, ` git commit`, or an unquoted `>` / `>>` redirect. This is a floor, not a sandbox. Failure mode: `node -e 'fs.writeFileSync(...)'` is not caught here; discrimination restore plus w9 measurement cover the rest. Checks that must compile into `dist/` are the wrong check for this gate — they belong in the task’s own tests.

#### Floor failure modes (honest)

| Case | Floor result |
|---|---|
| `echo ok` | C rejects |
| `echo ok # src/m01-sku.js` | B strips comment, C rejects |
| `true src/m01-sku.js` | C rejects (tautology + ignored path) |
| `cat src/foo.js >/dev/null \|\| true` | D rejects on `>` when read-only is on; if a quoting trick bypasses D, discrimination (insert still `cat`s successfully if we only change content… `cat` exit 0) **rejects at the bar** |
| `test -f src/foo.js` | B passes (path token); discrimination against content insert **rejects** (file still exists) |
| `ls src/` | B passes; discrimination against content insert **rejects** (`ls` still 0) |
| `grep AUDIT-TAG src/m01-sku.js` | B passes; discrimination depends on failProbe |
| `node --test` with `reads: ['src/m01-sku.js']` | B runner exception; discrimination: insert a violation the **suite does not see** → `node --test` still 0 → **rejects** (this is the desired reject of “tests green”) |
| `$f=src/foo.js; grep x $f` | B false-reject (path not a literal token). Model must write the path literally. |
| Quoted `#` inside `'echo # not a comment'` | Strip may mis-handle nested quotes. Prefer refusing on parse doubt rather than passing: if quote state is still “in-quote” at EOL, refuse `JSPACE_CHARTER_COMMAND_UNPARSEABLE`. |

### 3.2 Discrimination bar

A check is **credited** only when the harness has seen it fail on a violation. The cheap form is one seeded mutation at **registration** (first open or amend-add), not at every checkpoint.

#### Algorithm `discriminate(entry, exec)`

Runs inside `jspace_open` / `jspace_charter_amend` after the floor, through the nested bash path in section 5 (same pipeline as checkpoint). `charterDiscrimination === 'off'`: skip, set `unverified` / `discrimination-off`. `'best-effort'`: on probe failure, mark unverified instead of refusing the tool. `'required'` (w9): any outcome other than “command failed after mutation, then restore succeeded” refuses the open/amend.

1. Require `failProbe`. If missing and `'required'`: refuse *“charter entry `<id>` has no failProbe; add a content mutation of a `reads` path that this command rejects.”*
2. Resolve `failProbe.path` against cwd.
3. Snapshot: `ctx.fs.stat` + `readText` if present, else `absent`. Use `ctx.fs` here only for the harness-owned probe file, not as the check’s read path.
4. Apply mutation:
   - `insert`: write `content` (create or replace whole file).
   - `prepend`: write `content + (existing ?? '')`.
   - `replace`: if absent, refuse `probe-infeasible` (nothing to replace). If `from` is not a substring, refuse *“failProbe.replace.from not found in `<path>`.”* Write the replaced text.
5. `try`: dispatch `entry.command` via nested `bash` (section 5). **Expect failure:** bash canonical `kind: 'foreground'` and `exitCode !== 0`, or `isError === true` from a non-policy tool error that still represents command failure (non-zero is the pass/fail bit; `timedOut` / `aborted` are not a demonstrated reject of the constraint).
   - Policy deny (`tools/pre-execute` `kind: 'deny'`): `'required'` refuses the outer tool naming the deny reason; `'best-effort'` → `unverified` / `policy-denied`.
   - Timeout: same split with `probe-timeout`.
   - Exit 0: refuse `JSPACE_CHARTER_NO_DISCRIMINATE`: *“charter entry `<id>` (`<constraint>`) still passed after the failProbe mutation of `<path>`. The command does not detect this violation. Change the command so it fails when that constraint is broken.”*
6. `finally`: restore the snapshot (rewrite original text or `ctx.fs` delete the created file). Restore failure is an outer tool error, not a model-amendable charter refusal — it is harness I/O.
7. On demonstrated reject: set `discrimination: 'demonstrated'`. Log `jspace/charter-probe` (section 9).

Build-from-scratch (constraint-survival-build): modules do not exist at open. `insert`/`prepend` **creates** the probe file; the command must fail on that violating content; `finally` deletes it. That is the cheap form the plan asked for.

Do **not** run the check against the untouched workspace at open and require success. Honest work has not been done yet; a qty grep over empty `src/m*.js` may exit 1 (no matches) or 0 (`rg` with no files). Requiring a green pre-check at open would refuse every build task.

#### What discrimination proves and what it does not

It proves **non-tautology**: there exists one harness-applied content mutation of a declared read path that this command rejects. It does **not** prove the command tests the named constraint rather than a correlate of the failProbe (for example grepping a magic string the probe removes). Constraint alignment is a w9 pass-rate question, not an executor theorem.

### 3.3 Gaming vector ledger

| Vector | Caught by | Measured by |
|---|---|---|
| `echo ok` / `true` / `exit 0` | Floor C | — |
| Comment or tautology operand smuggling a path | Floor B+C | — |
| `reads` filled but command ignores files (`test -f`, `ls`) | Discrimination vs content-only probe | — |
| `node --test` / task suite as the house-rule check | Discrimination: house-rule violation the suite cannot see still exits 0 (w7/w8 finding) | — |
| Command writes then exits 0 | Floor D (partial); restore mismatch is not currently a gate | w9 |
| Collusive pair: grep magic string + failProbe that removes that string, while `constraint` talks about qty | **Not caught** | w9 pass rate; seeding reduces incidence by supplying aligned templates |
| Check tests the failProbe path only (`grep BAD src/.probe.js` while `reads` is that probe file) | Weak: `failProbe.path` must match `reads`; seeder templates point `reads` at `src/m*.js`, so a probe-only grep fails Step B unless the model also shrinks `reads` | w9; if `reads` is shrunk to the probe file, the check will not fail later real modules — ship re-run against the real tree should then fail (or pass vacuously if globs match nothing — **ship treats “no glob matches and command exit 0” as failure** when `reads` is glob-only and expanded match count is 0) |
| `rg` that false-fails on numbers in comments (qty rule allows those) | Not a game; gate friction | w9 honest-work fail rate; prefer an AST/helper script in the task fixture |
| Policy-denied nested bash counted as pass | No: deny ≠ exit 0 | — |
| Skip discrimination (`unverified`) and ship anyway | `'required'` refuses to register; ship refuses unverified gating entries | `'best-effort'` / `'off'` arms if we ever add them |

Ship extra rule: if every glob in `reads` expands to zero files and the command exits 0, treat as **fail** (`JSPACE_CHARTER_NO_SUBJECT`): *“charter entry `<id>` matched no files in `reads` (`<globs>`). The workspace has no subject for this check.”* Vacuous success is the glob version of `echo ok`.

## 4. Charter seeding

### 4.1 Lifecycle hook

`agent/pre-step`, **prepended** (same pattern as `agent-instructions` / `time-context`):

1. `await next()` first so a rejecting listener still wins.
2. If the decision is not `enter`, return it.
3. If `charterSeed` is false, or the seat is unengaged, or a `jspace/charter-proposal` already exists for this session, or a native card already has a non-empty charter, return.
4. Take claimed messages with `source.kind === 'user'` (human prompt, not plugin inject). If none, return — do not seed from AGENTS.md or skill text.
5. Run `extractCharterProposal(text)` (pure). If the result is empty, return (no event, no section).
6. `session.append('jspace/charter-proposal', payload, { ignorable: true })`.

This is the first model request of the session that carries the user task: the proposal is in the log **before** `system-prompt/assemble` for that step. Do not `agent.inject` a second user message (double-counts tokens and looks like a second prompt). The prompt Consumer reprints from the log, matching `jspace:card`.

First user message = first `user/message` with `source.kind === 'user'` after `session/end-seed` in this live lifecycle. Pre-step uses the claimed batch, which is that message on turn 1.

### 4.2 Extraction (deterministic, no classifier of work-type)

`extractCharterProposal(text): CharterEntryInput[]`:

1. Prefer a `## House rules` (or `## Constraints`, `## Standing rules`) section until the next `##` heading.
2. Else take consecutive numbered items `^\d+\.\s+` from the message body.
3. Else return `[]` (no invention).
4. Each item → `{ kind: 'prose', constraint: itemText }` then **optionally** upgrade via the template catalog (explicit title/keyword match, first hit wins). Templates are data in `charter-seed.ts`, not a learned gate.

Product templates may be empty. The w9 / constraint-survival-build catalog (section 12) supplies commands + failProbes for the six house rules so the model confirms rather than authors from blank. A non-matching item stays `kind: 'prose'` and the model-facing block says to upgrade it to a check.

Cap at `maxCharterEntries`. Excess items are omitted and the proposal payload records `truncated: true`.

### 4.3 Model-facing surface

New prompt section `jspace:charter-seed` (order 44, immediately before `jspace:card` at 45), mounted only when a proposal event exists and the folded card has an empty charter.

Exact copy (pin in unit tests and the headless snapshot):

```
J-Space charter (harness proposal). Confirm or amend on jspace_open; do not author a blank list.
Each check is a bash command the harness will run at every checkpoint and at ship. Exit 0 passes.
kind=accept-proposal with no ids accepts this whole list. Replace any entry by sending kind=check with a different command.
Prose entries reprint; they do not pass ship. Prefer a check per rule.

<for each proposed entry>
- id=<id> kind=<check|prose>
  constraint: <single line>
  <if check> command: <command>
  <if check> reads: <comma-separated>
  <if check> failProbe: <kind> <path>
```

Driver line addition (when `requireCharter`, closed card): after the existing Core sentence, *“Pass the charter on `jspace_open` (accept the proposal or amend it). Ship re-runs every check and names the first failure.”*

Runtime invariant (`tool-jspace` or `jspace-prompt` companion): if assembled sections include `jspace:charter-seed`, the session log contains `jspace/charter-proposal`. The section text is model-visible; the event is the reconstructable source (model-visible ⟺ logged). The proposal is **new** input because template commands are not in the user message.

## 5. Checkpoint runs the charter

### 5.1 Seam

**`ctx.tools.execute` for the registered `bash` tool**, with the parent token of the in-flight `jspace_checkpoint` / `jspace_ship` / `jspace_open` (probe) execution. Precedent: Code Mode bindings in `packages/core/tools/src/code-mode.ts` (`parent: exec.token`, `rootCallId: exec.rootCallId`, `callId: CallId(\`${exec.callId}:code:${n}\`)`). Workflow scripts are the other cited precedent; they spawn subagents, not shell, so they are not the dispatch helper to copy.

Do **not** call `ctx.shell.run` / `resolve` from jspace. That skips `tools/pre-execute` (permission, sandbox escalation), monotonic guards, `tools/execute` timeouts, and `tools/post-execute`. The note forbids a privileged path.

```ts
const result = await ctx.tools.execute({
  callId: CallId(`${String(exec.callId)}:charter:${entry.id}`),
  rootCallId: exec.rootCallId ?? exec.callId,
  name: 'bash',
  arguments: {
    command: entry.command,
    description: `Run charter check ${entry.id}`,
    timeoutMs: config.charterCheckTimeoutMs,
  },
  agent: exec.agent,
  parent: exec.token,
  signal: exec.signal,
})
```

Foreground only — never `run_in_background`. `description` is required by the bash schema.

If `ctx.tools.get('bash', exec.agent)` is missing: throw at that run *“charter checks require the bash tool; load `@shres-code/shres-code-tool-bash` (and a `ctx.shell` provider).”*

### 5.2 Policy, approval, timeout, budgets

Nested execute enters the full pipeline (`docs/tool-execution-pipeline.md`). Headless bench uses a permission preset with `approval: 'never'`; an interactive session may ask. Same as a model-issued `bash`. Do not add a charter bypass on `tools/pre-execute`.

The jspace identical-retry listener scans `tool/call` events. Nested bash does **not** log `tool/call` (only the agent-loop does, for model-direct calls), so the repeat guard does not fire on charter re-runs. Do not change that.

Timeouts: bash `timeoutMs` argument plus any `tools/execute` wrapper. Charter does not get a longer deadline than a model bash with the same `timeoutMs`.

Turn budgets: nested runs consume wall time and the bash timeout inside the current step; they do **not** start extra model steps (step-budget is unchanged). They do **not** append `tool/result` to derived history (see events), so they do not inflate input tokens the way a model-visible bash would. That is required for the token-neutrality bound (short < 15%, long < 1.25× vs `off`).

### 5.3 `jspace_checkpoint` behavior when charter is non-empty

1. Run `runCharter(ctx, exec, entries)` sequentially (exclusive: checkpoint is not concurrency-safe with its own nested bash). First failing check aborts the rest.
2. Pass: `ctx.jspace.checkpoint` with synthesized `check` = `charter <id1>,<id2>,…`, `by` = `charter-run of <n> checks`, `evidence` = the last nested `callId` (extend `resolveEvidence` to accept a `jspace/charter-run` id as a completed non-error run). Set `verified: true` when every run passed (charter execution **is** the verifier; do not require `verifierTools` to contain `bash` for this path).
3. Fail: throw `Error` (model-visible) — do not write a Checked line:

```
jspace_checkpoint refused: charter entry "<id>" failed.
constraint: <constraint text>
command: <command>
exit: <exitCode or "denied" or "timeout">
output: <last 2KiB stdout+stderr>
fix: change the workspace so this command exits 0, or call jspace_charter_amend to replace this entry.
```

When charter is empty, today’s `check` / `by` / `evidence` path is unchanged. When `requireCharter` and charter is empty: refuse checkpoint *“no charter is registered; call jspace_open with a charter or jspace_charter_amend.”*

`check` / `by` remain required in the schema for back-compat when charter is empty; when charter is non-empty they become optional (schema cannot be conditional per card). Implementation: if charter is non-empty and `check` is omitted, synthesize; if both are present, run charter first, then append the model’s extra line only after charter pass (still subject to `requireCoverage`).

### 5.4 Events logged per nested run

`jspace/charter-run` (log-only, `ignorable: true`) after each nested settle, including denials and timeouts. Checkpoint then writes `jspace/card` only on full pass.

## 6. Ship gates and amendment

### 6.1 `jspace_ship`

After existing Goal/Next/checkpoint-epoch checks (keep them: ship still requires a checkpoint in this Goal epoch so the model cannot skip checkpoint). Then `runCharter` again against the **current** workspace. First failure refuses with the same named template as checkpoint, prefix `jspace_ship refused`.

Do not trust the last Checked line. Hours-later ship is a new execution.

When `requireCharter` and charter is empty: refuse with `SHIP_REQUIRES_CHARTER` (new copy, parallel to `SHIP_REQUIRES_CORE`).

`requireCoreForShip` is not used on w9.

Vacuous glob success: section 3.3.

### 6.2 `jspace_charter_amend`

Fifth model-facing tool (not a `jspace_note` field). Note’s swap semantics and two-item Core cap must not be overloaded.

```ts
// parameters
{
  drop: { type: 'array', items: { type: 'string' }, description: 'Entry ids to remove.' },
  add: { type: 'array', items: /* same oneOf as open charter check|prose, no accept-proposal */ },
  replace: {
    type: 'array',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        entry: { required: true, oneOf: [/* check | prose objects */] },
      },
    },
  },
}
```

Execute: compute next list; refuse unknown ids; run floor + discrimination on added/replaced checks; refuse if `requireExecutableCharter` and zero remaining checks; `amendCharter`; append `jspace/charter-amend`; return `{ amended: true }`. Render: `Amended charter.`

There is no “skip checks” argument. Ship cannot be passed by dropping every check when `requireExecutableCharter` is on.

### 6.3 Staleness and the deferred fingerprint

Hazard: a check registered at open (paths, globs, assumptions) against a workspace that later renamed files or outgrew the rule.

What this phase does:

- Re-run at every checkpoint and at ship (current tree).
- If all `reads` globs match nothing → fail (not skip).
- Amendment is the only way to change the command.

What this phase records but does **not** gate: on each `jspace/charter-run`, `readsFingerprint: { path, mtimeMs, size }[]` from `ctx.fs.stat` on the expanded `reads` set (best-effort; missing files omitted). This is the companion payload the evidence-grade note deferred. A later change can refuse ship when the fingerprint moved without a passing re-run; it is redundant while ship always re-runs, and useful when someone proposes skipping re-run on a hot cache. Do not skip re-run in v1.

## 7. Session events (`SessionEventMap`)

Declaration-merge in `packages/jspace/jspace/src/types.ts` (card/closed already live there). All four are **log-only**; writers pass `{ ignorable: true }` so an older reader may skip them. They are **not** `SurfaceEventType`. Model-visible text is the prompt section (proposal) or the tool result (refusals / acks), both reconstructable from these events plus `jspace/card`.

```ts
declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Harness-authored charter proposal extracted from the first human user
     * message. Log-only. Writers pass `{ ignorable: true }`.
     * @mode log-only
     * @param entries - proposed inputs (check or prose), with ids assigned.
     * @param sourceSeq - session seq of the `user/message` that was parsed.
     * @param truncated - true when items were dropped at `maxCharterEntries`.
     */
    'jspace/charter-proposal': {
      entries: readonly CharterEntryInput[]
      sourceSeq: number
      truncated: boolean
    }
    /**
     * One nested bash execution of a registered check (checkpoint, ship, or
     * registration probe). Log-only. Writers pass `{ ignorable: true }`.
     * @mode log-only
     * @param entryId - branded charter entry id.
     * @param callId - nested CallId (`<parent>:charter:<entryId>`).
     * @param parentCallId - the jspace_* call that dispatched this run.
     * @param phase - why it ran.
     * @param command - command actually dispatched.
     * @param passed - true only for foreground exit 0.
     * @param exitCode - bash exit, when the tool returned foreground output.
     * @param deniedReason - tools/pre-execute deny text, when denied.
     * @param timedOut - bash timedOut bit.
     * @param outputPreview - bounded stdout+stderr (max 2KiB).
     * @param readsFingerprint - optional stat snapshot of expanded reads.
     */
    'jspace/charter-run': {
      entryId: CharterEntryId
      callId: CallId
      parentCallId: CallId
      phase: 'checkpoint' | 'ship' | 'probe'
      command: string
      passed: boolean
      exitCode?: number | null
      deniedReason?: string
      timedOut?: boolean
      outputPreview: string
      readsFingerprint?: readonly { path: string; mtimeMs: number; size: number }[]
    }
    /**
     * Discrimination probe: mutation applied, command outcome, restore done.
     * Log-only. Writers pass `{ ignorable: true }`.
     * @mode log-only
     * @param entryId - charter entry id.
     * @param callId - nested CallId of the probe bash.
     * @param path - failProbe.path.
     * @param mutationKind - insert, prepend, or replace.
     * @param demonstrated - true when the command failed after mutation.
     * @param unverifiedReason - set when not demonstrated.
     */
    'jspace/charter-probe': {
      entryId: CharterEntryId
      callId: CallId
      path: string
      mutationKind: CharterFailProbe['kind']
      demonstrated: boolean
      unverifiedReason?: CharterUnverifiedReason
    }
    /**
     * Charter list replaced via jspace_charter_amend. Log-only. Writers pass
     * `{ ignorable: true }`. The following `jspace/card` snapshot is authoritative.
     * @mode log-only
     * @param dropped - ids removed.
     * @param added - ids added.
     * @param replaced - ids replaced.
     */
    'jspace/charter-amend': {
      dropped: readonly CharterEntryId[]
      added: readonly CharterEntryId[]
      replaced: readonly CharterEntryId[]
    }
  }
}
```

`@mode` on these JSDoc blocks is the session-catalog convention (`log-only`). Regenerating `known-event-types.ts` via `pnpm run gen-persistence-catalog` picks them up. Invariant companion: every `jspace/charter-run` `parentCallId` matches a `tool/call` for `jspace_checkpoint` | `jspace_ship` | `jspace_open` | `jspace_charter_amend` in the same session.

## 8. Config (validated `Config` fields)

`packages/jspace/tool-jspace` `Config` grows (schemastery + `resolveConfig` loud checks):

| Field | Schema | Load-time reject |
|---|---|---|
| `requireCharter` | `z.boolean().default(false)` | — |
| `requireExecutableCharter` | `z.boolean().default(false)` | if true and `requireCharter` is false: throw (`requireExecutableCharter` implies `requireCharter`) |
| `charterSeed` | `z.boolean().default(false)` | — |
| `charterDiscrimination` | `z.union(['off','best-effort','required']).default('off')` | if `'required'` and not `requireExecutableCharter`: throw |
| `charterCheckTimeoutMs` | `z.number().step(1).min(1).default(30_000)` | same as `maxNotesPerTurn`: not a safe integer → `TypeError` |
| `maxCharterEntries` | `z.number().step(1).min(1).max(32).default(12)` | — |
| `charterChecksMustBeReadOnly` | `z.boolean().default(true)` | — |

`apply` also throws if `requireCharter` && `ctx.jspace.config.mode === 'always-open'`.

No hardcoded tunables in the plugin body: timeout, caps, and discrimination mode are these fields. Protocol constants (id regex, tautology list, test-runner prefixes, 2KiB preview) stay fixed.

## 9. Reprint

`formatJspaceCard` adds a `Charter:` line when the list is non-empty:

```
Charter:    e1 ✓ qty via qty(); e2 ? audit tag [unverified]; e3 prose export prefix
```

`✓` = check + demonstrated; `?` = unverified check; `prose` = prose. Constraint text only, truncated to 40 chars per entry. **Do not reprint commands** on the card (token liability; 1.6–2.9× was the card’s measured cost). Commands live in the log and in the seed section until accepted.

Checked lines from charter runs stay short (`charter e1,e2,e3 — charter-run of 3 checks`).

## 10. w9 arm overlay

Register `on-charter` in `bench/runner/arms.js`, contrast vs `off` (and secondarily vs `on-core` only as a forensics extra, not a decision rule). Same pairing protocol as w8: interleaved, pinned model, `constraint-survival-build` plus **one new task whose constraints its own tests cannot see** (plan item Phase 2). Until that task exists, w9 may start on `constraint-survival-build` alone at power-analysis n, but the pre-registered rule should not graduate a default from that single task.

```js
'on-charter': Object.freeze({
  name: 'on-charter',
  jspace: Object.freeze({ enabled: true, mode: 'available', requireCoverage: true }),
  toolJspace: Object.freeze({
    requireCharter: true,
    requireExecutableCharter: true,
    charterSeed: true,
    charterDiscrimination: 'required',
    charterCheckTimeoutMs: 30_000,
    maxCharterEntries: 12,
    charterChecksMustBeReadOnly: true,
  }),
  sessionQuery: false,
  expectsSessionQuery: false,
  expectsJspace: true,
}),
```

`renderArmOverlay` already patches `tool-jspace` from `toolJspace`. Decision rule (record in the W0 note when implementing, do not silently promote): `on-charter` beats `off` on `constraint-survival-build` (McNemar, interval excluding 0) at power-analysis n; input-token ratio vs `off` under 1.25× on that long/pressure task and under 15% on a short-stratum companion; underpowered → “not yet”. Forensics: `charterRunFailNamed` (ship/checkpoint refusal names an entry), `emptyCharterRate`, `unverifiedShare`, `echoOkRejectRate`.

### 10.1 Seed templates for `constraint-survival-build`

Ship as data next to `extractCharterProposal`. Commands must fail a content probe and must see rules the `test/*.test.js` files do not. Prefer adding `tools/check-house-rules.mjs` to the **task fixture** (verifier stays `node verify.mjs`; the helper is for the agent’s charter). If the fixture cannot change in the same PR, inline `node -e` scripts in the templates.

Sketch (qty is the measured failure class):

| Rule | `reads` | Command (sketch) | failProbe |
|---|---|---|---|
| Export prefix | `src/m*.js` | `node tools/check-house-rules.mjs export-prefix` | insert a file with `export function foo()` |
| Audit tag | `src/m*.js` | `node tools/check-house-rules.mjs audit-tag` | insert a file whose first line is `// no tag` |
| Quantities | `src/m*.js` | `node tools/check-house-rules.mjs qty` (AST or token walk; comments/strings/regex exempt) | prepend `const n = 3\n` |
| Line budget | `src/m*.js` | `node tools/check-house-rules.mjs lines 80` | insert a 81-line file |
| Errors | `src/m*.js` | `node tools/check-house-rules.mjs inventory-error` | insert `throw new Error('x')` |
| Self-check | `src/m*.js` | `node tools/check-house-rules.mjs self-check` | insert a module with no `selfCheck` |

Regex-only qty is **not** the recommended template (`Number(match[1])` vs comment `1`). If the helper is not ready, mark qty as proposed `kind: 'prose'` and let the model supply a check — w9 then includes that gaming/omission path, which is a valid measurement, not a silent pass.

## 11. Test plan

### 11.1 Unit (`packages/jspace/**/tests`)

| Case | Package |
|---|---|
| Floor: `echo ok`, comment-smuggled path, `true path`, `test -f`, test-runner prefix, unparseable quotes, glob escape | tool-jspace |
| Discrimination: insert makes grep fail → demonstrated; insert still pass → refuse; missing failProbe + required → refuse; restore after create | tool-jspace (tmp dir, real `bash` like bash integration tests — mock only LLM) |
| `node --test` + qty probe still green → refuse registration | tool-jspace + a mini fixture |
| Vacuous glob + exit 0 → ship/checkpoint refuse | tool-jspace |
| Seed extract: house-rules section, numbered list, no section → [] | jspace |
| `accept-proposal` with unknown id | tool-jspace |
| Goal change keeps charter, resets Checked | jspace seat |
| Amend drop last check under `requireExecutableCharter` | tool-jspace |
| `always-open` + `requireCharter` throws at apply | tool-jspace loader-composition |
| Nested execute uses `parent` token; deny from pre-execute surfaces as named refusal | tool-jspace e2e with a denying listener |
| HMR dispose unregisters `jspace_charter_amend` | tool-jspace |
| Fold: missing `charter` field → `[]` | jspace |
| Invariant: charter-run without parent call | tool-jspace invariant spec |

Do not mock `ctx.tools.execute` for the nested-bash tests; register real `tool-bash` + local shell (existing `makeBridgeHarness({ withBash: true })` pattern). Mock only the model.

### 11.2 Snapshot (required — assembled transcript)

Extend `examples/headless-agent` (existing `jspace-tools` scenario). Package tests do not replace this.

New scenario `jspace-charter` (scripted replay, keyless):

1. User message contains a two-rule “House rules” list (one grep-able, one prose).
2. Overlay: `requireCharter`, `charterSeed`, `charterDiscrimination: 'required'`.
3. Replay `jspace_open` with `kind: accept-proposal`.
4. Assert log: `jspace/charter-proposal`, `jspace/charter-probe`, `jspace/card` with `charter.length >= 1`, request header contains `jspace:charter-seed` **before** open and not after.
5. Replay `jspace_checkpoint`; fixture workspace includes a violating file so the check fails; assert tool result text names `entry` id and `fix:`.
6. Second replay path (or second scenario): workspace satisfies the check; checkpoint writes `verified` Checked line; `jspace_ship` passes.

Wire through the same `runLoaderSmoke` + `SHRES_SNAPSHOT=replay` path as `jspace-tools`. If the headless example’s cordis.yml needs `tool-bash` already (it should), discrimination hits a real shell.

ACP scenario under `examples/acp-agent` is deferred if keyless headless already pins the refusals and seed section; the tool-jspace README currently admits no ACP pin for constraint-capture — do not grow that debt for charter if headless covers the transcript.

### 11.3 Bench

`node --test bench/tests/runner.test.js` for the new arm overlay YAML. No live w9 in this design PR.

## 12. Implementation sequence (for the implementing PR)

1. Types + fold + seat `amendCharter` + events + catalog regen.
2. Floor + discriminate as pure functions with unit tests (no Cordis).
3. Nested `runCharter` helper + checkpoint/ship/open wiring.
4. `jspace_charter_amend` + schemas + driver copy.
5. Seed extract + pre-step + prompt section.
6. Headless snapshot + arm overlay.
7. Agent Note (implementation PR), README Model Experience, `docs/subsystems/jspace.md` type-equiv blocks.

## 13. Open questions

1. **Qty (and similar) checks that regex cannot express honestly.** Should w9’s task fixture ship `tools/check-house-rules.mjs`, or is a model-authored command the thing we want to measure? This design prefers the fixture helper so discrimination tests the real rule; that also means the seeder, not the model, supplies the only check that would have caught w7. If the experiment must price *model-authored* checks, drop templates and seed prose only — likely higher gaming, cleaner attribution of “can the model write a discriminating check”.
2. **`ctx.fs` for probe snapshot vs bash `cat`.** Seat/tool-jspace may not inject `fs` today. Using `fs` for restore is the correct exclusive write path; compositions without `ctx.fs` cannot discriminate. Fail loud at first probe if `ctx.get('fs')` is missing and discrimination is `'required'`. Confirm every w9 / headless composition mounts an fs provider (base profile does).
3. **Code Mode.** Nested bash with `parent` is allowed under `mode: 'code'`; model-direct `jspace_checkpoint` is not. Is the charter arm native-only? Bench headless is native. Document Code Mode as unsupported for charter until a `run_code` binding path is proven.
4. **Approval UX.** N checks × checkpoint × ship may equal many approval prompts in `approval: 'untrusted'` sessions. Inherit-policy is correct for the sandbox promise; a single “allow charter checks this session” preset is product work, not Phase 1.
5. **Parallel charter runs.** Sequential is specified. Large charters + `charterCheckTimeoutMs` 30s could blow a turn. Cap concurrent runs? Not in v1; `maxCharterEntries` 12 × 30s is a theoretical 6 min — real greps are short. Revisit if w9 wall-time blows up.
6. **Whether `jspace_checkpoint` without a charter should remain legal when `requireCharter` is off but a previous amend registered checks.** This design says presence implies execution (always re-run if non-empty). Confirm that is wanted for mixed deployments.
7. **Glob expansion owner.** Node `fs.glob` vs bash `compgen` vs a tiny matcher. Must be deterministic on macOS/Linux (snapshot fixtures). Recommend `fs.glob` from the Node version the repo already requires, resolved against cwd, not bash glob (shell options differ).
8. **Fingerprint skip.** Explicitly out of v1; listed so a later PR does not “optimize” by skipping ship re-run without a new decision.
9. **Second w9 task** (“constraints its own test suite cannot see”) is required by the plan for a default flip but is not specified here beyond “add one”. Needs its own task author; do not overload `constraint-survival-build` as that second task — it already is that task, so the “plus one” is a different domain so the result is not a single-task artifact.
10. **Power analysis n** is not computed here. Do not hardcode 16 from w8. The implementing eval run owns the analysis.
11. **`accept-proposal` plus extra `kind: check` in one open.** Allowed (union then discriminate all). Order: expand accepts, then append adds. Confirm no id collisions with `e1` assignment.
12. **Windows.** Floor comment-strip and tautology list are bash-shaped. Bench fixtures must replay on macOS/Linux (`docs/testing.md`). pwsh charter runner is deferred; `on-charter` is not in the Windows-wine gate’s critical path.

## 14. Non-goals and rejected moves

- **Runtime heuristic for “this task has constraints.”** Rejected in the plan; enablement is the arm overlay.
- **Privileged `ctx.shell.run` from jspace.** Rejected; nested `ctx.tools.execute('bash')` only.
- **Deleting Core.** Core stays capacity; charter is the contract.
- **Making `jspace_ship` close the card.** Still wrong (close-hygiene note).
- **Proving constraint↔check alignment in the executor.** Infeasible without a second model or a constraint DSL; unverified marker + w9 are the honest remainder.
- **`delete` failProbe.** Would credit `test -f` / `ls` as discriminating.
