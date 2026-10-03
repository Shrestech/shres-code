/**
 * Node-compatible child lifecycle and streaming custom-protocol carrier. The
 * shell owns exactly one host child: it spawns it with byte pipes on descriptors
 * 3 and 4 plus the lifecycle IPC channel, forwards `shres-app://app` requests
 * without buffering their bodies, and tears the child down on shutdown. A slow
 * response is queued up to {@link DESKTOP_RESPONSE_PIPE_BUFFER_BYTES} before
 * the shared response pipe pauses, so one unread body cannot stall the others.
 * @module @shres-code/shres-code-desktop/host-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
} from '@shres-code/shres-code-desktop-host/wire'
import {
  DesktopHostResponseDecoder,
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
  type DesktopHostCommand,
  type DesktopHostEvent,
  type DesktopHostResponseFrame,
} from './host-protocol.ts'

/**
 * Bytes one response body may queue in the shell before later frames for that
 * body wait beside the pipe. One unread event chunk is far below this, so it
 * does not stall other responses.
 */
export const DESKTOP_RESPONSE_STREAM_HIGH_WATER_BYTES = 256 * 1024

/**
 * Unread response bytes the shell holds across every stream before it pauses
 * the shared response pipe. Below this cap, a slow event downlink cannot stop
 * an unrelated API or asset response.
 */
export const DESKTOP_RESPONSE_PIPE_BUFFER_BYTES = 2 * 1024 * 1024

/** Characters of host stderr retained for the exit diagnostic. */
const STDERR_TAIL_CHARS = 64 * 1024

/** Runtime-tree path of the host child entry inside an installed shres runtime. */
const INSTALLED_HOST_ENTRY = ['node_modules', '@shres-code', 'shres-code-desktop-host', 'lib', 'index.js'] as const

/** Host entry the workspace builds for unpackaged launches, at apps/desktop-host/lib/index.js. */
const DEVELOPMENT_HOST_ENTRY = fileURLToPath(new URL('../../desktop-host/lib/index.js', import.meta.url))

interface HeldResponse {
  readonly chunks: Buffer[]
  index: number
  bytes: number
}

interface PendingResponse {
  readonly resolve: (response: Response) => void
  readonly reject: (error: Error) => void
  responseStarted: boolean
  responseEnded: boolean
  uploadOpen: boolean
  controller?: ReadableStreamDefaultController<Uint8Array>
  requestReader?: ReadableStreamDefaultReader<Uint8Array>
  removeAbort?: () => void
}

/**
 * Resolve the executable the child runs under.
 * @param environment - child environment; the SHRES_DESKTOP_NODE_BINARY variable overrides the default.
 * @returns the configured Node-compatible executable, else this process's own executable.
 */
function resolveNodeBinary(environment: NodeJS.ProcessEnv): string {
  const configured = environment.SHRES_DESKTOP_NODE_BINARY
  return configured === undefined || configured === '' ? process.execPath : configured
}

/**
 * Resolve the host entry inside one runtime tree. An installed runtime carries
 * the host package; an unpackaged development launch runs the workspace build of
 * apps/desktop-host directly.
 * @param runtimeDir - the installed shres runtime supplied by the application.
 * @returns the absolute path of the host child entry.
 */
function resolveHostEntry(runtimeDir: string): string {
  const installed = join(runtimeDir, ...INSTALLED_HOST_ENTRY)
  if (existsSync(installed)) return installed
  if (existsSync(DEVELOPMENT_HOST_ENTRY)) return DEVELOPMENT_HOST_ENTRY
  throw new Error(`shres desktop: the desktop host entry is missing at ${installed}`)
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'ready':
      return candidate.protocolVersion === DESKTOP_HOST_PROTOCOL_VERSION && typeof candidate.appVersion === 'string'
    case 'fatal':
      return typeof candidate.message === 'string'
    default:
      return false
  }
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ready facts reported by one installed host child. */
export interface DesktopHostReady {
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  /** Version of the installed shres app package the child booted. */
  readonly appVersion: string
}

