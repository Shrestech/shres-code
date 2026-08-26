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
 * @module bench/runner/arms
 */

import { join } from 'node:path'

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
 */

/** Headless profile persona restated when a driver-line overlay replaces `system-prompt` config. */
export const HEADLESS_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'

/**
 * Extra system-prompt paragraph for `sq-driver`: names the session-query tools
 * at the moment a prior-session fact is needed. The stock tool guidance does
 * not mention a prior session.
 */
export const SESSION_QUERY_DRIVER_LINE = 'The previous session in this workspace recorded a decision this task needs. Look it up with session_search or session_event_search, then session_event_read the matching event; do not guess the recorded value.'

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
})

/**
 * List registered arm names in run order.
 * @returns {string[]} arm names; `off` first.
 */
export function listArms() {
  return Object.keys(ARMS)
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
 * Render the `--patch` overlay for one trial. Besides the jspace toggle, the
 * overlay redirects session persistence into a per-trial root with
 * `compression: none` so the runner can locate and line-read the log without
 * the zstd codec. An arm carrying `toolJspace` patches the separately mounted
 * `tool-jspace` entry, which owns the constraint-capture requirements.
 * Session-query arms additionally open the per-trial SQLite index at startup
 * and insert the model-facing `tool-session-query` entry, which the bundle
 * profile does not mount. A `driverLine` arm restates the headless persona
 * plus one paragraph naming the session-query tools (`system-prompt` config
 * replace is wholesale).
 * @param {ArmEntry} arm - arm entry from {@link getArm}.
 * @param {{ sessionLogRoot: string }} options - absolute per-trial persistence root.
 * @returns {string} the overlay YAML document.
 */
export function renderArmOverlay(arm, { sessionLogRoot }) {
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
  return overlay
}
