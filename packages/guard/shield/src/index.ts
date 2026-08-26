/**
 * Default-on host seat for the paid Shres Shield plugin. Resolves the engine
 * from a sibling checkout, the active profile's installed payload, or
 * `@shrestech/shres-shield-plugin`, checks entitlement, and publishes
 * `ctx.shield`. The detection payload never lives in this package.
 * Integration contract: sibling shres-shield repository, integration-shres-code.md.
 * @module @shres-code/shres-code-shield
 */

import { fileURLToPath } from 'node:url'
import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { SessionId } from '@shres-code/shres-code-session'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { resolveShieldEngine } from './resolve.ts'
import {
  liveSessionCwds, repoDisabled, repoGateBlocksMount, resolveRepoPath,
  validateRepoKeys, type ShieldRepos,
} from './repos.ts'
import type {
  ShieldCounterSplit, ShieldDefinitions, ShieldEngineSource, ShieldFindingSummary,
  ShieldReason, ShieldRepoStats, ShieldRuleHistogram, ShieldSnapshot, ShieldStatus,
} from './types.ts'

export type {
  ShieldCounterSplit, ShieldDecision, ShieldDefinitions, ShieldEngine, ShieldEngineApply,
  ShieldEngineSource, ShieldFindingSummary, ShieldInactiveReason, ShieldReason,
  ShieldRepoStats, ShieldRuleHistogram, ShieldSnapshot, ShieldStatus,
} from './types.ts'
export {
  PAYLOAD_SPECIFIER, repoRootFromSeat, resolveProfileSpecifier, resolveShieldEngine,
  siblingPluginPath, type ShieldResolveOptions,
} from './resolve.ts'
export {
  liveSessionCwds, repoDisabled, repoGateBlocksMount, resolveRepoPath, validateRepoKeys,
  type ShieldRepoEntry, type ShieldRepos, type SessionCwdSource,
} from './repos.ts'
/** Cordis plugin name used by loader diagnostics. */
export const name = 'shres-shield'

/**
 * Doctrine and tool seams need `systemPrompt` and `tools`. Approval and jobs
 * are listed so the payload adapter can probe `ctx.approval` / `ctx.jobs`
 * without throw-as-absent. A composition that never provides them keeps the
 * seat pending; product rows always mount both.
 */
export const inject = ['systemPrompt', 'tools', 'approval', 'jobs']

/**
 * Temporary default license until a paid key exists. A non-empty value
 * entitles any resolved payload. `SHRES_SHIELD_LICENSE` still overrides it.
 */
export const DEFAULT_SHIELD_LICENSE = 'shres-dev'

/** Host-seat config. Engine-owned tunables stay on `@shrestech/shres-shield-plugin`. */
export interface Config {
  /**
   * Entitlement string. Defaults to {@link DEFAULT_SHIELD_LICENSE} until a
   * paid key exists. `SHRES_SHIELD_LICENSE` overrides this field. A sibling
   * `../shres-shield` checkout is also entitled without a key.
   */
  license?: string
  /**
   * User switch on the Shield settings page. Default true. False unloads the
   * payload without the panic env. `SHRES_SHIELD=off` still wins. The master
   * control: a `repos` entry cannot re-enable under it.
   */
  enabled?: boolean
  /**
   * Per-repo carve-outs. Keys are absolute repo paths; an entry with
   * `enabled: false` keeps Shield off for sessions working in that repo while
   * the global switch stays on. Stored in the host-owned settings document —
   * a repo under audit never authors its own exemption.
   */
  repos?: ShieldRepos
  /** Forwarded to the paid plugin. Default `ask`. */
  posture?: 'observe' | 'ask' | 'enforce'
}

export const Config: z<Config> = z.object({
  license: z.string().default(DEFAULT_SHIELD_LICENSE),
  enabled: z.boolean().default(true),
  repos: z.dict(z.object({ enabled: z.boolean() })).default({}),
  posture: z.union(['observe', 'ask', 'enforce'] as const).default('ask'),
})

/** Settings namespace the Shield Settings page writes. */
export const SHIELD_SETTINGS_NAMESPACE = settingsNamespace('shres-shield')

declare module '@shres-code/cordis' {
  interface Context {
    shield: ShieldHost
  }
}

const EMPTY_SPLIT: ShieldCounterSplit = {
  screened: 0,
  observed: 0,
  asked: 0,
  askedGranted: 0,
  askedDenied: 0,
  blocked: 0,
}

