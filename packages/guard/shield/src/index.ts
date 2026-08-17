/**
 * Default-on host seat for the paid Shres Shield plugin. Resolves the engine
 * from a sibling checkout or `@shres-shield/plugin`, checks entitlement, and
 * publishes `ctx.shield`. The detection payload never lives in this package.
 * Integration contract: shres-shield `docs/integration-shres-code.md`.
 * @module @shres-code/shres-code-shield
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import { resolveShieldEngine } from './resolve.ts'
import type { ShieldEngineSource, ShieldReason, ShieldStatus } from './types.ts'

export type {
  ShieldEngine, ShieldEngineApply, ShieldEngineSource, ShieldInactiveReason, ShieldReason, ShieldStatus,
} from './types.ts'
export { repoRootFromSeat, resolveShieldEngine, siblingPluginPath } from './resolve.ts'

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

/** Host-seat config. Engine-owned tunables stay on `@shres-shield/plugin`. */
export interface Config {
  /**
   * Entitlement string. Defaults to {@link DEFAULT_SHIELD_LICENSE} until a
   * paid key exists. `SHRES_SHIELD_LICENSE` overrides this field. A sibling
   * `../shres-shield` checkout is also entitled without a key.
   */
  license?: string
  /**
   * User switch on the Shield settings page. Default true. False unloads the
   * payload without the panic env. `SHRES_SHIELD=off` still wins.
   */
  enabled?: boolean
  /** Forwarded to the paid plugin. Default `ask`. */
  posture?: 'observe' | 'ask' | 'enforce'
}

export const Config: z<Config> = z.object({
  license: z.string().default(DEFAULT_SHIELD_LICENSE),
  enabled: z.boolean().default(true),
  posture: z.union(['observe', 'ask', 'enforce'] as const).default('ask'),
})

/** Settings namespace the Shield Settings page writes. */
export const SHIELD_SETTINGS_NAMESPACE = settingsNamespace('shres-shield')

declare module '@shres-code/cordis' {
  interface Context {
    shield: ShieldHost
  }
}

/**
 * Published Shield status. `active` is the brand-mark switch: blue girl and
 * green shield only while the paid engine is screening.
 */
export class ShieldHost extends Service {
  /** Current screening status. */
  readonly status: ShieldStatus

  /**
   * @param ctx - owning context.
   * @param status - initial status; mutated in place as resolve settles.
   */
  constructor(ctx: Context, status: ShieldStatus) {
    super(ctx, 'shield')
    this.status = status
  }
}

function isPanicDisabled(): boolean {
  try {
    return process.env.SHRES_SHIELD === 'off'
  } catch {
    return false
  }
}

/**
 * Whether the resolved payload may apply.
 * A non-empty license entitles any source. Sibling and env-module loads are
 * developer-entitled without a key. A package-specifier load is not.
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
  new ShieldHost(ctx, status)
  const entry: Config = {
    license: config.license !== undefined && config.license.length > 0 ? config.license : DEFAULT_SHIELD_LICENSE,
    enabled: config.enabled !== false,
    posture: config.posture ?? 'ask',
  }
  let source: () => Config = () => entry
  let instance: { dispose(): Promise<void> } | undefined
  let chain = Promise.resolve()
  let stopped = false

  const sync = (): void => {
    chain = chain.then(async () => {
      if (stopped) return
      if (instance !== undefined) {
        await instance.dispose()
        instance = undefined
      }
      if (isPanicDisabled()) {
        setStatus(status, { active: false, reason: 'panic' })
        return
      }
      const current = source()
      if (current.enabled === false) {
        setStatus(status, { active: false, reason: 'disabled' })
        return
      }
      const license = readLicense(current)
      const engine = await resolveShieldEngine()
      if (stopped) return
      if (engine === undefined) {
        setStatus(status, { active: false, reason: 'engine-missing' })
        return
      }
      if (!isEntitled(license, engine.source)) {
        setStatus(status, { active: false, reason: 'unlicensed' })
        return
      }
      instance = await engine.apply(ctx, { posture: current.posture ?? 'ask' })
      if (stopped) {
        await instance.dispose()
        instance = undefined
        return
      }
      setStatus(status, { active: true, reason: 'active' })
    }).catch(() => {
      setStatus(status, { active: false, reason: 'engine-missing' })
    })
  }

  installSettingsSection(ctx, SHIELD_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (current) => { source = current },
    onChange: sync,
  })
  sync()
  ctx.effect(() => () => {
    stopped = true
    return chain.then(async () => {
      if (instance !== undefined) await instance.dispose()
    })
  }, 'shres-shield: withdraw engine')
}
