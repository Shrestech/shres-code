/** Read-only Remote projection of the remote registry for trusted client RPCs. */

import { TypertRemoteService, Remote } from '@shres-code/shres-code-typert-protocol'
import type { Context } from '@shres-code/cordis'
import { resolveRegistryPath } from './home.ts'
import { loadRegistry } from './registry.ts'
import type { RemoteRegistrySnapshot } from './types.ts'

export type { RemoteEntryView, RemoteRegistrySnapshot } from './types.ts'

/**
 * Serve the remote registry as the `remoteControl` Remote namespace. The
 * projection is read-only: connecting and mutating stay CLI-gated until the
 * connect-flow PR mounts the gesture-token authority.
 */
export class RemoteControlGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'remoteControl')
  }

  /**
   * Read the registry file on every call; a missing file is the empty set and
   * never an error, so a fresh installation renders an empty Remote group.
   * @returns Current registry entries in registry order.
   */
  @Remote('list')
  async list(): Promise<RemoteRegistrySnapshot> {
    const entries = await loadRegistry(resolveRegistryPath())
    return {
      entries: [...entries.values()].map((entry) => ({
        id: entry.id,
        target: entry.target,
        remotePort: entry.remotePort,
        fingerprint: entry.fingerprint,
        lastConnectedAt: entry.lastConnectedAt,
        createdAt: entry.createdAt,
      })),
    }
  }
}

export default RemoteControlGateway