const EMPTY_HISTOGRAM: ShieldRuleHistogram = { observed: 0, asked: 0, blocked: 0 }

/**
 * Zeroed per-repo stats used when the engine has not reported any counts.
 * @param cwd - session workspace realpath, or `null` when none is known.
 * @returns a fresh stats object the pane can render.
 */
export function emptyRepoStats(cwd: string | null): ShieldRepoStats {
  return { cwd, ...EMPTY_SPLIT, byChannel: {}, byRule: {}, otherRules: EMPTY_HISTOGRAM, recent: [] }
}

function isCounterSplit(value: unknown): value is ShieldCounterSplit {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.screened === 'number'
    && typeof row.observed === 'number'
    && typeof row.asked === 'number'
    && typeof row.blocked === 'number'
}

function toCounterSplit(value: ShieldCounterSplit): ShieldCounterSplit {
  return {
    screened: value.screened,
    observed: value.observed,
    asked: value.asked,
    askedGranted: typeof value.askedGranted === 'number' ? value.askedGranted : 0,
    askedDenied: typeof value.askedDenied === 'number' ? value.askedDenied : 0,
    blocked: value.blocked,
  }
}

function toFinding(value: unknown): ShieldFindingSummary | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.at !== 'number' || typeof row.rule !== 'string' || typeof row.channel !== 'string'
    || typeof row.sha16 !== 'string') return undefined
  if (row.verdict !== 'observe' && row.verdict !== 'ask' && row.verdict !== 'deny') return undefined
  return {
    at: row.at,
    verdict: row.verdict,
    rule: row.rule,
    channel: row.channel,
    sha16: row.sha16,
    ...(typeof row.host === 'string' ? { host: row.host } : {}),
    ...(typeof row.callId === 'string' ? { callId: row.callId } : {}),
  }
}

function toHistogram(value: unknown): ShieldRuleHistogram | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.observed !== 'number' || typeof row.asked !== 'number' || typeof row.blocked !== 'number') {
    return undefined
  }
  return { observed: row.observed, asked: row.asked, blocked: row.blocked }
}

function toRepoStats(value: unknown, cwd: string | null): ShieldRepoStats | undefined {
  if (!isCounterSplit(value)) return undefined
  const row = value as ShieldCounterSplit & {
    cwd?: unknown
    byChannel?: unknown
    byRule?: unknown
    otherRules?: unknown
    recent?: unknown
  }
  const byChannel: Record<string, ShieldCounterSplit> = {}
  if (row.byChannel !== null && typeof row.byChannel === 'object') {
    for (const [channel, split] of Object.entries(row.byChannel as Record<string, unknown>)) {
      if (isCounterSplit(split)) byChannel[channel] = toCounterSplit(split)
    }
  }
  const byRule: Record<string, ShieldRuleHistogram> = {}
  if (row.byRule !== null && typeof row.byRule === 'object') {
    for (const [rule, hist] of Object.entries(row.byRule as Record<string, unknown>)) {
      const parsed = toHistogram(hist)
      if (parsed !== undefined) byRule[rule] = parsed
    }
  }
  const recent: ShieldFindingSummary[] = []
  if (Array.isArray(row.recent)) {
    for (const item of row.recent) {
      const finding = toFinding(item)
      if (finding !== undefined) recent.push(finding)
    }
  }
  const reported = typeof row.cwd === 'string' ? row.cwd : null
  return {
    cwd: reported ?? cwd,
    ...toCounterSplit(value),
    byChannel,
    byRule,
    otherRules: toHistogram(row.otherRules) ?? EMPTY_HISTOGRAM,
    recent,
  }
}

function toDefinitions(value: unknown): ShieldDefinitions | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.version !== 'string' || typeof row.stale !== 'boolean') return undefined
  if (row.updatedAt !== null && typeof row.updatedAt !== 'number') return undefined
  return { version: row.version, updatedAt: row.updatedAt, stale: row.stale }
}

function callSnapshot(holder: unknown, cwd: string | null): unknown {
  if (holder === null || typeof holder !== 'object') return undefined
  const stats = (holder as { stats?: { snapshot?: (key?: string | null) => unknown } }).stats
  if (stats === undefined || typeof stats.snapshot !== 'function') return undefined
  try {
    return stats.snapshot(cwd)
  } catch {
    // Engine snapshot is best-effort; the pane still shows last persisted counts.
    return undefined
  }
}

