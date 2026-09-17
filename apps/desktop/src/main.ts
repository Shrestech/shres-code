/**
 * Electron main: the window, the privileged shres-app:// scheme, and request
 * forwarding into the desktop host's byte pipes. Dev-mode detection is
 * `!app.isPackaged`; packaging arrives with stage A's builder config.
 * @module @shres-code/shres-code-desktop
 */

import { app, BrowserWindow, protocol } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHostProcess, type HostProcessHandle } from './host-process.ts'
import { encodeRequestCancel, encodeRequestData, encodeRequestEnd, encodeRequestStart, type ShellResponseFrame } from './host-protocol.ts'

const SCHEME = 'shres-app'
const HOST_ORIGIN = `${SCHEME}://app`
const here = fileURLToPath(new URL('.', import.meta.url))
const dev = !app.isPackaged

interface StreamState {
  chunks: Uint8Array[]
  controller?: ReadableStreamDefaultController<Uint8Array>
  settled: boolean
}

/**
 * The desktop application: one host child, one window, and the scheme handler
 * bridging Electron fetches to the host's framed pipes.
 */
class DesktopApp {
  private host: HostProcessHandle | undefined
  private readonly streams = new Map<number, StreamState>()
  private nextStreamId = 0

  async boot(): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }
    protocol.registerSchemesAsPrivileged([
      { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    ])
    await app.whenReady()
    const projectDir = join(app.getPath('userData'), 'profile')
    mkdirSync(projectDir, { recursive: true })
    const nodeBinary = process.env.SHRES_DESKTOP_NODE_BINARY ?? process.execPath
    const runtimeDir = process.env.SHRES_DESKTOP_RUNTIME_DIR ?? resolve(here, '../..')
    this.host = startHostProcess(nodeBinary, resolve(here, '../../desktop-host/lib/index.js'), runtimeDir, projectDir, { allowLinkedProfile: dev })
    this.host.onFrame(frame => this.onFrame(frame))
    await this.host.ready
    protocol.handle(SCHEME, request => this.forward(request))
    await this.openWindow()
  }

  private async openWindow(): Promise<void> {
    const window = new BrowserWindow({ width: 1440, height: 900, title: 'Shres Code' })
    if (dev) window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }))
    await window.loadURL(`${HOST_ORIGIN}/`)
  }

  private async forward(request: Request): Promise<Response> {
    const host = this.host
    if (host === undefined) return new Response('host unavailable', { status: 503 })
    const streamId = ++this.nextStreamId
    const url = new URL(request.url)
    const headers: [string, string][] = []
    request.headers.forEach((value, name) => { headers.push([name, value]) })
    const hasBody = request.body !== null
    host.write(encodeRequestStart(streamId, {
      url: `${HOST_ORIGIN}${url.pathname}${url.search}`,
      method: request.method,
      headers,
      hasBody,
    }))
    const state: StreamState = { chunks: [], settled: false }
    this.streams.set(streamId, state)
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.controller = controller
        for (const chunk of state.chunks.splice(0)) controller.enqueue(chunk)
      },
      cancel: () => { host.write(encodeRequestCancel(streamId)) },
    })
    this.bodies.set(streamId, body)
    if (hasBody) {
      void (async () => {
        const reader = request.body!.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (value !== undefined) host.write(encodeRequestData(streamId, value))
            if (done) break
          }
          host.write(encodeRequestEnd(streamId))
        } catch {
          host.write(encodeRequestCancel(streamId))
        }
      })()
    } else {
      host.write(encodeRequestEnd(streamId))
    }
    return new Promise<Response>((resolve, reject) => {
      state.settled = false
      const finish = (make: () => Response): void => {
        if (state.settled) return
        state.settled = true
        resolve(make())
      }
      ;(state as StreamState & { finish?: typeof finish }).finish = finish
      ;(state as StreamState & { reject?: typeof reject }).reject = reject
    })
  }

  private onFrame(frame: ShellResponseFrame): void {
    const state = this.streams.get(frame.streamId)
    if (state === undefined) return
    if (frame.type === 'data') {
      state.chunks.push(frame.data)
      state.controller?.enqueue(frame.data)
      return
    }
    if (frame.type === 'start') {
      const headers = new Headers(frame.headers)
      const finish = (state as StreamState & { finish?: (make: () => Response) => void }).finish
      const reject = (state as StreamState & { reject?: (error: Error) => void }).reject
      if (finish !== undefined && reject !== undefined) {
        finish(() => new Response(frame.hasBody ? this.bodyOf(frame.streamId) : null, { status: frame.status, headers }))
      }
      return
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.streamId)
      this.bodies.delete(frame.streamId)
      state.controller?.close()
      return
    }
    this.streams.delete(frame.streamId)
    this.bodies.delete(frame.streamId)
    const error = new Error(frame.message ?? 'host stream failed')
    const reject = (state as StreamState & { reject?: (error: Error) => void }).reject
    if (!state.settled && reject !== undefined) {
      state.settled = true
      reject(error)
    } else {
      state.controller?.error(error)
    }
  }

  private bodyOf(streamId: number): ReadableStream<Uint8Array> {
    const state = this.streams.get(streamId)
    if (state === undefined) throw new Error('shres desktop: body requested for an ended stream')
    // The ReadableStream handed to Response was created in forward(); this
    // accessor exists so the start-frame arm can pass the very same stream.
    return this.bodies.get(streamId) as ReadableStream<Uint8Array>
  }

  private readonly bodies = new Map<number, ReadableStream<Uint8Array>>()

  async shutdown(): Promise<void> {
    for (const [streamId, state] of this.streams) state.controller?.error(new Error('shres desktop: shutting down'))
    this.streams.clear()
    this.bodies.clear()
    await this.host?.dispose()
  }
}

const desktop = new DesktopApp()
void desktop.boot().catch((error) => {
  process.stderr.write(`shres desktop: ${error instanceof Error ? error.message : String(error)}\n`)
  app.exit(1)
})
app.on('second-instance', () => { for (const window of BrowserWindow.getAllWindows()) window.focus() })
app.on('window-all-closed', () => { void desktop.shutdown().finally(() => app.quit()) })
