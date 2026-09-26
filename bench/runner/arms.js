/**
 * Arm registry: the measured interventions. An arm is a name plus the exact
 * jspace seat and tool-jspace plugin config it applies and whether the overlay
 * mounts the model-facing session-query tool.
 *
 * The runner spawns the bundle profile (`shres --profile headless`), where
 * `jspace` ships mounted with `enabled: false` and `tool-session-query` is
 * not mounted at all; the shipped `session-query-sqlite` service stays for
 * internal reads with `openAt: never`. Session-query arms therefore insert
 * `tool-session-query` and open the per-trial SQLite index at startup; the
 * other arms need no disable rows because the tool is absent from the
 * profile.
 *
 * The nine-arm ladder covers every jspace/session-query contrast:
 *
 * | Arm | Configuration |
 * |---|---|
 * | `off` | Control: jspace disabled, no session-query tool. |
 * | `on` | J-Space available, no session-query tool. |
 * | `sq-only` | Session-query tool mounted, jspace disabled. |
 * | `sq-driver` | sq-only plus one system-prompt driver line naming the session-query tools. |
 * | `on-sq` | J-Space available + session-query tool. |
 * | `on-sq-verified` | on-sq + verifierTools naming `bash` + requireVerifiedEvidence. |
 * | `on-adaptive` | on-sq with `engageAfterSteps: 10`: J-Space costs nothing until step 10. |
 * | `on-core` | on + `requireCoreOnOpen` and `requireCoreForShip`: the card must carry constraints. |
 * | `on-charter` | on + tool-jspace executable charter required, seeded, and discrimination-gated. |
 *
 * OOLONG-lite (WP3.3) adds three corpus-contrast arms. `code` vs `read` is the
 * kernel-necessity contrast; `read` vs `stuffed` is the retrieval contrast.
 * `stuffed` refuses a forced-compaction overlay (the runner fails argv
 * validation): compaction would destroy the whole-corpus-in-the-prompt
 * condition.
 *
 * | Arm | Configuration |
 * |---|---|
 * | `stuffed` | Corpus inlined in the instruction; jspace off; session-query absent. |
 * | `read` | Corpus on disk; session-query mounted; jspace off. |
 * | `code` | `read` plus `tools.mode: both` (headless already inserts `code-runtime`). |
 *
 * The researcher ladder (WP-research) measures the research-protocol experiment
 * surface: tracker + ledger + tool-tracker/tool-ledger + the three debate seats
 * (aegis/ward fork one-shot, stride spawn continuable), with the research
 * protocol gate off (inert), on-but-defense-off (lite), or per-epoch enforced
 * with jspace verifier evidence (on). The base headless composition mounts none
 * of the researcher rows, so the overlay inserts them fresh, mirroring how the
 * session-query arms insert `tool-session-query`.
 *
 * | Arm | Configuration |
 * |---|---|
 * | `research-inert` | Researcher surface mounted, protocol `enabled: false`; jspace untouched (disabled). |
 * | `research-lite` | Same + protocol `enabled: true, requireDesignDefense: 'off'`. |
 * | `research-on` | Same + `requireDesignDefense: 'per-epoch'`, jspace `verifierTools` + `requireVerifiedEvidence`. |
 *
 * The Jev ladder (PR4) measures judgment-backed routing and compaction in two
 * paired contrasts. The three packages are inserted, never patched, because the
 * base headless composition mounts none of them. Routing is priced against the
 * same pinned manual route; compaction against the same forced-compaction
 * posture, which the arms restate as one whole config because the profile
 * default never fires on the catalog's turn counts. Each arm's treatment rows
 * live in a pinned overlay — `bench/routing/` for the routing pair, the
 * `bench/pressure/forced-compaction.patch.yml` posture for the compaction
 * baseline, and `bench/compaction/jev.patch.yml` for the treatment — and
 * `ArmEntry.pinnedOverlay` names it for the renderer, which emits it verbatim.
 * The pinned file is therefore not a copy of the arm but the arm's own rows.
 *
 * | Arm | Configuration |
 * |---|---|
 * | `route-off` | Control: strong manual route pinned, neither the judgment engine nor the router mounted. |
 * | `route-on` | Same tree + judgment engine and router, `initialMode: 'on'`, one candidate (the weak route). |
 * | `route-shield` | Opt-in route-on composition using the owned loopback Shield gateway and its pinned local model artifact. |
 * | `compact-basic` | Control: `compaction-basic` restating the forced-compaction posture. |
 * | `compact-jev` | Same posture with `compaction-basic` disabled and the jev backend inserted beside the judgment engine. |
 *
 * @module bench/runner/arms
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {object} ArmEntry
 * @property {string} name - arm identifier.
 * @property {Record<string, unknown>} jspace - jspace seat config for the --patch overlay.
 * @property {Record<string, unknown>} [toolJspace] - tool-jspace config for the --patch overlay; omitted leaves the profile default.
 * @property {boolean} sessionQuery - whether the overlay mounts the model-facing session-query tool.
 * @property {boolean} expectsSessionQuery - whether session-query tools are expected in logs.
 * @property {boolean} expectsJspace - whether jspace events are permitted in logs.
 * @property {boolean} [driverLine] - whether the overlay appends the session-query driver line to the headless persona.
 * @property {boolean} [stuffed] - whether the runner must use `stuffedInstruction` / the stuffed arm template; refuses forced-compaction.
 * @property {boolean} [codeMode] - whether the overlay patches `tools.mode` to `both` (stateless `run_code`).
 * @property {boolean} [optIn] - whether the arm is excluded from the default arm list and must be named explicitly.
 * @property {Record<string, unknown> | undefined} [researcher] - research-protocol config; when present the overlay mounts
 *   the researcher surface (protocol, tracker, ledger, tools, debate seats) and the arm expects researcher metrics.
 * @property {boolean} [expectsResearcher] - whether researcher metrics are expected (non-null) in trial logs.
 * @property {string} [pinnedOverlay] - bench-relative path of the arm's pinned treatment overlay: `renderArmOverlay`
 *   reads the file and emits its content verbatim, so the file is the single source of that arm's rows.
 * @property {string} [judgmentKeyEnv] - credential environment variable the arm's judgment engine resolves through
 *   the credentials seam. The runner resolves it exactly like `--api-key-env` (exported value first, else the
 *   harness store) but tolerates absence: the consumers' documented degradation is not a usage error.
 * @property {string} [apiKeyEnv] - credential environment variable the arm's own base route dials. The runner
 *   resolves it exactly like `--api-key-env` and treats absence as a usage error, because the arm's base route
 *   is its core condition rather than an optional engine.
 * @property {boolean} [expectsModelRouting] - whether every session with at least one turn must log at least one
 *   `model-routing/decision` event (routing adoption).
 * @property {boolean} [expectsCompactionVerification] - whether every session that compacted must log at least one
 *   `compaction/verification` event (verification adoption).
 */

