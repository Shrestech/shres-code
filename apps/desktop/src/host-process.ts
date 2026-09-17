/**
 * The host child process: spawn, pipe plumbing, readiness, and disposal. The
 * Electron main process owns exactly one host at a time.
 * @module @shres-code/shres-code-desktop/host-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '@shres-code/shres-code-desktop-host'
import { ShellResponseDecoder, type ShellResponseFrame } from './host-protocol.ts'

/** Events the host child emits over Node IPC. */
export type HostProcessEvent =
  | { readonly type: 'ready'; readonly protocolVersion: number; readonly appVersion: string }
  | { readonly type: 'fatal'; readonly message: string }

/** Controller over one spawned desktop host. */
export interface HostProcessHandle {
  /** Resolved after the host's ready event (protocol version verified). */
  readonly ready: Promise<{ appVersion: string }>
  /** Resolve the host's response pipe frames; one listener per process. */
  onFrame(listener: (frame: ShellResponseFrame) => void): void
  /** Write raw request-frame bytes to the host's request pipe. */
  write(bytes: Buffer): boolean
  /** Tell the host to shut down and await its exit. */
  dispose(): Promise<void>
}

/**
 * Spawn the desktop host child with its byte pipes on fds 3/4.
 * @param nodeBinary - Node executable to run the host under (dev: the repo's;
 *   packaged: the bundled runtime's).
 * @param hostEntry - absolute path of the built desktop-host index.js.
 * @param runtimeDir - the installed shres packages tree.
 * @param projectDir - the desktop-owned profile directory.
 * @param options - development-only linked-package allowance.
 * @returns the host controller.
 */
export function startHostProcess(
  nodeBinary: string,
  hostEntry: string,
  runtimeDir: string,
  projectDir: string,
  options: { allowLinkedProfile?: boolean } = {},
): HostProcessHandle {
  const args = [hostEntry, runtimeDir, projectDir, ...(options.allowLinkedProfile === true ? ['--allow-linked-profile'] : [])]
  const child = spawn(nodeBinary, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  }) as ChildProcess & { stdin: null; stdout: import('node:stream').Readable; stderr: import('node:stream').Readable }
  const decoder = new ShellResponseDecoder()
  const frames: ((frame: ShellResponseFrame) => void)[] = []
  child.stdio[4]?.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) for (const listener of frames) listener(frame)
  })
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[shres-desktop-host] ${chunk}`))
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[shres-desktop-host] ${chunk}`))
  let exited: Promise<void> | undefined
  const exit = (): Promise<void> => {
    exited ??= new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('exit', () => resolve())
    })
    return exited
  }
  const ready = new Promise<{ appVersion: string }>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      const event = message as HostProcessEvent
      if (event.type === 'ready') {
        if (event.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
          reject(new Error(`shres desktop: host protocol ${event.protocolVersion} != shell ${DESKTOP_HOST_PROTOCOL_VERSION}`))
          return
        }
        child.off('message', onMessage)
        resolve({ appVersion: event.appVersion })
        return
      }
      if (event.type === 'fatal') {
        child.off('message', onMessage)
        reject(new Error(`shres desktop: host failed: ${event.message}`))
      }
    }
    child.on('message', onMessage)
    void exit().then(() => reject(new Error('shres desktop: host exited before readiness')))
  })
  return {
    ready,
    onFrame(listener) { frames.push(listener) },
    write(bytes) { return (child.stdio[3] as import('node:stream').Writable).write(bytes) },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.send({ type: 'shutdown' })
        await Promise.race([exit(), once(child, 'disconnect').then(() => undefined)])
      }
      await exit()
    },
  }
}
