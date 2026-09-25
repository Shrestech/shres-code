import { describe, expect, it } from 'vitest'
import {
  classifierEnabled, consumerRoutes, engineOption, ignoredOverrides, initialMode, isRemote, lastExitText, modelsText, numberAt,
  routingCalibration, stateLabel,
} from '../src/client/view.ts'
import { en } from '../src/client/locales.ts'
import { LAYA, LAYA_VIEW, TYPESAFE, namespace, snapshot } from './fixtures.client.ts'

/** Resolve a key the way the locale runtime does. */
function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))
}

describe('model routing view helpers', () => {
  it('names each state with a tone', () => {
    expect(stateLabel('ready', t)).toEqual({ label: 'Ready', tone: 'ok' })
    expect(stateLabel('starting', t)).toEqual({ label: 'Starting', tone: 'pending' })
    expect(stateLabel('unavailable', t)).toEqual({ label: 'Unavailable', tone: 'error' })
    expect(stateLabel('stopped', t)).toEqual({ label: 'Stopped', tone: 'warn' })
  })

  it('treats only remote egress as leaving the machine, and labels options by egress or required host', () => {
    expect(isRemote(TYPESAFE)).toBe(true)
    expect(isRemote(LAYA)).toBe(false)
    expect(isRemote({ ...TYPESAFE, egress: 'local' })).toBe(false)
    expect(engineOption({ ...TYPESAFE, egress: 'local', label: 'Shield (local gateway)' }, t)).toBe('Shield (local gateway) — local')
    expect(engineOption({ ...LAYA, runsOnThisHost: false }, t)).toBe('Laya (local MLX) — needs darwin-arm64')
  })

  it('shows one model id, both tier ids, or none', () => {
    expect(modelsText(LAYA, t)).toBe(LAYA_VIEW.modelId)
    expect(modelsText(TYPESAFE, t)).toBe('fast jev-1.13.0-fast · accurate jev-1.13.0')
    const { models: _models, ...bare } = TYPESAFE
    expect(modelsText(bare, t)).toBeUndefined()
  })

  it('describes the last exit by code, signal, and startup deadline', () => {
    expect(lastExitText(LAYA_VIEW, t)).toBeUndefined()
    expect(lastExitText({ ...LAYA_VIEW, lastExit: { exitCode: 1, signal: null, timedOut: false } }, t)).toBe('Last exit: code 1.')
    expect(lastExitText({ ...LAYA_VIEW, lastExit: { exitCode: null, signal: 'SIGKILL', timedOut: false } }, t)).toBe('Last exit: SIGKILL.')
  })

  it('reads numbers, the initial mode, and the classifier switch from resolved sections', () => {
    const router = namespace('model-router', { initialMode: 'on', state: { maxChars: 12000, label: 'x' } })
    expect(numberAt(router, ['state', 'maxChars'])).toBe(12000)
    expect(numberAt(router, ['state', 'label'])).toBeUndefined()
    expect(numberAt(router, ['initialMode', 'deeper'])).toBeUndefined()
    expect(numberAt(null, ['state'])).toBeUndefined()
    expect(initialMode(router)).toBe('on')
    expect(initialMode(namespace('model-router', null))).toBe('off')
    expect(classifierEnabled(namespace('judgment', {}))).toBe(true)
    expect(classifierEnabled(namespace('judgment', null))).toBe(true)
    expect(classifierEnabled(namespace('judgment', { enabled: false }))).toBe(false)
  })

  it('selects each declared consumer\'s engine as the dispatcher does, and names the overrides it ignores', () => {
    const view = snapshot([TYPESAFE, LAYA], 'laya', {
      overrides: { 'model-router': 'typesafe', 'worker-escalation': 'gone', 'undeclared': 'typesafe' },
      consumers: ['model-router', 'worker-escalation', 'compaction-jev', 'toString'],
    })
    expect(consumerRoutes(view)).toEqual([
      { consumer: 'model-router', engineId: 'typesafe', engine: TYPESAFE, overridden: true },
      { consumer: 'worker-escalation', engineId: 'gone', engine: undefined, overridden: true },
      { consumer: 'compaction-jev', engineId: 'laya', engine: LAYA, overridden: false },
      { consumer: 'toString', engineId: 'laya', engine: LAYA, overridden: false },
    ])
    expect(ignoredOverrides(view)).toEqual([{ consumer: 'undeclared', engineId: 'typesafe' }])
  })

  it('reads the router\'s gate for an engine from its operating points and the engine\'s calibration', () => {
    const router = namespace('model-router', { operatingPoints: [
      null,
      'not a point',
      { engine: 'shield', downgradeThreshold: 0.8, downgradeMargin: 0.1 },
      { engine: 'typesafe', downgradeThreshold: 0.8, downgradeMargin: 0.1, calibratedBy: '' },
      { engine: 'laya', downgradeThreshold: 0.72, downgradeMargin: 0.08, calibratedBy: 'routing-eval-2026-09' },
    ] })
    const verbalized = { ...TYPESAFE, id: 'llm', calibration: 'verbalized' } as never
    expect(routingCalibration(router, LAYA)).toEqual({ kind: 'calibrated', by: 'routing-eval-2026-09' })
    expect(routingCalibration(router, { ...LAYA, id: 'shield' } as never)).toEqual({ kind: 'point' })
    expect(routingCalibration(router, TYPESAFE)).toEqual({ kind: 'point' })
    expect(routingCalibration(router, { ...TYPESAFE, id: 'gone' } as never)).toEqual({ kind: 'global' })
    expect(routingCalibration(router, verbalized)).toEqual({ kind: 'refused' })
    expect(routingCalibration(namespace('model-router', { operatingPoints: [{ engine: 'llm', acceptVerbalized: true, calibratedBy: 'eval' }] }), verbalized))
      .toEqual({ kind: 'calibrated', by: 'eval' })
    expect(routingCalibration(namespace('model-router', { operatingPoints: 'none' }), LAYA)).toEqual({ kind: 'global' })
    expect(routingCalibration(namespace('model-router', null), LAYA)).toEqual({ kind: 'global' })
    expect(routingCalibration(null, LAYA)).toEqual({ kind: 'global' })
  })
})
