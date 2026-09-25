import { describe, expect, it } from 'vitest'
import { classifierEnabled, engineOption, initialMode, isRemote, lastExitText, modelsText, numberAt, stateLabel } from '../src/client/view.ts'
import { en } from '../src/client/locales.ts'
import { LAYA, LAYA_VIEW, TYPESAFE, namespace } from './fixtures.client.ts'

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
})
