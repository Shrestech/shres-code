// @vitest-environment jsdom
/**
 * The settings.section owner-props merge, over the production renderer: the
 * shell's owner share carries close (leave Settings) and the slot renderer
 * spreads owner props over the injected face, so the BrowserSkill face names
 * its launch controls closeBrowser/openBrowser. Clicking "Close browser" must
 * reach the browserSkill namespace exactly once and never call the owner's
 * close. Mounted through the SlotTestRuntime harness — a real Cordis Context,
 * the real SlotRegistry, and the real web-react renderer — so the merge order
 * under test is the shipping one, not a test-local reimplementation.
 */

import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import type { BrowserSkillStatus } from '@shres-code/shres-code-api-remotes/client'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

usePinnedBrowserLanguages('en-US')

afterEach(cleanup)

/** A ready status snapshot; the close control renders only from this state. */
function readyStatus(): BrowserSkillStatus {
  return {
    state: { kind: 'ready', instanceId: 'inst-1' as never },
    consent: {
      downloads: [],
      extensionPermissions: [],
      extensionHostPermissions: [],
      installDir: '/home/.shres/browserskill',
      profileDir: '/home/.shres/browserskill/profile',
      updateManifestUrl: 'https://example.com/manifest.json',
    },
  }
}

/** Receipt answer helpers, the shape the generated remote client hands the inject face. */
function okVerdict(operationId: string) {
  return Promise.resolve({ ok: true as const, value: { accepted: true as const, operationId } })
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  // The settings shell owns the root and declares the section list slot; the
  // test reproduces exactly that declaration so the inject seat resolves.
  await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' } })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // A Service instance, not a plain object: cordis resolves the dotted
  // ctx.remote.browserSkill access through the remote service's proxy.
  new class extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }(runtime.ctx)
  const browserSkill = {
    status: vi.fn(() => Promise.resolve({ ok: true as const, value: readyStatus() })),
    begin: vi.fn(() => Promise.resolve({ ok: true as const, value: { token: 'tok-1', expiresAt: 'x' } })),
    provision: vi.fn(() => okVerdict('op-provision')),
    open: vi.fn(() => okVerdict('op-open')),
    close: vi.fn(() => okVerdict('op-close')),
    reset: vi.fn(() => okVerdict('op-reset')),
    uninstall: vi.fn(() => okVerdict('op-uninstall')),
  }
  runtime.ctx.provide('remote.browserSkill', browserSkill)
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, browserSkill }
}

describe('BrowserSkill section through the real settings.section merge', () => {
  it('clicking Close browser spends browserSkill.close exactly once and never the owner close', async () => {
    const { runtime, browserSkill } = await bench()
    const ownerClose = vi.fn()
    const view = runtime.renderSlot('settings.section', { close: ownerClose })
    const closeButton = await waitFor(() => {
      const el = view.view.getByRole('button', { name: en.closeAction })
      expect(el).toBeTruthy()
      return el
    })
    fireEvent.click(closeButton)
    await waitFor(() => {
      expect(browserSkill.close).toHaveBeenCalledTimes(1)
    })
    expect(browserSkill.begin).toHaveBeenCalledWith({ verb: 'close', keepProfile: false })
    expect(browserSkill.close).toHaveBeenCalledWith({ token: 'tok-1' })
    // The single-flight guard and the post-acceptance polls must not spend
    // the verb a second time.
    await act(async () => {})
    expect(browserSkill.close).toHaveBeenCalledTimes(1)
    // The owner share's close is the shell's leave-Settings affordance; the
    // browser control must never dispatch it.
    expect(ownerClose).not.toHaveBeenCalled()
    await runtime.dispose()
  })
})
