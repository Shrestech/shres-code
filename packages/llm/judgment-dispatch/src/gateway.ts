/**
 * The `judgmentEngines` Remote: a JSON snapshot of the engine registry and the
 * `judgment` selection for configuration surfaces. Writes go through the
 * settings seam, never through this Remote.
 */

import type { Context } from '@shres-code/cordis'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
import type { JudgmentEngineRegistry, JudgmentSettings } from '@shres-code/shres-code-judgment'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { JudgmentEnginesSnapshot, JudgmentEngineView } from './types.ts'

/** What the gateway reads: the dispatcher's registry and its resolved selection. */
export interface JudgmentEnginesSource {
  /** The registry the dispatcher provides as `ctx.judgmentEngines`. */
  readonly registry: JudgmentEngineRegistry
  /**
   * Read the resolved `judgment` section.
   * @returns the section with `engine` present.
   */
  settings(): JudgmentSettings & { engine: string }
}

/**
 * This machine's platform-architecture pair, in the form engine descriptors name.
 * @returns the pair, such as `darwin-arm64`.
 */
export function currentHost(): string {
  return `${process.platform}-${process.arch}`
}

/** Remote-only service over one dispatcher's registry and selection, wire namespace `judgmentEngines`. */
export class JudgmentEnginesGateway extends TypertRemoteService {
  /**
   * @param ctx - the dispatcher's context; the service leaves with its fiber.
   * @param source - the dispatcher's registry and selection.
   */
  constructor(ctx: Context, private readonly source: JudgmentEnginesSource) {
    super(ctx, 'judgmentEnginesRemote', { namespace: 'judgmentEngines' })
  }

  /**
   * Read the registry and the selection on every call; `judgment/engines-updated`
   * announces when a new read would differ.
   * @returns a JSON copy of every registered engine with its current status,
   *   the resolved selection, the declared consumer ids, and this machine's host.
   */
  @Remote('snapshot')
  snapshot(): JudgmentEnginesSnapshot {
    const host = currentHost()
    const engines = this.source.registry.entryList().map((entry): JudgmentEngineView => {
      const { descriptor } = entry
      const status = entry.status()
      const required = descriptor.host ?? 'any'
      return {
        id: descriptor.id,
        label: descriptor.label,
        egress: descriptor.egress,
        calibration: descriptor.calibration,
        supportsFitting: descriptor.supportsFitting,
        host: required,
        runsOnThisHost: required === 'any' || required === host,
        ...descriptor.terms === undefined ? {} : { terms: descriptor.terms },
        ...descriptor.models === undefined ? {} : { models: { fast: descriptor.models.fast, accurate: descriptor.models.accurate } },
        ...descriptor.destination === undefined ? {} : { destination: descriptor.destination },
        state: status.state,
        ...status.detail === undefined ? {} : { detail: status.detail },
      }
    })
    const settings = this.source.settings()
    return {
      engines,
      selection: { enabled: settings.enabled, engine: settings.engine, overrides: { ...settings.overrides ?? {} } },
      consumers: [...this.source.registry.consumers()],
      thisHost: host,
    }
  }
}