function readEngineSnapshot(
  payload: unknown,
  cwd: string | null,
): { stats: ShieldRepoStats; definitions?: ShieldDefinitions } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const direct = callSnapshot(payload, cwd)
  const nested = direct === undefined
    ? callSnapshot((payload as { shield?: unknown }).shield, cwd)
    : direct
  const stats = toRepoStats(nested, cwd)
    ?? toRepoStats(
      nested !== null && typeof nested === 'object'
        ? (nested as { stats?: unknown }).stats
        : undefined,
      cwd,
    )
  if (stats === undefined) return undefined
  const definitions = toDefinitions((nested as { definitions?: unknown }).definitions)
  return definitions === undefined ? { stats } : { stats, definitions }
}

/**
 * Published Shield status and a read-only snapshot RPC. `active` is the
 * brand-mark switch: blue girl and green shield only while the paid engine is
 * screening. The seat owns this service name; the paid plugin must not replace it.
 */
export class ShieldHost extends TypertRemoteService {
  /** Current screening status. */
  readonly status: ShieldStatus
  private payload: unknown
  private persisted: ((cwd?: string | null) => unknown) | undefined
  private lastStats: ShieldRepoStats
  private lastDefinitions: ShieldDefinitions | undefined
  private repoDisabledFor: ((cwd: string) => boolean) | undefined
  private pullSync: (() => void) | undefined

  /**
   * @param ctx - owning context.
   * @param status - initial status; mutated in place as resolve settles.
   */
  constructor(ctx: Context, status: ShieldStatus) {
    super(ctx, 'shield')
    this.status = status
    this.lastStats = emptyRepoStats(null)
  }

  /**
   * Remember the live paid instance so {@link snapshot} can read its stats.
   * @param payload - value returned by the paid `apply`, or `undefined` after dispose.
   */
  bindPayload(payload: unknown): void {
    this.payload = payload
    const read = payload === undefined ? undefined : readEngineSnapshot(payload, this.lastStats.cwd)
    if (read === undefined) return
    this.lastStats = read.stats
    if (read.definitions !== undefined) this.lastDefinitions = read.definitions
  }

  /**
   * Remember a module-level stats reader used when screening is off.
   * @param reader - `stats.snapshot` from the resolved payload module, or `undefined`.
   */
  bindPersistedReader(reader: ((cwd?: string | null) => unknown) | undefined): void {
    this.persisted = reader
  }

  /**
   * Remember the per-repo exemption check used to override snapshot status.
   * @param disabledFor - `(cwd) => true` when an entry disables that repo.
   */
  bindRepoDisabled(disabledFor: ((cwd: string) => boolean) | undefined): void {
    this.repoDisabledFor = disabledFor
  }

  /**
   * Remember the pull re-evaluation run at the top of every snapshot call —
   * the safety net for session events scope-filtered away from the seat fiber.
   * @param pull - triggers a seat sync when the repo-gate decision flipped.
   */
  bindPullSync(pull: (() => void) | undefined): void {
    this.pullSync = pull
  }

  /**
   * Per-repo counters for the current session cwd. Disable remounts the payload
   * off but still returns last persisted counts with `status.reason === 'disabled'`.
   * A repo exempt through `repos` reports `status.reason === 'repo-disabled'`
   * while diagnostics keep precedence over the exemption. The call first
   * re-evaluates the repo gate; because that re-evaluation settles
   * asynchronously, the snapshot that detected a flip reports the pre-flip
   * status and the next read reflects the new one.
   * @param sessionId - live session whose `header.cwd` keys the stats; omitted
   *   uses the most recently created live session that has a cwd.
   * @returns a JSON copy, never a live alias of seat or engine state.
   */
  @Remote('snapshot')
  snapshot(sessionId?: string): ShieldSnapshot {
    try {
      this.pullSync?.()
      const cwd = this.resolveCwd(sessionId)
      const source = this.payload !== undefined
        ? this.payload
        : this.persisted === undefined ? undefined : { stats: { snapshot: this.persisted } }
      const live = source === undefined ? undefined : readEngineSnapshot(source, cwd)
      if (live !== undefined) {
        this.lastStats = live.stats
        if (live.definitions !== undefined) this.lastDefinitions = live.definitions
      } else if (cwd !== this.lastStats.cwd) {
        this.lastStats = { ...this.lastStats, cwd }
      }
      return {
        status: this.snapshotStatus(cwd),
        stats: {
          ...toCounterSplit(this.lastStats),
          cwd: this.lastStats.cwd,
          byChannel: { ...this.lastStats.byChannel },
          byRule: { ...this.lastStats.byRule },
          otherRules: { ...this.lastStats.otherRules },
          recent: [...this.lastStats.recent],
        },
        ...(this.lastDefinitions === undefined ? {} : { definitions: { ...this.lastDefinitions } }),
      }
    } catch {
      return {
        status: { active: this.status.active, reason: this.status.reason },
        stats: emptyRepoStats(null),
      }
    }
  }

