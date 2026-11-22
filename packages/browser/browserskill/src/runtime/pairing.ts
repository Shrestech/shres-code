/**
 * Local pairing over the pinned CLI: mint the one-use link the user's browser
 * extension consumes, read the device grants, and revoke or rotate them. The
 * link carries a secret, so it is returned to the caller and never logged,
 * persisted, or placed in an event.
 * @module @shres-code/shres-code-browserskill/runtime/pairing
 */

import { BskCommandError, type BskRunner } from './runner.ts'

/** One device grant as the daemon reports it. */
export interface PairingDevice {
  /** Opaque device id the daemon minted for this pairing. */
  deviceId: string
  /** `unactivated` until the extension consumes its link, then `activated`. */
  status: 'unactivated' | 'activated' | 'revoked'
  /** Browser that activated the grant, when one did. */
  browserId?: string
  /** ISO 8601 time the grant was activated. */
  activatedAt?: string
  /** ISO 8601 deadline for an unactivated link. */
  expiresAt?: string
  /** Label the extension reported, when it sent one. */
  label: string
  /** Rotation generation, bumped by `rotate`. */
  gen: number
}

/** The link the user's browser consumes, and the device it activates. */
export interface PairingLink {
  /** Complete `ws://127.0.0.1:<port>/#bsk-local.v1…` URL, including the secret. */
  url: string
  /** Device id the daemon minted for this link. */
  deviceId: string
}

/**
 * Parse one `daemon devices --json` reply.
 * @param raw - the decoded JSON array.
 * @returns the validated device grants, in daemon order.
 * @throws Error when a record is malformed: a wrong shape must fail loud rather than read as "no devices".
 */
export function parseDevices(raw: unknown): PairingDevice[] {
  if (!Array.isArray(raw)) throw new Error('browserskill pairing: devices reply is not an array')
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('browserskill pairing: device record is not an object')
    const wire = item as Record<string, unknown>
    const deviceId = wire.device_id
    const status = wire.status
    if (typeof deviceId !== 'string' || (status !== 'unactivated' && status !== 'activated' && status !== 'revoked')) {
      throw new Error('browserskill pairing: device record lacks an id or a known status')
    }
    return {
      deviceId,
      status,
      label: typeof wire.label === 'string' ? wire.label : '',
      gen: typeof wire.gen === 'number' ? wire.gen : 0,
      ...typeof wire.browser_id === 'string' ? { browserId: wire.browser_id } : {},
      ...typeof wire.activated_at === 'string' ? { activatedAt: wire.activated_at } : {},
      ...typeof wire.expires_at === 'string' ? { expiresAt: wire.expires_at } : {},
    }
  })
}

/** The local-link prefix the extension recognizes in a URL fragment. */
const LINK_FRAGMENT_PREFIX = '#bsk-local.v1.'

/**
 * Validate one pairing URL and read the device id it carries.
 * @param url - the line `daemon pair` printed.
 * @returns the link, or `undefined` when the line is not a local pairing link.
 */
export function parsePairingLink(url: string): PairingLink | undefined {
  const trimmed = url.trim()
  if (!trimmed.startsWith('ws://127.0.0.1:')) return undefined
  const hash = trimmed.indexOf(LINK_FRAGMENT_PREFIX)
  if (hash === -1) return undefined
  const deviceId = trimmed.slice(hash + LINK_FRAGMENT_PREFIX.length).split('.')[0]
  return deviceId === undefined || deviceId.length === 0 ? undefined : { url: trimmed, deviceId }
}

/**
 * Read the daemon's device grants.
 * @param runner - runner bound to the owned daemon.
 * @param signal - caller abort.
 * @returns the grants, empty when none exist.
 */
export async function listPairingDevices(runner: BskRunner, signal?: AbortSignal): Promise<PairingDevice[]> {
  const reply = await runner.runJson(['daemon', 'devices', '--json'], raw => raw, undefined, signal)
    .catch((error: unknown) => {
      // A daemon that predates pairing reports an unknown subcommand; treat it
      // as "no pairings" rather than failing the whole status read.
      if (error instanceof BskCommandError) return undefined
      throw error
    })
  return reply === undefined ? [] : parseDevices(reply)
}

/**
 * Mint a one-use pairing link.
 * @param runner - runner bound to the owned daemon.
 * @param signal - caller abort.
 * @returns the link and its device id.
 * @throws Error when the daemon prints something that is not a local link.
 */
export async function mintPairingLink(runner: BskRunner, signal?: AbortSignal): Promise<PairingLink> {
  const line = await runner.runJson(['daemon', 'pair'], raw => raw, undefined, signal)
  const text = typeof line === 'string' ? line : ''
  const link = parsePairingLink(text)
  if (link === undefined) throw new Error('browserskill pairing: the daemon did not print a local pairing link')
  return link
}

/**
 * Revoke one device grant.
 * @param runner - runner bound to the owned daemon.
 * @param deviceId - grant to revoke.
 * @param signal - caller abort.
 */
export async function revokePairingDevice(runner: BskRunner, deviceId: string, signal?: AbortSignal): Promise<void> {
  await runner.run(['daemon', 'revoke', deviceId], undefined, signal)
}

/**
 * Revoke every grant and outstanding link.
 * @param runner - runner bound to the owned daemon.
 * @param signal - caller abort.
 */
export async function revokeAllPairings(runner: BskRunner, signal?: AbortSignal): Promise<void> {
  await runner.run(['daemon', 'revoke', '--all'], undefined, signal)
}