/** Headless profile persona restated when a driver-line overlay replaces `system-prompt` config. */
export const HEADLESS_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'

/**
 * Extra system-prompt paragraph for `sq-driver`: names the session-query tools
 * at the moment a prior-session fact is needed. The stock tool guidance does
 * not mention a prior session.
 */
export const SESSION_QUERY_DRIVER_LINE = 'The previous session in this workspace recorded a decision this task needs. Look it up with session_search or session_event_search, then session_event_read the matching event; do not guess the recorded value.'

/** The bench directory: the root an arm's pinned-overlay path resolves against. */
const BENCH_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Read one arm's pinned treatment overlay. The file holds the arm's non-shared
 * rows and the renderer emits it verbatim, so the pinned posture is the single
 * source of the measured composition; a missing or unreadable pin fails loud
 * instead of rendering a baseline the arm never chose.
 * @param {string} pinnedOverlay - bench-relative path from the arm entry.
 * @returns {string} the pinned document, without its trailing newline.
 */
function readPinnedOverlay(pinnedOverlay) {
  try {
    return readFileSync(join(BENCH_ROOT, pinnedOverlay), 'utf8').trimEnd()
  } catch (error) {
    throw new Error(`arm pinned overlay ${pinnedOverlay} is unreadable: ${/** @type {Error} */ (error).message}`)
  }
}

/**
 * Registered arms, in run order. `off` is the baseline every comparison is
 * against and always runs first in the interleave.
 * @type {Readonly<Record<string, Readonly<ArmEntry>>>}
 */
