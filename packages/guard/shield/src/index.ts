/**
 * Default-on host seat for the paid Shres Shield plugin. Resolves the engine
 * from the active profile's installed payload, a sibling checkout, or
 * `@shrestech/shres-shield-plugin`, checks entitlement, and publishes
 * `ctx.shield`. The detection payload never lives in this package. Settings
 * Check / Update talk to the public npm registry and `pnpm add` in the
 * profile. Integration contract: sibling shres-shield repository,
 * integration-shres-code.md.
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
import { PAYLOAD_SPECIFIER, resolveShieldEngine } from './resolve.ts'
import {
  liveSessionCwds, repoDisabled, repoGateBlocksMount, resolveRepoPath,
  validateRepoKeys, type ShieldRepos,
} from './repos.ts'
import {
  installPayload, isNpmVersion, queryNpmLatest, readPayloadVersion,
} from './update.ts'
import type {
  ShieldCounterSplit, ShieldDefinitions, ShieldEngineSource, ShieldFindingSummary,
  ShieldPayloadInfo, ShieldPayloadUpdate, ShieldReason, ShieldRepoStats,
  ShieldRuleHistogram, ShieldSnapshot, ShieldStatus,
} from './types.ts'

export type {
  ShieldCounterSplit, ShieldDecision, ShieldDefinitions, ShieldEngine, ShieldEngineApply,
  ShieldEngineSource, ShieldFindingSummary, ShieldInactiveReason, ShieldPayloadInfo,
  ShieldPayloadUpdate, ShieldReason, ShieldRepoStats, ShieldRuleHistogram,
  ShieldSnapshot, ShieldStatus, ShieldUpdateBlocked,
} from './types.ts'
export {
  PAYLOAD_SPECIFIER, repoRootFromSeat, resolveProfileSpecifier, resolveShieldEngine,
  siblingPluginPath, type ShieldResolveOptions,
} from './resolve.ts'
export {
  defaultSpawn, installPayload, isNpmVersion, NPM_PAYLOAD_PACKUMENT, pnpmEnv,
  queryNpmLatest, readPayloadVersion, restoreDefaultSpawn, shieldSpawn, spawnBinary,
  type ShieldSpawner, type ShieldSpawnResult,
} from './update.ts'
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
   * Entitlement string forwarded to the paid `apply`. Defaults to
   * {@link DEFAULT_SHIELD_LICENSE} until a paid key exists.
   * `SHRES_SHIELD_LICENSE` overrides this field. A sibling
   * `../shres-shield` checkout is also entitled without a key. Unsigned
   * loads in non-production enable the payload's unsigned-dev hatch;
   * production requires a signed `shres1.` token.
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
 * Published Shield status, snapshot RPC, and npm check/install remotes.
 * `active` is the brand-mark switch: blue girl and green shield only while
 * the paid engine is screening. The seat owns this service name; the paid
 * plugin must not replace it.
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
  private resolved: ShieldPayloadInfo | undefined
  private profileDir: string | undefined
  private remount: (() => Promise<void>) | undefined
  private updateChain = Promise.resolve()
  /** Latest payload version already warned about (so the notice fires once). */
  private staleWarnedFor: string | undefined

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
   * Remember the resolved payload identity so snapshot and update RPCs can
   * report source and version without re-importing.
   * @param info - identity plus the import entry used for version lookup.
   */
  bindResolved(info: ShieldPayloadInfo | undefined): void {
    this.resolved = info
  }

  /**
   * One-shot staleness probe (gapfix 2026-08-24): query npm `latest` and, when
   * it outruns the applied payload version, emit a stderr notice and mark the
   * host status reason `payload-outdated` WITHOUT deactivating screening.
   * Skipped for env-module overrides (their contract is explicit pinning) and
   * when the registry is unreachable. Fires at most once per boot.
   */
  async notePayloadStaleness(): Promise<void> {
    const installed = this.resolved?.version ?? null
    if (installed === null) return
    if (!isNpmVersion(installed)) return
    let queried: Awaited<ReturnType<typeof queryNpmLatest>> | null
    try {
      queried = await queryNpmLatest()
    } catch {
      /* v8 ignore next -- queryNpmLatest returns a structured miss, it does not throw */
      queried = null
    }
    if (queried === null || queried.latest === null || queried.blocked !== undefined) return
    const latest = queried.latest
    if (!isNpmVersion(latest) || latest === installed) {
      // converged (fresh install or remount after applyUpdate): clear advisory
      delete this.status.stale
      return
    }
    const newer = (a: string, b: string): boolean => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) {
        // isNpmVersion requires three numeric fields; ?? 0 is belt-and-braces.
        /* v8 ignore next -- three-part semver always yields numeric slots */
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
      }
      /* v8 ignore next -- equal numeric triples are caught by latest === installed */
      return false
    }
    if (!newer(latest, installed)) {
      delete this.status.stale
      return
    }
    this.status.stale = { installed, latest }
    if (this.staleWarnedFor !== latest) {
      this.staleWarnedFor = latest
      process.stderr.write(
        `[shres-shield] NOTICE: payload ${installed} is behind npm latest ${latest}; `
        + 'detection-rule coverage may be outdated. Update via Settings > Shield '
        + '(or `shres plugin --profile <profile> enable-edition shield`).\n')
    }
  }

  /**
   * Remember the boot profile directory `pnpm add` installs into.
   * @param dir - absolute profile directory, or `undefined` when the seat
   *   is not booted from a profile.
   */
  bindProfileDir(dir: string | undefined): void {
    this.profileDir = dir
  }

  /**
   * Remember the remount used after a successful npm install.
   * @param remount - queues a seat sync and returns the in-flight chain.
   */
  bindRemount(remount: (() => Promise<void>) | undefined): void {
    this.remount = remount
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
        ...(this.resolved === undefined ? {} : { payload: { ...this.resolved } }),
      }
    } catch {
      return {
        status: { active: this.status.active, reason: this.status.reason },
        stats: emptyRepoStats(null),
      }
    }
  }

  /**
   * Compare the resolved payload version with npm `latest`. Does not install.
   * An env-module override still reports `latest` but sets `available: false`
   * and `blocked: 'env-override'` because that exclusive leg would ignore a
   * profile install.
   * @returns a JSON copy of the check result.
   */
  @Remote('checkUpdate')
  async checkUpdate(): Promise<ShieldPayloadUpdate> {
    return this.runUpdate(false)
  }

  /**
   * Re-query npm `latest` and, when an update is available, `pnpm add` that
   * exact version into the boot profile, then remount so the profile leg
   * loads it. Refuses env-module override, a missing profile directory, and
   * a non-semver registry version.
   * @returns the post-install check, with `applied: true` on success.
   */
  @Remote('applyUpdate')
  async applyUpdate(): Promise<ShieldPayloadUpdate> {
    const run = this.updateChain.then(() => this.runUpdate(true))
    this.updateChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async runUpdate(install: boolean): Promise<ShieldPayloadUpdate> {
    const source = this.resolved?.source ?? 'none'
    const installed = this.resolved?.version ?? null
    const base = (): ShieldPayloadUpdate => ({
      specifier: PAYLOAD_SPECIFIER,
      source,
      installed,
      latest: null,
      available: false,
      applied: false,
    })

    if (envModuleSet()) {
      const queried = await queryNpmLatest()
      return {
        ...base(),
        latest: queried.latest,
        blocked: 'env-override',
        ...queried.detail === undefined ? {} : { detail: queried.detail },
      }
    }

    const queried = await queryNpmLatest()
    if (queried.blocked !== undefined) {
      return {
        ...base(),
        blocked: 'registry',
        /* v8 ignore next -- queryNpmLatest always sets detail when it blocks */
        ...queried.detail === undefined ? {} : { detail: queried.detail },
      }
    }
    const latest = queried.latest
    const available = latest !== null && latest !== installed
    const checked: ShieldPayloadUpdate = { ...base(), latest, available }

    if (!install) return checked
    if (this.profileDir === undefined) {
      return { ...checked, available: false, blocked: 'no-profile' }
    }
    if (latest === null || !available) return checked
    const installedNow = await installPayload(this.profileDir, latest)
    if (!installedNow.ok) {
      return { ...checked, available: false, blocked: 'pnpm', detail: installedNow.detail }
    }
    /* v8 ignore next -- apply() binds remount before any RPC can run */
    if (this.remount !== undefined) await this.remount()
    const after = this.resolved
    return {
      specifier: PAYLOAD_SPECIFIER,
      source: after?.source ?? 'profile',
      installed: after?.version ?? latest,
      latest,
      available: false,
      applied: true,
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

function envModuleSet(): boolean {
  try {
    const value = process.env.SHRES_SHIELD_MODULE
    return value !== undefined && value.length > 0
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

/** Signed payload tokens start with this prefix (`shres1.<kid>.<payload>.<sig>`). */
export const SIGNED_LICENSE_PREFIX = 'shres1.'

/**
 * Whether `license` is a signed `shres1.` token the paid plugin can verify.
 * @param license - effective license string.
 * @returns true when the string uses the signed-token prefix.
 */
export function licenseLooksSigned(license: string): boolean {
  return license.startsWith(SIGNED_LICENSE_PREFIX)
}

/**
 * Production lock: unsigned-dev hatch must not activate.
 * `NODE_ENV=production` or `SHRES_SHIELD_PRODUCTION=1`.
 * @returns true when the hatch is forbidden.
 */
export function productionLockActive(): boolean {
  try {
    return process.env.NODE_ENV === 'production' || process.env.SHRES_SHIELD_PRODUCTION === '1'
  } catch {
    /* v8 ignore next -- env probe never throws to the caller */
    return false
  }
}

/**
 * Enable the paid plugin's unsigned-dev hatch when the license is not a
 * signed `shres1.` token. Plugin 0.2.0 rejects `shres-dev` unless this
 * hatch is on, for every resolve source including env and sibling.
 * Production stays fail-closed. Does not overwrite an existing
 * `SHRES_SHIELD_DEV=1`.
 * @param license - effective license string.
 */
export function ensureUnsignedDevHatch(license: string): void {
  if (licenseLooksSigned(license)) return
  if (productionLockActive()) return
  try {
    if (process.env.SHRES_SHIELD_DEV === '1') return
    process.env.SHRES_SHIELD_DEV = '1'
  } catch {
    /* v8 ignore next -- env assign never throws to the caller */
  }
}

function pluginEntitlement(instance: unknown): { active: boolean; reason?: string } | undefined {
  /* v8 ignore next -- paid apply always returns an object instance */
  if (instance === null || typeof instance !== 'object') return undefined
  const entitlement = (instance as { entitlement?: unknown }).entitlement
  if (entitlement === null || typeof entitlement !== 'object') return undefined
  const active = (entitlement as { active?: unknown }).active
  if (typeof active !== 'boolean') return undefined
  const reason = (entitlement as { reason?: unknown }).reason
  return typeof reason === 'string' ? { active, reason } : { active }
}

function hostReasonFromPlugin(reason: string | undefined): ShieldReason {
  return reason === 'panic' ? 'panic' : 'unlicensed'
}

/**
 * Install npm `latest` into `profileDir` and re-resolve when the engine is
 * missing, Shield is enabled, panic is off, and no exclusive env override is
 * set. Failures stay missing (registry/pnpm errors do not throw).
 * @param engine - current resolve result.
 * @param options - mount flags and the boot profile directory.
 * @returns the existing engine, a newly resolved profile engine, or `undefined`.
 */
export async function maybeProvisionPayload(
  engine: Awaited<ReturnType<typeof resolveShieldEngine>>,
  options: {
    profileDir: string | undefined
    enabled: boolean
    panic: boolean
    envExclusive: boolean
  },
): Promise<Awaited<ReturnType<typeof resolveShieldEngine>>> {
  if (engine !== undefined) return engine
  if (options.envExclusive || !options.enabled || options.panic || options.profileDir === undefined) {
    return undefined
  }
  const queried = await queryNpmLatest()
  if (queried.latest === null || queried.blocked !== undefined || !isNpmVersion(queried.latest)) {
    return undefined
  }
  const installedNow = await installPayload(options.profileDir, queried.latest)
  if (!installedNow.ok) return undefined
  return resolveShieldEngine({ profileDir: options.profileDir })
}

function setStatus(status: { active: boolean; reason: ShieldReason }, next: ShieldStatus): void {
  status.active = next.active
  status.reason = next.reason
}

/**
 * Mount the seat. Panic, missing engine, and missing entitlement leave the
 * row loaded and `ctx.shield.active === false`. An enabled seat with a boot
 * profile and no exclusive env override installs npm `latest` once when the
 * payload is missing. The paid `apply` receives posture and license; its
 * dispose rides this fiber. A payload that returns `entitlement.active ===
 * false` stays inactive.
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
      host.bindProfileDir(profileDir)
      const current = source()
      const engine = await maybeProvisionPayload(
        await resolveShieldEngine(profileDir === undefined ? {} : { profileDir }),
        {
          profileDir,
          enabled: current.enabled !== false,
          panic: isPanicDisabled(),
          envExclusive: envModuleSet(),
        },
      )
      host.bindResolved(engine === undefined ? undefined : {
        source: engine.source,
        version: readPayloadVersion(engine.entry),
      })
      // One-shot staleness probe AFTER resolve settles: env-module overrides
      // are skipped by contract (explicit pinning); profile/package legs get
      // the notice + payload-outdated status marker when npm is ahead.
      if (engine !== undefined && engine.source !== 'env') {
        void host.notePayloadStaleness()
      }
      // `stopped` is set from dispose while this await runs.
      /* v8 ignore start -- dispose can flip `stopped` while resolve awaits */
      if (stopped) return
      /* v8 ignore stop */
      host.bindPersistedReader(engine?.snapshot)
      if (isPanicDisabled()) {
        setStatus(status, { active: false, reason: 'panic' })
        return
      }
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
      ensureUnsignedDevHatch(license)
      instance = await engine.apply(ctx, { posture, license })
      /* v8 ignore start -- dispose can flip `stopped` while apply awaits */
      if (stopped) {
        await instance.dispose()
        instance = undefined
        host.bindPayload(undefined)
        return
      }
      /* v8 ignore stop */
      const entitlement = pluginEntitlement(instance)
      if (entitlement?.active === false) {
        await instance.dispose()
        instance = undefined
        host.bindPayload(undefined)
        setStatus(status, { active: false, reason: hostReasonFromPlugin(entitlement.reason) })
        return
      }
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
  host.bindRemount(() => {
    sync()
    return chain
  })

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
