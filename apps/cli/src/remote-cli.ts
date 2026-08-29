/**
 * `shres remote` — alias registry and hardened SSH-tunnel control for
 * VS Code-style remote connect, over the same remote-control core the host
 * plugin face will reuse in a later PR.
 * @module @shres-code/shres-code-remote-cli
 */

import { execFile, spawn } from 'node:child_process'
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
 * Node adapter for the controller's runner seam: short executions are
 * piped-and-awaited; long-lived forwards are detached children with a
 * SIGTERM-then-SIGKILL disposer.
 * @returns the runner used by `shres remote connect`.
 */
function nodeSshRunner(): rc.SshRunner {
  return {
    async run(args) {
      return new Promise((resolveP, rejectP) => {
        execFile('ssh', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error === null) { resolveP({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) }); return }
          if (typeof error.code !== 'number') { rejectP(error); return }
          resolveP({ exitCode: error.code, stdout: String(stdout), stderr: String(stderr) })
        })
      })
    },
    spawn(args) {
      return new Promise((resolveP) => {
        const child = spawn('ssh', args, { stdio: 'ignore' })
        const disposer = async (): Promise<void> => {
          child.kill('SIGTERM')
          setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
          await new Promise<void>((resolveK) => { child.once('exit', () => resolveK()) })
        }
        resolveP({ pid: child.pid ?? 0, dispose: disposer })
      })
    },
  }
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
        if (!removed) throw new rc.RemoteControlError('invalid-alias', `remote "${command.alias}" is not registered`)
        console.log(`remote "${command.alias}" removed`)
        return 0
      }
      case 'remote-connect': {
        const path = rc.resolveRegistryPath()
        const entries = await rc.loadRegistry(path)
        const id = rc.asRemoteId(command.alias)
        const entry = entries.get(id)
        if (entry === undefined) throw new rc.RemoteControlError('invalid-alias', `remote "${command.alias}" is not registered; add it first`)
        const localPort = command.localPort ?? await rc.allocateLoopbackPort()
        const spec = { id, target: entry.target, remotePort: entry.remotePort, localPort, controlPath: resolve(rc.resolveRunDir(), `${id}.sock`) }
        const tunnel = await rc.openTunnel(nodeSshRunner(), spec, entry, {
          allowVersionSkew: command.allowVersionSkew,
          localVersion: readCliVersion(),
          forceFingerprint: command.forceFingerprint,
        })
        await rc.upsertEntry(path, { ...entry, fingerprint: tunnel.fingerprint, lastConnectedAt: new Date().toISOString() })
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