export const ARMS = Object.freeze({
  off: Object.freeze({
    name: 'off',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
  }),
  on: Object.freeze({
    name: 'on',
    jspace: Object.freeze({ enabled: true, mode: 'available', requireCoverage: true }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: true,
  }),
  'sq-only': Object.freeze({
    name: 'sq-only',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: false,
  }),
  // Identical to `sq-only` plus one persona paragraph naming the session-query
  // tools. The session-query-adoption task is the contrast this arm exists for.
  'sq-driver': Object.freeze({
    name: 'sq-driver',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: false,
    driverLine: true,
  }),
  'on-sq': Object.freeze({
    name: 'on-sq',
    jspace: Object.freeze({ enabled: true, mode: 'available', requireCoverage: true }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: true,
  }),
  'on-sq-verified': Object.freeze({
    name: 'on-sq-verified',
    jspace: Object.freeze({
      enabled: true,
      mode: 'available',
      requireCoverage: true,
      verifierTools: ['bash'],
      requireVerifiedEvidence: true,
    }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: true,
  }),
  // `expectsJspace` only licenses jspace events; the integrity audit checks
  // absence for arms that exclude jspace and never asserts presence. A short
  // task that never reaches step 10 therefore logs no jspace event and no
  // violation, which is exactly the behavior this arm measures.
  'on-adaptive': Object.freeze({
    name: 'on-adaptive',
    jspace: Object.freeze({
      enabled: true,
      mode: 'available',
      requireCoverage: true,
      engageAfterSteps: 10,
    }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: true,
  }),
  // Contrast against `on`, not `on-sq`: w6/w7 measured the empty-Core failure
  // on the card alone, so the constraint-capture gates are priced against the
  // same composition that produced the finding.
  'on-core': Object.freeze({
    name: 'on-core',
    jspace: Object.freeze({ enabled: true, mode: 'available', requireCoverage: true }),
    toolJspace: Object.freeze({ requireCoreOnOpen: true, requireCoreForShip: true }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: true,
  }),
  // Contrast against `off` (w9). Seat stays `available` because tool-jspace
  // `requireCharter` refuses `always-open`. Keys match tool-jspace Config.
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
  stuffed: Object.freeze({
    name: 'stuffed',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    stuffed: true,
  }),
  read: Object.freeze({
    name: 'read',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: false,
  }),
  code: Object.freeze({
    name: 'code',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    sessionQuery: true,
    expectsSessionQuery: true,
    expectsJspace: false,
    codeMode: true,
  }),
  // Researcher ladder. `research-inert` and `research-lite` leave jspace
  // disabled (the base profile already mounts it off); `research-on` enables
  // it with verifier evidence so a checkpoint can cite an
  // `experiment_verify_decision_rule` result. All three mount the same
  // researcher surface; the protocol gate and jspace posture differ.
  'research-inert': Object.freeze({
    name: 'research-inert',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    researcher: Object.freeze({ enabled: false }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsResearcher: true,
  }),
  'research-lite': Object.freeze({
    name: 'research-lite',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    researcher: Object.freeze({ enabled: true, requireDesignDefense: 'off' }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsResearcher: true,
  }),
  // on-sq-verified pattern for the verifier extras: jspace verifierTools names
  // the tools whose completed calls count as verified checkpoint evidence, and
  // requireVerifiedEvidence holds checkpoints to that standard. The researcher
  // protocol's default `requireDesignDefense: 'per-epoch'` is restated.
  'research-on': Object.freeze({
    name: 'research-on',
    jspace: Object.freeze({
      enabled: true,
      mode: 'available',
      requireCoverage: true,
      verifierTools: ['bash', 'experiment_verify_decision_rule'],
      requireVerifiedEvidence: true,
    }),
    researcher: Object.freeze({ enabled: true, requireDesignDefense: 'per-epoch' }),
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: true,
    expectsResearcher: true,
  }),
  // Jev ladder (PR4). Each arm's treatment rows are pinned on disk and the
  // renderer emits that file verbatim, so the pinned posture is the single
  // source of the measured composition. The routing pair pins its own route in
  // `bench/routing/`; the compaction baseline reads the forced-compaction
  // posture file itself, and the jev arm's file restates that posture beside
  // its judgment fields because a `config` patch replaces a whole config.
  'route-off': Object.freeze({
    name: 'route-off',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    pinnedOverlay: 'routing/route-off.patch.yml',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
  }),
  'route-on': Object.freeze({
    name: 'route-on',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    pinnedOverlay: 'routing/route-on.patch.yml',
    judgmentKeyEnv: 'TYPESAFE_API_KEY',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsModelRouting: true,
  }),
  'route-shield': Object.freeze({
    name: 'route-shield',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/route-shield.patch.yml',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsModelRouting: true,
  }),
  'compact-basic': Object.freeze({
    name: 'compact-basic',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    pinnedOverlay: 'pressure/forced-compaction.patch.yml',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
  }),
  'compact-jev': Object.freeze({
    name: 'compact-jev',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    pinnedOverlay: 'compaction/jev.patch.yml',
    judgmentKeyEnv: 'TYPESAFE_API_KEY',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsCompactionVerification: true,
  }),
  // Routing-measurement ladder (PR 16). All five arms are opt-in: a level's
  // run names its arms explicitly (prereg §8), and the default ladder must not
  // grow arms that require an Anthropic key. Each arm's treatment rows are
  // pinned in bench/routing/ and emitted verbatim. The strong arms each name
  // their own metered Anthropic key variable (prereg §3 cache isolation); the
  // runner resolves it like --api-key-env and fails the launch of a selected
  // arm when that variable resolves to nothing, because the strong route is
  // the arm's core condition. route-coldpoint and route-random additionally
  // depend on PR 12 and route-static on PR 13b: their pinned overlays pin
  // config fields those PRs introduce, and the harness refuses them, by name,
  // until the integrating branch carries both.
  'route-strong': Object.freeze({
    name: 'route-strong',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/route-strong.patch.yml',
    apiKeyEnv: 'ANTHROPIC_API_KEY_S',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
  }),
  'route-cheap': Object.freeze({
    name: 'route-cheap',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/route-cheap.patch.yml',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
  }),
  'route-coldpoint': Object.freeze({
    name: 'route-coldpoint',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/route-coldpoint.patch.yml',
    apiKeyEnv: 'ANTHROPIC_API_KEY_R',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsModelRouting: true,
  }),
  'route-random': Object.freeze({
    name: 'route-random',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/random-matched.patch.yml',
    apiKeyEnv: 'ANTHROPIC_API_KEY_N',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsModelRouting: true,
  }),
  'route-static': Object.freeze({
    name: 'route-static',
    jspace: Object.freeze({ enabled: false, mode: 'available', requireCoverage: true }),
    optIn: true,
    pinnedOverlay: 'routing/static-tier.patch.yml',
    apiKeyEnv: 'ANTHROPIC_API_KEY_T',
    sessionQuery: false,
    expectsSessionQuery: false,
    expectsJspace: false,
    expectsModelRouting: true,
  }),
})

/**
 * List registered arm names in run order.
 * @returns {string[]} arm names; `off` first.
 */
export function listArms() {
  return Object.keys(ARMS)
}

/**
 * List arms selected when `--arms` is omitted. Explicit opt-in arms stay
 * available to CLI validation without requiring their external service for
 * ordinary runs.
 * @returns {string[]} default arm names in registry order.
 */
export function listDefaultArms() {
  return listArms().filter(name => ARMS[name].optIn !== true)
}

/**
 * Look up one arm by name. Unknown names fail loud with the valid set.
 * @param {string} name - arm name from `--arms`.
 * @returns {ArmEntry} the arm entry.
 */
export function getArm(name) {
  const arm = ARMS[name]
  if (!arm) throw new Error(`unknown arm "${name}" (registered: ${listArms().join(', ')})`)
  return arm
}

/**
 * Render one plugin entry's config rows. Strings are JSON-quoted, which is
 * valid YAML.
 * @param {Record<string, unknown>} config - config keys for the entry.
 * @returns {string} indented YAML rows.
 */
function configRows(config) {
  return Object.entries(config)
    .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)
    .join('\n')
}

/**
 * Render one nested entry's config rows: the indentation a `config:` key inside
 * an `- insert:` layer needs.
 * @param {Record<string, unknown>} config - config keys for the entry.
 * @returns {string} rows indented under the nested `config:` key.
 */
function nestedConfigRows(config) {
  return configRows(config).split('\n').map(row => `    ${row}`).join('\n')
}

/**
 * Render the `--patch` overlay for one trial. Besides the jspace toggle, the
 * overlay redirects session persistence into a per-trial root with
 * `compression: none` so the runner can locate and line-read the log without
 * the zstd codec. An arm carrying `toolJspace` patches the separately mounted
 * `tool-jspace` entry, which owns the constraint-capture requirements.
 * Session-query arms additionally open the per-trial SQLite index at startup
 * and insert the model-facing `tool-session-query` entry, which the bundle
 * profile does not mount. A `driverLine` arm restates the headless persona
 * plus one paragraph naming the session-query tools (`system-prompt` config
 * replace is wholesale). A researcher arm inserts the whole experiment-tracking
 * surface — research-protocol, tracker (spool-only, per-trial spool/index),
 * ledger (per-trial store), their tool packages, and the aegis/ward/stride
 * debate seats — with persistence redirected into the per-trial root exactly
 * like the session-persistence redirect. An arm carrying `pinnedOverlay` emits that
 * file's content verbatim into the document — the Jev arms' treatment rows, which
 * pin the routing arms' manual route and insert the judgment engine and its
 * consumer (router or jev backend) because the base composition mounts none of them.
 * @param {ArmEntry} arm - arm entry from {@link getArm}.
 * @param {{ sessionLogRoot: string, pinnedBody?: string }} options - absolute per-trial persistence
 *   root; `pinnedBody` replaces the committed pinned file's content when a confirmatory run adopts
 *   the replay writer's generated overlay.
 * @returns {string} the overlay YAML document.
 */
export function renderArmOverlay(arm, { sessionLogRoot, pinnedBody }) {
  let overlay = `# Generated by bench/runner for arm "${arm.name}". Applied as \`shres --patch\`.
- id: jspace
  config:
${configRows(arm.jspace)}
- id: session-persistence-jsonl
  config:
    root: ${JSON.stringify(sessionLogRoot)}
    compression: none
`
  if (arm.toolJspace) {
    overlay += `- id: tool-jspace
  config:
${configRows(arm.toolJspace)}
`
  }
  if (arm.driverLine) {
    overlay += `- id: system-prompt
  config:
    persona: ${JSON.stringify(`${HEADLESS_PERSONA}\n\n${SESSION_QUERY_DRIVER_LINE}`)}
`
  }
  if (arm.sessionQuery) {
    overlay += `- id: session-query-sqlite
  config:
    path: ${JSON.stringify(join(sessionLogRoot, 'session-query.db'))}
    openAt: startup
- insert:
    - id: tool-session-query
      name: "@shres-code/shres-code-tool-session-query"
`
  }
  // The headless profile already inserts `code-runtime`. Re-inserting it fails
  // load with `duplicate loader entry id`. `tools.mode: both` is the arm's
  // intervention: native tools stay on the wire and `run_code` is added.
  if (arm.codeMode) {
    overlay += `- id: tools
  config:
    mode: "both"
`
  }
  // A Jev arm's treatment rows are pinned on disk and emitted verbatim, so the
  // pinned file is the single source of what the arm measured; its own header
  // carries the insert-not-patch contract and the frozen operating points.
  if (arm.pinnedOverlay) {
    // A confirmatory run adopts the replay writer's generated overlay for the
    // arm (bench/runner/run.js --confirmatory-overlays): the body passed here
    // replaces the committed provisional file as the single rendered source.
    overlay += `${pinnedBody ?? readPinnedOverlay(arm.pinnedOverlay)}
`
  }
  if (arm.researcher) {
    // research-protocol must be INSERTED, not patched: the base headless
    // composition does not mount it, and a patch against a missing entry
    // no-ops silently — the plugin would never load and the gate would
    // never arm (found by the researcher-smoke real-spawn trial).
    overlay += `- insert:
    - id: research-protocol
      name: "@shres-code/shres-code-research-protocol"
      config:
${nestedConfigRows(arm.researcher)}
    - id: tracker-shrestech
      name: "@shres-code/shres-code-tracker-shrestech"
      config:
        baseUrl: "https://tracker.invalid"
        lane: "bench"
        spoolPath: ${JSON.stringify(join(sessionLogRoot, 'research-spool.jsonl'))}
        indexPath: ${JSON.stringify(join(sessionLogRoot, 'research-spool.landed.jsonl'))}
    - id: tool-tracker
      name: "@shres-code/shres-code-tool-tracker"
    - id: ledger
      name: "@shres-code/shres-code-ledger"
      config:
        storagePath: ${JSON.stringify(join(sessionLogRoot, 'research-ledger.jsonl'))}
    - id: tool-ledger
      name: "@shres-code/shres-code-tool-ledger"
    - id: tool-subagent-aegis
      name: "@shres-code/shres-code-tool-subagent"
      config:
        provider: fork
        toolName: aegis
        backgroundMode: one-shot
    - id: tool-subagent-ward
      name: "@shres-code/shres-code-tool-subagent"
      config:
        provider: fork
        toolName: ward
        backgroundMode: one-shot
    - id: tool-subagent-stride
      name: "@shres-code/shres-code-tool-subagent"
      config:
        provider: spawn
        toolName: stride
        backgroundMode: continuable
`
  }
  return overlay
}
