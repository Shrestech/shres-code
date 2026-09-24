/**
 * The Definition-owned `judgment` settings namespace: the deployment's on/off
 * switch and, when `judgment-dispatch` serves `ctx.judgment`, the selected
 * engine and per-consumer engine overrides.
 *
 * The namespace belongs to the Definition rather than to one provider, so every
 * engine a dispatcher routes to reads the same toggle. The service mounted as
 * `ctx.judgment` installs the section, and consumers read it through the live
 * source thunk that service exposes, treating `enabled: false` exactly as an
 * absent engine.
 *
 * @module @shres-code/shres-code-judgment/settings
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { installSettingsSection, SettingsFieldError, settingsNamespace } from '@shres-code/shres-code-settings'
import type { JudgmentSettings } from './types.ts'

/** The `judgment` settings namespace, carried by the Model UI's Classifier section. */
export const JUDGMENT_SETTINGS_NAMESPACE = settingsNamespace('judgment')

/**
 * Schema of the `judgment` settings section; an absent user layer means
 * enabled. `overrides` is a union with `undefined` rather than a bare dict,
 * whose schema default is `{}` even when marked not required, so a section
 * that configures no override resolves without the key.
 */
export const JUDGMENT_SETTINGS_SCHEMA: z<JudgmentSettings> = z.object({
  enabled: z.boolean().default(true),
  engine: z.string(),
  // The union's inferred type admits an explicit `undefined`, which
  // `exactOptionalPropertyTypes` forbids on the optional field; the resolved
  // value never carries the key with `undefined`, because schemastery drops a
  // key whose resolved value is undefined. It passes a valueless key's `null`
  // through, which the field's type states.
  overrides: z.union([z.dict(z.string()), z.const(undefined)]) as unknown as z<Readonly<Record<string, string>> | null>,
})

/** Composition default of the `judgment` settings section for a single-engine implementation. */
export const JUDGMENT_SETTINGS_DEFAULT: JudgmentSettings = Object.freeze({ enabled: true })

/** How the service mounted as `ctx.judgment` installs the section. */
export interface JudgmentSettingsInstall {
  /** Composition layer of the section; omission installs {@link JUDGMENT_SETTINGS_DEFAULT}. */
  readonly base?: JudgmentSettings
  /**
   * Reject a selection a write introduces that the installing service cannot
   * serve, such as an engine that is not registered; throw
   * `SettingsFieldError` naming the field being written. It runs only for the
   * `write` validation cause, which a configuration surface produces, so it
   * can judge what the write changed against `previous`. A `register` or
   * `reload` applies the stored document without it: rejecting a file for the
   * state of live services would keep the previous selection answering with
   * no visible sign, and at registration a stored selection can name a
   * service that registers later in the same load.
   * @param value - the resolved section the write would commit, structurally valid.
   * @param previous - the resolved section in force before the write.
   */
  readonly validateSelection?: (value: JudgmentSettings, previous: JudgmentSettings) => void
}

/**
 * Whether judgment is enabled for the deployment that owns `source`.
 * @param source - live read of the resolved settings section.
 * @returns true while the deployment enables judgment, false when it is off.
 */
export function judgmentEnabled(source: () => JudgmentSettings): boolean {
  return source().enabled
}

/**
 * Reject a section whose engine ids are not non-empty strings. The schema's
 * string fields pass `null` through, which a valueless YAML key produces, so
 * this check is what rejects `engine:` and `overrides.<consumer>:` written
 * without a value. A valueless `overrides:` means no overrides. Whether an
 * id names a registered engine is the installing service's check.
 * @param value - the resolved section.
 * @throws SettingsFieldError naming the invalid field.
 */
export function assertJudgmentSettingsShape(value: JudgmentSettings): void {
  const engine: unknown = value.engine
  if (engine !== undefined && !isEngineIdText(engine)) {
    throw new SettingsFieldError(['engine'], 'judgment: engine must name an engine id')
  }
  for (const [consumer, id] of Object.entries(value.overrides ?? {})) {
    if (consumer === '') throw new SettingsFieldError(['overrides', consumer], 'judgment: overrides keys must name a consumer id')
    if (!isEngineIdText(id)) {
      throw new SettingsFieldError(['overrides', consumer], `judgment: overrides.${consumer} must name an engine id`)
    }
  }
}

/** Whether a settings value is usable as an engine id. */
function isEngineIdText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/**
 * Install the `judgment` namespace on one context and return a live read of the
 * resolved section. With a settings service attached the read follows the user
 * layer and every committed change; without one it stays on the composition
 * layer. The registration rides `ctx`, so it is released with the fiber that
 * mounted the service.
 * @param ctx - the mounting context that owns the registration.
 * @param install - the composition layer and the optional selection check.
 * @returns thunk reading the currently authoritative section.
 */
export function installJudgmentSettings(ctx: Context, install: JudgmentSettingsInstall = {}): () => JudgmentSettings {
  const base = install.base ?? JUDGMENT_SETTINGS_DEFAULT
  const validateSelection = install.validateSelection
  let source: () => JudgmentSettings = () => base
  installSettingsSection(ctx, JUDGMENT_SETTINGS_NAMESPACE, JUDGMENT_SETTINGS_SCHEMA, base, {
    setSource: (current) => {
      source = current
    },
    // Nothing here is derived from the section: every consumer re-reads the
    // source at the decision it gates, which is what keeps a committed change
    // effective without a re-registration.
    onChange: () => {},
    validate: (value, cause) => {
      assertJudgmentSettingsShape(value)
      // The source still reads the committed section: a write commits only
      // after this check passes.
      if (cause === 'write') validateSelection?.(value, source())
    },
  })
  return () => source()
}
