# @shres-code/shres-code-host-plugin-admin

Gesture-gated Remote namespace (`pluginAdmin`) over the shared plugin and skill install core. It is the web Manage surface's only mutation path for the profile the host booted: plugin install with a parked consent transaction, plugin removal, and skill add/remove. The namespace consumes [app-boot](../../boot/app-boot) and [skill-filesystem/install](../../skill/skill-filesystem) — it implements no pnpm, journaling, or skill-copy logic of its own.

The row lives in the web-app bundle patch. Plugin mutations operate only on the profile directory in the `profileRuntime` service a launcher provides before any entry mounts; the namespace never accepts a profile name from the wire. The service is optional. When it is absent (a raw Web composition) or reports `pluginMutations: 'unsupported'` (the packaged desktop, which has no executable plugin-install owner), `status()` reports `mutations: 'unsupported'`, and `stageInstall` and `removePlugin` answer `{ kind: 'unsupported' }` without touching anything. Skill add and remove work in every composition because they only touch the shared `$SHRES_HOME/skills-installed` root.

## Wire contract

- `status()` — `{ mutations, plugins, skills, parked? }`: the mutation scope (`enabled` or `unsupported`), every profile plugin with its restart readiness (`active`, `installed-restart-required`, `removed-restart-required`; empty without a profile runtime), every user-installed skill with `shadowedBy` when a higher-precedence same-named skill is live in the registry's global snapshot, and the one parked transaction's preview.
- `begin({ verb, target })` — mints a one-shot gesture token bound to the verb and target (`install` + spec, `remove` + package name, `skill-add` + source path, `skill-remove` + skill name), valid for the fixed 120 s gesture window.
- `stageInstall({ token, spec })` — spends the token, runs the shared core (recovery, lock, journal, `pnpm add --ignore-scripts`, classification, preview), and parks the transaction. Answers `{ kind: 'parked', transactionId, preview, confirmToken }`, `{ kind: 'refused', refusal, rollback }` with the core's refusal (including `pnpm-not-found`, `link-spec`, `unsupported-platform`, and `unsupported-layout`), or `{ kind: 'unsupported' }`. A relative local spec (`.`, `..`, `~`, with or without `file:`/`link:`) is refused as caller misuse, because the wire has no invoking directory; pass an absolute directory. At most one install transaction exists at a time; the slot is reserved synchronously so interleaved installs cannot both reach the core, and `removePlugin` is refused while the slot is taken instead of waiting on the profile lock.
- `confirm({ token })` / `cancel({ token })` — settle the parked transaction with its confirm token. A token that does not match leaves the transaction parked; once a settle starts (confirm, cancel, expiry, or disposal), every further settle is refused. Confirm answers the flat receipt `{ kind: 'committed', name, version, readiness }` or `{ kind: 'refused', refusal, rollback }` after the composition check, the bundles commit, and journal deletion; cancel restores the manifest and lockfile and reports the rollback.
- `removePlugin({ token, name })`, `skillAdd({ token, path })`, `skillRemove({ token, name })` — the shared core's direct results.
- `skillAdd` additionally refuses, host-side, a name a runtime or bundled skill already owns (the live catalog is visible only here); the filesystem roots are checked by the shared core itself. Installed skills rank lowest (700), so any same-named skill shadows them, and `status()` reports that as `shadowedBy`.

Tokens and transaction ids are branded opaque strings (`PluginGestureToken`, `PluginConfirmToken`, `PluginTransactionId`). Caller misuse crosses the wire as the carrier's generic message envelope: `ProfilePluginError` (lock timeout, pending transaction, failed restore) and `PluginAdminError` (gesture refused, relative install spec, transaction pending, no parked transaction, confirm mismatch). Expected business outcomes are outcome data, never errors.

## Confirmation window

A parked transaction auto-cancels when `confirmTtlMs` (a validated config field changeable from cordis.yml, default 120 000 ms) expires, unless a settle already started. On disposal the namespace aborts every outstanding core operation and an install that is still beginning, rolls back a parked transaction that is not settling, awaits an in-flight settle rather than starting a second one, and awaits all of them. Failures during disposal are logged, not re-raised, and a crash while parked is covered by the core's transaction journal recovery on the next invocation.

## What the gesture gate proves

The tokens prove a begin→spend sequence scoped to one verb and target, from a loopback peer, single use: a replayed request, a wrong verb or target, and a non-loopback caller are refused. The whole namespace is also pinned to loopback through the client-connection `PRIVILEGED_METHODS` set. The tokens do **not** prove a human gesture against any same-user process that can reach loopback, including a model shell tool whose sandbox permits loopback network access; also not prevented: page script in the same trusted origin, same-user malware, and the existing self-modification capability. The namespace registers no tools and writes no session events, so no model-facing path reaches these methods.

## Model Experience

Indirectly, through the [skill consumer](../../skill/tool-skill/README.md) after a skill changes and through plugins activated at the next profile boot; this loopback administration namespace contributes no tools, prompt sections, or session events of its own.

#### KV Cache effect

The gateway contributes no model messages directly. An installed skill can change the next durable skill catalog through the filesystem provider and skill consumer, replacing that catalog’s cached prompt prefix.

## Known Limitations and Deferred Work

- The packaged desktop has no executable plugin-install owner: its plugin-management IPC always throws and nothing constructs a desktop pnpm manager, so it provides `pluginMutations: 'unsupported'`. Enabling desktop plugin installs needs a runtime owner for the desktop profile, its pnpm, and its lock first.
- The composition check behind `confirm` proves only that the candidate patches compose; it does not prove the module imports or that `apply()` succeeds.
- `shadowedBy` and the runtime name-taken refusal require a mounted skills registry; a composition without one reports installed rows without shadowing facts and relies on the core's filesystem checks alone.
