/**
 * The Definition-owned `judgment` settings namespace: the deployment-level
 * on/off a configuration surface exposes once a judgment engine is composed.
 *
 * The namespace belongs to the Definition rather than to one provider, so every
 * engine behind `ctx.judgment` — the remote provider today, a distilled on-box
 * engine later — reads the same toggle. Consumers read it through the live
 * source thunk the mounting service exposes and treat `enabled: false` exactly
 * as an absent engine.
 *
 * @module @shres-code/shres-code-judgment/settings
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type { JudgmentSettings } from './types.ts'

/** The `judgment` settings namespace, carried by the Model UI's Classifier section. */
export const JUDGMENT_SETTINGS_NAMESPACE = settingsNamespace('judgment')

/** Schema of the `judgment` settings section; an absent user layer means enabled. */
export const JUDGMENT_SETTINGS_SCHEMA: z<JudgmentSettings> = z.object({
  enabled: z.boolean().default(true),
})

/** Composition default of the `judgment` settings section. */
export const JUDGMENT_SETTINGS_DEFAULT: JudgmentSettings = Object.freeze({ enabled: true })

/**
 * Whether judgment is enabled for the deployment that owns `source`.
 * @param source - live read of the resolved settings section.
 * @returns true while the deployment enables judgment, false when it is off.
 */
export function judgmentEnabled(source: () => JudgmentSettings): boolean {
  return source().enabled
}

/**
 * Install the `judgment` namespace on one context and return a live read of the
 * resolved section. With a settings service attached the read follows the user
 * layer and every committed change; without one it stays on the composition
 * default. The registration rides `ctx`, so it is released with the fiber that
 * mounted the engine.
 * @param ctx - the mounting context that owns the registration.
 * @returns thunk reading the currently authoritative section.
 */
export function installJudgmentSettings(ctx: Context): () => JudgmentSettings {
  let source: () => JudgmentSettings = () => JUDGMENT_SETTINGS_DEFAULT
  installSettingsSection(ctx, JUDGMENT_SETTINGS_NAMESPACE, JUDGMENT_SETTINGS_SCHEMA, JUDGMENT_SETTINGS_DEFAULT, {
    setSource: (current) => {
      source = current
    },
    // Nothing here is derived from the section: every consumer re-reads the
    // source at the decision it gates, which is what keeps a committed change
    // effective without a re-registration.
    onChange: () => {},
  })
  return () => source()
}