  /**
   * Effective status for one repo: harness-wide status, except a mounted
   * engine screening an exempt repo reports `'repo-disabled'` for that repo.
   * Diagnostic reasons (`panic`, `engine-missing`, `unlicensed`) and the
   * global `'disabled'` pass through unchanged — they outrank the exemption.
   * @param cwd - resolved repo path for the requested session, or `null`.
   * @returns the status the pane renders for this repo.
   */
  private snapshotStatus(cwd: string | null): ShieldStatus {
    if (!this.status.active || cwd === null) return { active: this.status.active, reason: this.status.reason }
    if (this.repoDisabledFor?.(cwd) === true) return { active: false, reason: 'repo-disabled' }
    return { active: this.status.active, reason: this.status.reason }
  }

  private resolveCwd(sessionId?: string): string | null {
    const sessions = this.ctx.get('sessions') as {
      get?(id: SessionId): { header: { cwd?: string } } | undefined
      list?(): Array<{ header: { cwd?: string } }>
    } | undefined
    if (sessions !== undefined) {
      if (sessionId !== undefined) {
        const header = sessions.get?.(SessionId(sessionId))?.header
        if (header?.cwd !== undefined) return resolveRepoPath(header.cwd)
      }
      const listed = sessions.list?.() ?? []
      for (let i = listed.length - 1; i >= 0; i -= 1) {
        const cwd = listed[i]?.header.cwd
        if (cwd !== undefined) return resolveRepoPath(cwd)
      }
    }
    return this.lastStats.cwd
  }
}

function isPanicDisabled(): boolean {
  try {
    return process.env.SHRES_SHIELD === 'off'
  } catch {
    /* v8 ignore next -- env probe never throws to the caller */
    return false
  }
}

/**
 * Whether the resolved payload may apply.
 * A non-empty license entitles any source. Sibling and env-module loads are
 * developer-entitled without a key. A package- or profile-resolved load is not.
 * @param license - effective license string.
 * @param source - where `apply` was loaded from.
 * @returns true when the paid `apply` may run.
 */
export function isEntitled(license: string, source: ShieldEngineSource): boolean {
  return license.length > 0 || source === 'sibling' || source === 'env'
}

/**
 * Effective license: env wins over the row config.
 * @param config - validated seat config.
 * @returns the entitlement string, possibly empty.
 */
export function readLicense(config: Config): string {
  try {
    const fromEnv = process.env.SHRES_SHIELD_LICENSE
    if (fromEnv !== undefined) return fromEnv
  } catch {
    /* v8 ignore next -- env probe never throws to the caller */
    // env probe never throws to the caller
  }
  const fromConfig = config.license
  if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig
  return DEFAULT_SHIELD_LICENSE
}

function setStatus(status: { active: boolean; reason: ShieldReason }, next: ShieldStatus): void {
  status.active = next.active
  status.reason = next.reason
}

/**
 * Mount the seat. Panic, missing engine, and missing entitlement leave the
 * row loaded and `ctx.shield.active === false`. The paid `apply` is invoked
 * only when entitled; its dispose rides this fiber.
 */
