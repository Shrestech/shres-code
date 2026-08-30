/**
 * `shres remote` — alias registry and hardened SSH-tunnel control for
 * VS Code-style remote connect, over the same remote-control core the host
 * plugin face will reuse in a later PR.
 * @module @shres-code/shres-code-remote-cli
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import * as rc from '@shres-code/shres-code-host-remote-control'

/**
 * Read this controller's own version as the local side of the version check.
 * @returns the app package version string.
 */
function readCliVersion(): string {
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version
}

/**
 * Run one `shres remote` invocation; pure over the registry plus the ssh
 * runner, never booting a profile.
 * @param command - parsed remote subcommand.
 * @returns process exit code.
 */
export async function runRemoteCli(command: rc.RemoteCliCommand): Promise<number> {
  try {
    switch (command.kind) {
      case 'remote-add': {
        const entry: rc.RemoteEntry = {
          id: rc.asRemoteId(command.alias),
          target: rc.asRemoteTarget(command.target),
          remotePort: rc.asRemotePort(command.remotePort),
          version: rc.REGISTRY_VERSION,
          fingerprint: null,
          createdAt: new Date().toISOString(),
          lastConnectedAt: null,
        }
        await rc.upsertEntry(rc.resolveRegistryPath(), entry)
        console.log(`remote "${command.alias}" (${command.target}) saved; daemon port ${String(command.remotePort)}`)
        return 0
      }
      case 'remote-list': {
        const entries = await rc.loadRegistry(rc.resolveRegistryPath())
        for (const entry of entries.values()) {
          const never = entry.lastConnectedAt === null ? 'never' : entry.lastConnectedAt
          console.log(`${entry.id}\t${entry.target}\tdaemon:${String(entry.remotePort)}\tlast:${never}`)
        }
        return 0
      }
      case 'remote-remove': {
        const removed = await rc.removeEntry(rc.resolveRegistryPath(), rc.asRemoteId(command.alias))
        if (!removed) throw new rc.RemoteControlError('unknown-alias', `remote "${command.alias}" is not registered`)
        console.log(`remote "${command.alias}" removed`)
        return 0
      }
      case 'remote-connect': {
        const path = rc.resolveRegistryPath()
        const entries = await rc.loadRegistry(path)
        const id = rc.asRemoteId(command.alias)
        const entry = entries.get(id)
        if (entry === undefined) throw new rc.RemoteControlError('unknown-alias', `remote "${command.alias}" is not registered; add it first`)
        const localPort = command.localPort ?? await rc.allocateLoopbackPort()
        const spec = { id, target: entry.target, remotePort: entry.remotePort, localPort, controlPath: resolve(rc.resolveRunDir(), `${id}.sock`) }
        const tunnel = await rc.openTunnel(rc.nodeSshRunner(), spec, entry, {
          allowVersionSkew: command.allowVersionSkew,
          localVersion: readCliVersion(),
          forceFingerprint: command.forceFingerprint,
        })
        await rc.upsertEntry(path, { ...entry, fingerprint: tunnel.fingerprint, lastConnectedAt: new Date().toISOString() })
        if (command.allowVersionSkew && tunnel.version !== readCliVersion()) {
          console.error(`warning: remote daemon ${tunnel.version} differs from this controller ${readCliVersion()}; behavior may drift`)
        }
        console.log(`connected to "${id}"; Remote GUI: http://127.0.0.1:${String(localPort)} (daemon ${tunnel.version})`)
        return await new Promise<never>(() => process.once('SIGINT', () => { void tunnel.dispose().then(() => process.exit(0)) }))
      }
    }
  } catch (error) {
    if (error instanceof rc.RemoteControlError) {
      console.error(`shres remote: ${error.message}`)
      return 1
    }
    throw error
  }
}