/** One desktop host child running under an owned Node-compatible executable. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private requestPipe: Writable | undefined
  private responsePipe: Readable | undefined
  private readonly responseDecoder = new DesktopHostResponseDecoder()
  private requestWriteTail: Promise<void> = Promise.resolve()
  private nextStreamId = 1
  private readonly pending = new Map<number, PendingResponse>()
  private readonly heldResponses = new Map<number, HeldResponse>()
  private heldResponseBytes = 0
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false

  /**
   * @param executable - Node.js or Electron executable, or undefined for SHRES_DESKTOP_NODE_BINARY and then this process's own executable.
   * @param runtimeDir - installed shres runtime carrying the host package and the profile's bundles.
   * @param projectDir - active or staged desktop plugin profile.
   * @param inspectPort - optional loopback inspector port for workspace development.
   * @param environment - child environment; Node resolution and desktop-shell overrides are removed.
   * @param onFailure - receives the first fatal child or transport failure, including after readiness.
   */
  constructor(
    private readonly executable: string | undefined,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  /**
   * Start the child once and resolve only after its complete composition is active.
   * @returns the child's protocol version and installed app version.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = resolveHostEntry(this.runtimeDir)
    const child = spawn(this.executable ?? resolveNodeBinary(this.environment), [
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      ...(this.inspectPort === undefined ? [] : ['--allow-linked-profile']),
    ], {
      cwd: this.projectDir,
      env: {
        ...Object.fromEntries(Object.entries(this.environment).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^SHRES_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    })
    const requestPipe = child.stdio[DESKTOP_REQUEST_PIPE_FD]
    const responsePipe = child.stdio[DESKTOP_RESPONSE_PIPE_FD]
    if (!(requestPipe instanceof Writable) || !(responsePipe instanceof Readable)) {
      child.kill('SIGTERM')
      throw new Error('shres desktop host did not expose the required byte pipes and IPC channel')
    }
    this.child = child
    this.requestPipe = requestPipe
    this.responsePipe = responsePipe
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr += chunk
      if (this.stderr.length > STDERR_TAIL_CHARS) this.stderr = this.stderr.slice(this.stderr.length - STDERR_TAIL_CHARS)
    })
    child.stdout?.pipe(process.stdout)
    responsePipe.on('data', (chunk: Buffer) => { this.acceptResponseBytes(chunk) })
    responsePipe.once('end', () => {
      try {
        this.responseDecoder.finish()
        this.fail(new Error('shres desktop host response pipe ended'))
      } catch (error) {
        this.fail(errorOf(error, 'shres desktop host response pipe failed'))
      }
    })
    requestPipe.once('error', (error) => { this.fail(error) })
    responsePipe.once('error', (error) => { this.fail(error) })
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('shres desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      this.handleMessage(message)
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`shres desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`shres desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Forward one shres-app://app request to the child without buffering its body.
   * @param request - the request Electron's custom-scheme handler received.
   * @returns the child's streamed response.
   */
  async fetch(request: Request): Promise<Response> {
    await this.start()
    const child = this.child
    if (child === undefined || !child.connected || this.requestPipe === undefined) {
      throw new Error('shres desktop host is unavailable')
    }
    if (this.nextStreamId > 0xffff_ffff) throw new Error('shres desktop host exhausted its request stream ids')
    const streamId = this.nextStreamId++
    const method = request.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null
    return new Promise<Response>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        responseStarted: false,
        responseEnded: false,
        uploadOpen: hasBody,
      }
      const abort = (): void => {
        if (!this.pending.has(streamId)) return
        const error = errorOf(request.signal.reason, 'request aborted')
        pending.uploadOpen = false
        void pending.requestReader?.cancel(error).catch(() => undefined)
        this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((pipeError: unknown) => {
          this.fail(errorOf(pipeError, 'shres desktop request pipe failed'))
        })
        if (pending.controller === undefined) pending.reject(error)
        else pending.controller.error(error)
        this.finishPending(streamId, false)
      }
      if (request.signal.aborted) {
        reject(errorOf(request.signal.reason, 'request aborted'))
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => { request.signal.removeEventListener('abort', abort) }
      this.pending.set(streamId, pending)
      this.pumpRequest(streamId, request, hasBody).catch((error: unknown) => {
        this.failPending(streamId, errorOf(error, 'shres desktop request upload failed'))
      })
    })
  }

  /**
   * Request graceful teardown, then wait for child exit.
   * @returns a promise settling once the child has stopped.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.heldResponses.clear()
    this.heldResponseBytes = 0
    this.responsePipe?.resume()
    if (child.connected) this.send({ type: 'shutdown' })
    // Closing the parent-owned write end releases the host's pending Windows pipe read.
    this.requestPipe?.destroy()
    const exited = this.exitPromise ?? Promise.resolve()
    if (!await exitsWithin(exited, 10_000)) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('shres desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    this.requestPipe = undefined
    this.responsePipe = undefined
  }

  private async pumpRequest(streamId: number, request: Request, hasBody: boolean): Promise<void> {
    await this.enqueueRequestFrame(encodeDesktopRequestStart(streamId, {
      url: request.url,
      method: request.method.toUpperCase(),
      headers: [...request.headers.entries()],
      hasBody,
    }))
    if (!hasBody) return
    const body = request.body
    if (body === null) throw new Error('shres desktop request body disappeared before upload')
    const reader = body.getReader()
    const pending = this.pending.get(streamId)
    if (pending === undefined) {
      await reader.cancel()
      return
    }
    pending.requestReader = reader
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        for (let offset = 0; offset < next.value.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
          if (!this.pending.has(streamId)) return
          await this.enqueueRequestFrame(encodeDesktopRequestData(
            streamId,
            next.value.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
          ))
        }
      }
      const live = this.pending.get(streamId)
      if (live !== undefined) {
        await this.enqueueRequestFrame(encodeDesktopRequestEnd(streamId))
        live.uploadOpen = false
      }
    } finally {
      reader.releaseLock()
      const live = this.pending.get(streamId)
      if (live?.requestReader === reader) delete live.requestReader
    }
  }

  private enqueueRequestFrame(frame: Buffer): Promise<void> {
    const write = this.requestWriteTail.then(async () => {
      const pipe = this.requestPipe
      if (pipe === undefined || pipe.destroyed) throw new Error('shres desktop host request pipe is unavailable')
      if (!pipe.write(frame)) await once(pipe, 'drain')
    })
    this.requestWriteTail = write.catch(() => undefined)
    return write
  }

  private send(message: DesktopHostCommand): void {
    const child = this.child
    if (child === undefined || !child.connected) throw new Error('shres desktop host IPC is unavailable')
    child.send(message, (error) => { if (error !== null) this.fail(error) })
  }

  private acceptResponseBytes(chunk: Buffer): void {
    try {
      for (const frame of this.responseDecoder.push(chunk)) this.handleResponseFrame(frame)
    } catch (error) {
      this.fail(errorOf(error, 'shres desktop host response pipe failed'))
      this.child?.kill('SIGTERM')
    }
  }

  private handleResponseFrame(frame: DesktopHostResponseFrame): void {
    const pending = this.pending.get(frame.streamId)
    if (pending === undefined) {
      if (frame.streamId >= this.nextStreamId) {
        throw new Error(`shres desktop host responded for unknown stream ${String(frame.streamId)}`)
      }
      return
    }
    switch (frame.type) {
      case 'start': {
        if (pending.responseStarted) throw new Error(`shres desktop host started stream ${String(frame.streamId)} twice`)
        pending.responseStarted = true
        let body: ReadableStream<Uint8Array> | null = null
        if (frame.hasBody) {
          body = new ReadableStream<Uint8Array>({
            start: (controller) => { pending.controller = controller },
            pull: () => { this.releaseHeld(frame.streamId) },
            cancel: (reason) => { this.cancelResponse(frame.streamId, reason) },
          }, {
            highWaterMark: DESKTOP_RESPONSE_STREAM_HIGH_WATER_BYTES,
            size: chunk => chunk.byteLength,
          })
        }
        pending.resolve(new Response(body, {
          status: frame.status,
          headers: new Headers(frame.headers.map(([name, value]) => [name, value] as [string, string])),
        }))
        return
      }
      case 'data': {
        const controller = pending.controller
        if (!pending.responseStarted || controller === undefined) {
          throw new Error(`shres desktop host sent body data before a body start for stream ${String(frame.streamId)}`)
        }
        if (this.heldResponses.has(frame.streamId) || (controller.desiredSize ?? 0) <= 0) {
          this.holdResponse(frame.streamId, frame.data)
          return
        }
        controller.enqueue(frame.data)
        return
      }
      case 'end':
        if (!pending.responseStarted) {
          throw new Error(`shres desktop host ended stream ${String(frame.streamId)} before its response start`)
        }
        pending.responseEnded = true
        if (this.heldResponses.has(frame.streamId)) return
        pending.controller?.close()
        this.finishPending(frame.streamId, true)
        return
      case 'error':
        this.failPending(frame.streamId, new Error(frame.message))
        return
      default:
        frame satisfies never
    }
  }

  private cancelResponse(streamId: number, reason: unknown): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(reason).catch(() => undefined)
    this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((error: unknown) => {
      this.fail(errorOf(error, 'shres desktop request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  private failPending(streamId: number, error: Error): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(error).catch(() => undefined)
    if (pending.controller === undefined) pending.reject(error)
    else pending.controller.error(error)
    this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((pipeError: unknown) => {
      this.fail(errorOf(pipeError, 'shres desktop request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  private finishPending(streamId: number, cancelOpenUpload: boolean): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    if (cancelOpenUpload && pending.uploadOpen) {
      pending.uploadOpen = false
      void pending.requestReader?.cancel().catch(() => undefined)
      this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((error: unknown) => {
        this.fail(errorOf(error, 'shres desktop request pipe failed'))
      })
    }
    pending.removeAbort?.()
    this.pending.delete(streamId)
    this.dropHeld(streamId)
    this.resumeResponsePipe()
  }

  private holdResponse(streamId: number, data: Buffer): void {
    const copy = Buffer.from(data)
    let held = this.heldResponses.get(streamId)
    if (held === undefined) {
      held = { chunks: [], index: 0, bytes: 0 }
      this.heldResponses.set(streamId, held)
    }
    held.chunks.push(copy)
    held.bytes += copy.byteLength
    this.heldResponseBytes += copy.byteLength
    if (this.heldResponseBytes >= DESKTOP_RESPONSE_PIPE_BUFFER_BYTES) this.responsePipe?.pause()
  }

  private dropHeld(streamId: number): void {
    const held = this.heldResponses.get(streamId)
    if (held === undefined) return
    let remaining = 0
    for (let index = held.index; index < held.chunks.length; index += 1) {
      remaining += held.chunks[index]?.byteLength ?? 0
    }
    this.heldResponseBytes -= remaining
    this.heldResponses.delete(streamId)
  }

  /** Move held frames back onto the body until its byte budget is full again. */
  private releaseHeld(streamId: number): void {
    const pending = this.pending.get(streamId)
    const controller = pending?.controller
    const held = this.heldResponses.get(streamId)
    if (pending !== undefined && controller !== undefined && held !== undefined) {
      while (held.index < held.chunks.length && (controller.desiredSize ?? 0) > 0) {
        const next = held.chunks[held.index]
        if (next === undefined) break
        held.index += 1
        held.bytes -= next.byteLength
        this.heldResponseBytes -= next.byteLength
        controller.enqueue(next)
      }
      if (held.index >= held.chunks.length) this.heldResponses.delete(streamId)
      if (pending.responseEnded && !this.heldResponses.has(streamId)) {
        controller.close()
        this.finishPending(streamId, true)
        return
      }
    }
    this.resumeResponsePipe()
  }

  private resumeResponsePipe(): void {
    if (this.heldResponseBytes < DESKTOP_RESPONSE_PIPE_BUFFER_BYTES) this.responsePipe?.resume()
  }

  private handleMessage(message: DesktopHostEvent): void {
    switch (message.type) {
      case 'ready':
        this.readyResolve(message)
        return
      case 'fatal':
        this.fail(new Error(message.message))
        return
      default:
        message satisfies never
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    if (!this.failureReported) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('shres desktop host failure listener failed', listenerError)
      }
    }
    for (const pending of this.pending.values()) {
      void pending.requestReader?.cancel(error).catch(() => undefined)
      if (pending.controller === undefined) pending.reject(error)
      else pending.controller.error(error)
      pending.removeAbort?.()
    }
    this.pending.clear()
    this.heldResponses.clear()
    this.heldResponseBytes = 0
    this.responsePipe?.resume()
  }
}
