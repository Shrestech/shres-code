import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import BrowserSkillGateway, {
  BrowserSkillError,
} from '../src/gateway.ts'
import type { BrowserSkillErrorCode, BrowserSkillStartOutcome } from '../src/types.ts'
import type {
  BrowserSkillControl,
  BrowserSkillOperationId,
  BrowserSkillRefusal,
  BrowserSkillStartResult,
  BrowserSkillStatus,
  BrowserSkillToken,
  BrowserSkillVerb,
} from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The consent facts every status snapshot carries. */
function consent() {
  return {
    downloads: [
      { artifact: 'bsk' as const, version: '0.3.1', url: 'https://example.com/bsk.tar.gz', sha256: 'aaaa1111' },
      { artifact: 'extension' as const, version: '0.3.1', url: 'https://example.com/ext.zip', sha256: 'bbbb2222' },
    ],
    extensionPermissions: ['debugger', 'tabs'],
    extensionHostPermissions: ['https://*/*'],
    installDir: '/home/.shres/browserskill',
    profileDir: '/home/.shres/browserskill/profile',
    updateManifestUrl: 'https://example.com/manifest.json',
  }
}

/** A status snapshot; every test overrides the slice it drives. */
function statusFixture(overrides: Partial<BrowserSkillStatus> = {}): BrowserSkillStatus {
  return {
    state: { kind: 'absent' },
    consent: consent(),
    ...overrides,
  }
}

/**
 * Fabricate the runtime control seam with the ratified acceptance contract:
 * start answers synchronously with the verdict the test scripted, and every
 * verdict is recorded as a call so tests can bind gestures to starts.
 */
function fabricatedControl(script: { startVerdict?: BrowserSkillStartResult } = {}) {
  const current = { ...script }
  let status: BrowserSkillStatus = statusFixture()
  // Annotated with the full return type so the single start implementation
  // is checked against both overloads of the control seam.
  const control: BrowserSkillControl & {
    calls: { verb: BrowserSkillVerb; keepProfile?: boolean }[]
    statusCalls: number
    setStatus: (next: BrowserSkillStatus) => void
    setStartVerdict: (verdict: BrowserSkillStartResult) => void
  } = {
    calls: [],
    statusCalls: 0,
    setStatus: (next: BrowserSkillStatus) => { status = next },
    setStartVerdict: (verdict: BrowserSkillStartResult) => { current.startVerdict = verdict },
    status() {
      control.statusCalls++
      return status
    },
    start(verb: BrowserSkillVerb, options?: { keepProfile: boolean }): BrowserSkillStartResult {
      control.calls.push({ verb, ...options })
      return current.startVerdict ?? {
        accepted: true,
        operationId: 'op-' + String(control.calls.length) as BrowserSkillOperationId,
        settled: new Promise(() => {}),
      }
    },
  }
  return control
}

/** Construct the gateway directly over the control, as the composition entry does. */
function harness(control: ReturnType<typeof fabricatedControl>): BrowserSkillGateway {
  const ctx = new Context()
  contexts.push(ctx)
  return new BrowserSkillGateway(ctx, control)
}

/** Assert one synchronous call is refused with the given caller-misuse code. */
function expectRefused(run: () => unknown, code: BrowserSkillErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserSkillError)
    expect((error as BrowserSkillError).code).toBe(code)
    return
  }
  throw new Error('expected the call to throw ' + code)
}

/** Mint one grant for the verb and choice, as the wire caller would. */
function grant(
  gateway: BrowserSkillGateway,
  verb: 'provision' | 'open' | 'close' | 'reset' | 'uninstall',
  keepProfile = false,
): BrowserSkillToken {
  return gateway.begin({ verb, ...(verb === 'uninstall' ? { keepProfile } : {}) }).token
}

/** The own enumerable keys of one verdict, in insertion order. */
function keysOf(value: BrowserSkillStartOutcome): string[] {
  return Object.keys(value)
}