export function apply(ctx: Context, config: Config): void {
  const status = { active: false, reason: 'engine-missing' as ShieldReason }
  const host = new ShieldHost(ctx, status)
  const entry: Config = {
    license: config.license !== undefined && config.license.length > 0 ? config.license : DEFAULT_SHIELD_LICENSE,
    enabled: config.enabled !== false,
    repos: config.repos ?? {},
    posture: config.posture ?? 'ask',
  }
  let source: () => Config = () => entry
  let instance: { dispose(): Promise<void> } | undefined
  let chain = Promise.resolve()
  let stopped = false

  /** Stored exception map from the authoritative source. */
  const currentRepos = (): ShieldRepos => {
    const repos = source().repos
    /* v8 ignore start -- apply() and the settings schema always store a repos map */
    if (repos === undefined) return {}
    /* v8 ignore stop */
    return repos
  }

  const sync = (): void => {
    chain = chain.then(async () => {
      /* v8 ignore next -- dispose can flip `stopped` while this chain is queued */
      if (stopped) return
      if (instance !== undefined) {
        await instance.dispose()
        instance = undefined
        host.bindPayload(undefined)
      }
      // The boot include anchors module resolution at the profile directory
      // (`ctx.baseUrl` = profileDir + '/'), so the paid payload resolves from
      // the same profile whose `node_modules` edition ensure installs into.
      const profileDir = ctx.baseUrl === undefined ? undefined : fileURLToPath(ctx.baseUrl)
      const engine = await resolveShieldEngine(profileDir === undefined ? {} : { profileDir })
      // `stopped` is set from dispose while this await runs.
      /* v8 ignore start -- dispose can flip `stopped` while resolve awaits */
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated concurrently during await
      if (stopped) return
      /* v8 ignore stop */
      host.bindPersistedReader(engine?.snapshot)
      if (isPanicDisabled()) {
        setStatus(status, { active: false, reason: 'panic' })
        return
      }
      const current = source()
      const license = readLicense(current)
      if (engine === undefined) {
        setStatus(status, { active: false, reason: 'engine-missing' })
        return
      }
      /* v8 ignore start -- default license is non-empty and the env fixture is entitled */
      if (!isEntitled(license, engine.source)) {
        setStatus(status, { active: false, reason: 'unlicensed' })
        return
      }
      /* v8 ignore stop */
      if (current.enabled === false) {
        setStatus(status, { active: false, reason: 'disabled' })
        return
      }
      if (repoGateBlocksMount(currentRepos(), liveSessionCwds(ctx.get('sessions')))) {
        setStatus(status, { active: false, reason: 'repo-disabled' })
        return
      }
      /* v8 ignore next -- apply() always stores a concrete posture on entry */
      const posture = current.posture ?? 'ask'
      instance = await engine.apply(ctx, { posture })
      /* v8 ignore start -- dispose can flip `stopped` while apply awaits */
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated concurrently during await
      if (stopped) {
        await instance.dispose()
        instance = undefined
        host.bindPayload(undefined)
        return
      }
      /* v8 ignore stop */
      host.bindPayload(instance)
      setStatus(status, { active: true, reason: 'active' })
    /* v8 ignore start -- resolve is fail-soft; a throw is an unexpected loader failure */
    }).catch(() => {
      setStatus(status, { active: false, reason: 'engine-missing' })
    })
    /* v8 ignore stop */
  }

  /**
   * Re-evaluate the repo gate and sync only when the mount decision flips.
   * Reasons that outrank the gate short-circuit: session events cannot change
   * them. Both the session-event push and snapshot()'s pull route through
   * here, so neither remounts the engine when the decision holds.
   */
  const syncIfGateFlipped = (): void => {
    if (status.reason !== 'active' && status.reason !== 'repo-disabled') return
    const blocked = repoGateBlocksMount(currentRepos(), liveSessionCwds(ctx.get('sessions')))
    if (blocked !== (status.reason === 'repo-disabled')) sync()
  }

  // Push: session lifecycle can flip the repo gate (a session in a newly
  // exempt repo keeps the engine mounted for the others and vice versa).
  // Scope filtering may hide some sessions from this fiber; snapshot()'s pull
  // re-evaluation is the safety net.
  ctx.on('session/created', syncIfGateFlipped)
  ctx.on('session/disposed', syncIfGateFlipped)
  host.bindRepoDisabled(cwd => repoDisabled(currentRepos(), cwd))
  host.bindPullSync(syncIfGateFlipped)

  installSettingsSection(ctx, SHIELD_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (current) => { source = current },
    onChange: sync,
    validate: (value) => {
      /* v8 ignore next -- schema output always includes repos */
      validateRepoKeys(value.repos ?? {})
    },
  })
  sync()
  ctx.effect(() => () => {
    stopped = true
    return chain.then(async () => {
      if (instance !== undefined) await instance.dispose()
      host.bindPayload(undefined)
    })
  }, 'shres-shield: withdraw engine')
}
