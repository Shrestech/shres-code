// @vitest-environment jsdom
/**
 * ui-browserskill browser half on a real cordis Context with fake
 * slots/locale/remote faces: the plugin registers exactly one keyed Plugins
 * entry, its inject face unwraps the generated receipts and forwards
 * to the browserSkill namespace, registration disposal rides the plugin
 * fiber (HMR safety), and a re-apply after disposal leaves one entry — never
 * a duplicate.
 */
import { Context, Service } from '@shres-code/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import type { BrowserSkillStatus } from '@shres-code/shres-code-api-remotes/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { BrowserSkillSettingsSectionInjected } from '../src/client/index.ts'

const contexts: Context[] = []
const BUNDLE_NAME = '@shres-code/shres-code-browser-bundle'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The status value the fake namespace answers. */
const STATUS: BrowserSkillStatus = {
  state: { kind: 'absent' },
  consent: {
    downloads: [],
    extensionPermissions: [],
    extensionHostPermissions: [],
    installDir: '/home/.shres/browserskill',
    profileDir: '/home/.shres/browserskill/profile',
    updateManifestUrl: 'https://example.com/manifest.json',
  },
}

interface Recorded {
  method: string
  args: unknown[]
}

/**
 * Boot the plugin over fake faces. The namespace records every call and
 * answers ok receipts, exactly the shape the generated remote client hands
 * the inject face.
 */
async function bench(failing: Record<string, { code: string; message: string }> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const calls: Recorded[] = []
  const answer = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    const fail = failing[method]
    if (fail !== undefined) return Promise.resolve({ ok: false as const, error: fail })
    return Promise.resolve({ ok: true, value: method === 'browserSkill/begin' ? { token: 'tok-1', expiresAt: 'x' } : STATUS })
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.browserSkill', {
    status: answer('browserSkill/status'),
    begin: answer('browserSkill/begin'),
    provision: answer('browserSkill/provision'),
    open: answer('browserSkill/open'),
    close: answer('browserSkill/close'),
    reset: answer('browserSkill/reset'),
    uninstall: answer('browserSkill/uninstall'),
  })
  await ctx.plugin(SlotRegistry).await()
  // The generic Plugins manager owns the keyed feature slot; the test
  // reproduces that declaration so the inject seat resolves.
  ctx.slots.register({
    name: 'root',
    children: { 'settings.plugins.bundle': { kind: 'keyed', scope: 'root' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    calls,
    fiber,
    entry: () => ctx.slots.entries('settings.plugins.bundle')[0],
    face: () => ctx.slots.entries('settings.plugins.bundle')[0]?.inject as unknown as () => BrowserSkillSettingsSectionInjected,
  }
}

describe('ui-browserskill browser plugin', () => {
  it('registers one BrowserSkill feature entry with the bundle key', async () => {
    const b = await bench()
    const entry = b.entry()
    expect(entry?.options).toMatchObject({ key: BUNDLE_NAME })
    expect(entry?.locale).toBe(NS)
  })

  it('forwards every inject-face verb to the browserSkill namespace and unwraps receipts', async () => {
    const b = await bench()
    const verbs = b.face()()
    await verbs.status()
    const { token } = await verbs.begin('uninstall', true)
    await verbs.provision(token)
    await verbs.openBrowser(token)
    await verbs.closeBrowser(token)
    await verbs.reset(token)
    await verbs.uninstall(token, true)
    expect(b.calls.map(call => call.method)).toEqual([
      'browserSkill/status',
      'browserSkill/begin',
      'browserSkill/provision',
      'browserSkill/open',
      'browserSkill/close',
      'browserSkill/reset',
      'browserSkill/uninstall',
    ])
    expect(b.calls[1]?.args).toEqual([{ verb: 'uninstall', keepProfile: true }])
    expect(b.calls[5]?.args).toEqual([{ token: 'tok-1' }])
  })

  it('omits an absent profile choice and preserves an explicit false choice', async () => {
    const b = await bench()
    const verbs = b.face()()
    await verbs.begin('reset')
    await verbs.begin('uninstall', false)
    expect(b.calls.map(call => call.args)).toEqual([
      [{ verb: 'reset' }],
      [{ verb: 'uninstall', keepProfile: false }],
    ])
  })

  it('throws a namespaced error when a namespace receipt fails', async () => {
    const b = await bench({ 'browserSkill/status': { code: 'GESTURE_REFUSED', message: 'no unspent gesture' } })
    await expect(b.face()().status()).rejects.toThrow('browserSkill.status failed: GESTURE_REFUSED: no unspent gesture')
  })

  it('removes the registration with the fiber and re-applies without duplicates', async () => {
    const b = await bench()
    expect(b.ctx.slots.entries('settings.plugins.bundle')).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('settings.plugins.bundle')).toHaveLength(0)
    // The HMR re-run mounts a fresh plugin fiber over the same context.
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.ctx.slots.entries('settings.plugins.bundle')).toHaveLength(1)
  })
})