describe('BrowserSkillGateway', () => {
  it('exports the gateway as the module entry and the misuse error', () => {
    expect(BrowserSkillGateway.name).toBe('BrowserSkillGateway')
    expect(new BrowserSkillError('gesture-refused', 'm').code).toBe('gesture-refused')
  })

  it('exposes exactly the seven ratified methods the connection pin names', () => {
    const gateway = harness(fabricatedControl())
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'browserSkill', namespace: 'browserSkill' })
    expect(remoteMethods(gateway).map(marker => marker.method)).toEqual([
      'status', 'begin', 'provision', 'open', 'close', 'reset', 'uninstall',
    ])
  })

  it('serves status straight from the shared runtime', () => {
    const control = fabricatedControl()
    const gateway = harness(control)
    expect(gateway.status()).toMatchObject({ state: { kind: 'absent' } })
    expect(control.statusCalls).toBe(1)
  })

  it('binds begin grants to a fixed gesture window', () => {
    const gateway = harness(fabricatedControl())
    const granted = gateway.begin({ verb: 'provision' })
    expect(granted.token).toMatch(/^[0-9a-f]{32}$/)
    const window = new Date(granted.expiresAt).getTime() - Date.now()
    expect(window).toBeGreaterThan(0)
    expect(window).toBeLessThanOrEqual(120_000)
  })

  it('refuses a keepProfile choice everywhere except uninstall', () => {
    const gateway = harness(fabricatedControl())
    for (const verb of ['provision', 'open', 'close', 'reset'] as const) {
      expect(() => gateway.begin({ verb, keepProfile: true })).toThrow('takes no keepProfile choice')
    }
    expect(gateway.begin({ verb: 'uninstall', keepProfile: true }).token).toMatch(/^[0-9a-f]{32}$/)
    expect(gateway.begin({ verb: 'uninstall', keepProfile: false }).token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses mutations without an unspent, verb- and choice-matched gesture token', () => {
    const control = fabricatedControl()
    const gateway = harness(control)
    expectRefused(() => gateway.provision({ token: 'absent' as never }), 'gesture-refused')
    expect(control.calls).toHaveLength(0)
    // A token minted for another verb is spent by the failed attempt and
    // cannot authorize the right verb afterwards.
    const wrongVerb = grant(gateway, 'open')
    expectRefused(() => gateway.provision({ token: wrongVerb }), 'gesture-refused')
    expectRefused(() => gateway.open({ token: wrongVerb }), 'gesture-refused')
    // Reset tokens authorize the unconditional delete; uninstall tokens bind
    // the keep choice, so a keep token cannot drive a delete and vice versa.
    const keepUninstall = grant(gateway, 'uninstall', true)
    expectRefused(() => gateway.uninstall({ token: keepUninstall, keepProfile: false }), 'gesture-refused')
    expectRefused(() => gateway.uninstall({ token: grant(gateway, 'uninstall', false), keepProfile: true }), 'gesture-refused')
    expect(gateway.reset({ token: grant(gateway, 'reset') })).toEqual({ accepted: true, operationId: 'op-1' })
    expect(control.calls[0]).toEqual({ verb: 'reset' })
    expect(gateway.uninstall({ token: grant(gateway, 'uninstall', true), keepProfile: true }))
      .toEqual({ accepted: true, operationId: 'op-2' })
    expect(control.calls[1]).toEqual({ verb: 'uninstall', keepProfile: true })
    // The other flow verbs take no choice and forward none.
    expect(gateway.close({ token: grant(gateway, 'close') })).toEqual({ accepted: true, operationId: 'op-3' })
    expect(control.calls[2]).toEqual({ verb: 'close' })
  })

  it('denies a replayed token through the actual spending method', () => {
    const control = fabricatedControl()
    const gateway = harness(control)
    const token = grant(gateway, 'provision')
    gateway.provision({ token })
    expectRefused(() => gateway.provision({ token }), 'gesture-refused')
    expect(control.calls).toHaveLength(1)
    const uninstallToken = grant(gateway, 'uninstall', false)
    gateway.uninstall({ token: uninstallToken, keepProfile: false })
    expectRefused(() => gateway.uninstall({ token: uninstallToken, keepProfile: false }), 'gesture-refused')
    expect(control.calls).toHaveLength(2)
  })

  it('serializes only the accepted operation id; the settled promise never crosses the wire', () => {
    const gateway = harness(fabricatedControl())
    const verdict = gateway.provision({ token: grant(gateway, 'provision') })
    expect(verdict).toEqual({ accepted: true, operationId: 'op-1' })
    expect(keysOf(verdict)).toEqual(['accepted', 'operationId'])
    expect('settled' in verdict).toBe(false)
  })

  it('answers before the operation settles and never with the settled promise', () => {
    const control = fabricatedControl()
    const gateway = harness(control)
    const token = grant(gateway, 'open')
    const verdict = gateway.open({ token })
    // The fabricated runtime never settles its operation; the answer already
    // exists, so no spending method waits on lifecycle work.
    expect(verdict.accepted).toBe(true)
    expect(control.calls).toEqual([{ verb: 'open' }])
  })

  it('serializes an in-band refusal instead of throwing or answering an operation', () => {
    const inProgress: BrowserSkillRefusal = { kind: 'operation-in-progress' }
    const control = fabricatedControl({ startVerdict: { accepted: false, refusal: inProgress } })
    const gateway = harness(control)
    const verdict = gateway.provision({ token: grant(gateway, 'provision') })
    expect(verdict).toEqual({ accepted: false, refusal: inProgress })
    expect(keysOf(verdict)).toEqual(['accepted', 'refusal'])
    const disposed: BrowserSkillRefusal = { kind: 'disposed', detail: 'the BrowserSkill runtime has been disposed' }
    control.setStartVerdict({ accepted: false, refusal: disposed })
    expect(gateway.open({ token: grant(gateway, 'open') })).toEqual({ accepted: false, refusal: disposed })
  })

  it('has no disposal of its own: the composition entry owns the runtime effect', () => {
    const gateway = harness(fabricatedControl())
    expect(gateway).not.toHaveProperty('dispose')
    expect(typeof (BrowserSkillGateway.prototype as { dispose?: unknown }).dispose).toBe('undefined')
  })
})
