/**
 * Electron child-process entry: boots the desktop project without a listening
 * socket and carries API and validated Web assets over framed byte pipes. The
 * Electron main process owns the socket-facing half (custom scheme, window,
 * packaging); this process owns the composition.
 * @module @shres-code/shres-code-desktop-host
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@shres-code/cordis'
import type { PatchOptions } from '@shres-code/cordis-plugin-include'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadOverlayPatches,
  loadProfileDirectory,
  provideProfileRuntime,
  type Profile,
} from '@shres-code/shres-code-app-boot'
import { provideCmdline } from '@shres-code/shres-code-cmdline'
import { SHRES_LAUNCH_ENVIRONMENT_KEY } from '@shres-code/shres-code-launch-environment'
import { injectBootManifest } from '@shres-code/shres-code-client-modules'
import { toFetchHandler } from '@shres-code/shres-code-host-apiproxy'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@shres-code/shres-code-host-apiproxy/api'
import { RpcId } from '@shres-code/shres-code-host-apiproxy/api'
import { HostConnectionService, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '@shres-code/shres-code-client-connection'
// Side-effect type import: resolves `ctx.typertGateway`.
import type {} from '@shres-code/shres-code-api-gateway'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostRequestDecoder,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
  type DesktopHostRequestFrame,
} from './wire.ts'

export {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  FRAME_MAGIC,
} from './wire.ts'

/** Diagnostic prefix on every error and IPC event this process emits. */
const NAME = 'shres desktop'

/** One request forwarded from the Electron custom-scheme handler. */
interface DesktopHostFetchCommand {
  /** Electron-minted stream id, strictly increasing across the pipe. */
  readonly streamId: number
  /** The forwarded request. */
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers: readonly [string, string][]
  }
}

/** Commands accepted by the desktop child process. */
type DesktopHostCommand = {
  readonly type: 'shutdown'
}

/** Events emitted by the desktop child process. */
type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly appVersion: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** Controller returned to tests and the self-executing process entry. */
export interface DesktopHostController {
  /** Version of the installed shres app package this host booted. */
  readonly appVersion: string
  /**
   * Dispatch one custom-protocol request and stream its response to the response pipe.
   * @param command - the forwarded request.
   * @param body - request body stream, or null for a bodyless request.
   */
  fetch(command: DesktopHostFetchCommand, body: ReadableStream<Uint8Array> | null): Promise<void>
  /**
   * Abort one in-flight request.
   * @param streamId - the request's stream id.
   */
  cancel(streamId: number): void
  /**
   * Stop accepting messages and await complete host teardown.
   * @returns a promise settling after the composition is disposed.
   */
  dispose(): Promise<void>
}

/** Options for {@link runDesktopHost}. */
export interface DesktopHostOptions {
  /** Development-only allowance for workspace-linked bundle packages (the `--allow-linked-profile` launch option). */
  allowLinkedPackages?: boolean
}

/** Fetch-handler shape the composed routes expose to the pipe dispatcher. */
interface DesktopFetchHandler {
  fetch(request: Request): Promise<Response>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDesktopHostCommand(message: unknown): message is DesktopHostCommand {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as Record<string, unknown>).type === 'shutdown'
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))
const ROOT_CONFIG = '# Desktop composition root; the desktop host owns this file.\n[]\n'
const ROOT_CONFIG_FILENAME = 'desktop.cordis.yml'
const CLIENT_BUNDLE_PREFIX = '/plugins/'

const DESKTOP_TRANSPORT_SCRIPT = 'globalThis.__SHRES_TRANSPORT__={ownsHost:true,fetch:(input,init)=>globalThis.fetch(input,init)}'

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`${NAME}: ${path} must contain a package manifest`)
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
  }
}

function packageManifestPath(projectDir: string, packageName: string): string {
  const path = join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) throw new Error(`${NAME}: installed package ${JSON.stringify(packageName)} has no manifest`)
  return path
}

function isProjectPath(projectDir: string, target: string): boolean {
  const root = realpathSync(projectDir)
  const path = realpathSync(target)
  return path === root || path.startsWith(root + sep)
}

/** Insert a script as the first element of head, before the boot manifest the modules node half injects. */
function prependHeadScript(html: string, script: string): string {
  const element = `<script>${script}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${element}${html.slice(head + 6)}`
  return `${element}${html}`
}

interface DesktopComposition {
  readonly installAnchor: string
  readonly profile: Profile
  readonly patches: PatchOptions[]
}

/**
 * Compose the desktop project's patch layers: the profile's bundle layers and
 * own patch layer, this host's patch, and the system-trust agent-preset root
 * when the composition mounts the agent presets.
 * @param runtimeDir - the installed shres runtime the Electron application supplies.
 * @param projectDir - the desktop profile directory.
 * @param allowLinkedPackages - allow bundle packages resolved outside the runtime and profile (development project).
 * @returns the install anchor, loaded profile, and flattened patch layers.
 */
function desktopComposition(
  runtimeDir: string,
  projectDir: string,
  allowLinkedPackages: boolean,
): DesktopComposition {
  const installAnchor = packageManifestPath(runtimeDir, '@shres-code/shres-code')
  const appRoot = dirname(installAnchor)
  const profile = loadProfileDirectory(NAME, projectDir, installAnchor)
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir) && !isProjectPath(runtimeDir, layer.packageDir)) {
      throw new Error(`${NAME}: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the desktop runtime and profile`)
    }
  }
  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches(NAME, DESKTOP_PATCH),
  ]
  const rows = new Map(composeEntries(layers).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const agentPresets = rows.get('agent-presets')
  if (agentPresets !== undefined) {
    layers.push([{
      id: 'agent-presets',
      config: {
        ...(agentPresets.config ?? {}) as Record<string, unknown>,
        roots: [{ path: join(appRoot, 'config', 'agent-presets'), trust: 'system' }],
      },
    }])
  }
  return { installAnchor, profile, patches: layers.flat() }
}

function appVersionOf(runtimeDir: string): string {
  const manifest = readManifest(packageManifestPath(runtimeDir, '@shres-code/shres-code'))
  if (typeof manifest.version !== 'string') throw new Error(`${NAME}: the installed shres manifest has no version`)
  return manifest.version
}

/** The /api face this host consumes from the booted Connection service. */
interface DesktopApiFace {
  createSharedFetchHandler(channel: '/api', fallback: DesktopFetchHandler): DesktopFetchHandler
}

function assetHandler(ctx: Context, runtimeDir: string): DesktopFetchHandler {
  const require = createRequire(join(runtimeDir, 'package.json'))
  const distIndex = require.resolve('@shres-code/shres-code-web-frontend/dist/index.html')
  const distRoot = realpathSync(dirname(distIndex))
  const renderIndex = async (): Promise<Response> => {
    const html = injectBootManifest(await readFile(distIndex, 'utf8'), ctx.clientModules.graph())
    return new Response(prependHeadScript(html, DESKTOP_TRANSPORT_SCRIPT), {
      headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' },
    })
  }
  return {
    async fetch(request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const url = new URL(request.url)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (pathname.startsWith(CLIENT_BUNDLE_PREFIX)) return ctx.clientModules.fetchBundle(request)
      if (pathname === '/' || pathname === '/index.html') return renderIndex()
      const target = resolve(normalize(join(distRoot, pathname)))
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
      try {
        const realTarget = realpathSync(target)
        if (realTarget !== distRoot && !realTarget.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
        return new Response(request.method === 'HEAD' ? null : await readFile(realTarget), {
          headers: { 'content-type': MIME[extname(realTarget)] ?? 'application/octet-stream' },
        })
      } catch {
        // Unknown asset paths fall back to the SPA document, matching the served web app.
        return renderIndex()
      }
    },
  }
}

/** One server-request envelope for a downlinked event frame, matching the browser WebSocket carrier. */
function serverRequest(frame: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

/**
 * Stream one event downlink as ndjson: one server-request envelope per line,
 * body end for stream loss. The desktop transport has no WebSocket, so the
 * browser's fetch carrier reads the same frames from the response body.
 * @param api - the host API supplying the typed event stream.
 * @param kind - which event family this request asked for.
 * @param signal - the request's cancellation signal.
 * @returns the streaming response.
 */
function downlinkResponse(api: ApiProxy, kind: 'mux' | 'host', signal: AbortSignal): Response {
  const abort = new AbortController()
  const cancel = (): void => { abort.abort(signal.reason) }
  signal.addEventListener('abort', cancel, { once: true })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const frames = kind === 'mux'
          ? api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
          : api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
        for await (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(serverRequest(frame))}\n`))
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    cancel(reason) {
      abort.abort(reason)
      signal.removeEventListener('abort', cancel)
    },
  })
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
}

/** Downlink request paths by event family; the browser carrier POSTs these instead of upgrading a WebSocket. */
const DOWNLINK_PATHS: Readonly<Record<string, 'mux' | 'host'>> = {
  [MUX_EVENTS_PATH]: 'mux',
  [HOST_EVENTS_PATH]: 'host',
}

function apiFallbackHandler(ctx: Context): DesktopFetchHandler {
  return {
    async fetch(request): Promise<Response> {
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      const downlink = DOWNLINK_PATHS[new URL(request.url).pathname]
      if (downlink === undefined) return toFetchHandler(apiProxy).fetch(request)
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      return downlinkResponse(apiProxy, downlink, request.signal)
    },
  }
}

interface NodeRequestInit extends RequestInit {
  readonly duplex?: 'half'
}

/**
 * Boot one installed desktop project and serve its requests from the pipes.
 * @param runtimeDir - immutable shres packages supplied by the Electron application.
 * @param projectDir - the Electron-owned desktop profile directory.
 * @param writeResponse - serialized response-pipe writer that applies byte backpressure.
 * @param options - development allowance for workspace-linked bundle packages.
 * @returns controller after every host and client-manifest row is active.
 */
export async function runDesktopHost(
  runtimeDir: string,
  projectDir: string,
  writeResponse: (frame: Buffer) => Promise<void>,
  options: DesktopHostOptions = {},
): Promise<DesktopHostController> {
  const absoluteRuntime = resolve(runtimeDir)
  const absoluteProject = resolve(projectDir)
  mkdirSync(absoluteProject, { recursive: true })
  const rootConfig = join(absoluteProject, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)
  const environment = loadLayeredEnv(NAME)
  const composition = desktopComposition(absoluteRuntime, absoluteProject, options.allowLinkedPackages === true)
  let current: Context | undefined
  const ctx = await boot(NAME, rootConfig, structuredClone(composition.patches), (hostCtx) => {
    current = hostCtx
    // Before any config-tree entry mounts, so every plugin reads the same
    // immutable launch-environment provenance snapshot.
    hostCtx.provide(SHRES_LAUNCH_ENVIRONMENT_KEY, environment)
    provideProfileRuntime(hostCtx, {
      profileDir: absoluteProject,
      bootBundles: composition.profile.layers.map(layer => layer.packageName),
      pluginMutations: 'unsupported',
    })
    // The desktop composition runs without the webserver row, while the
    // client-modules and client-connection node halves statically inject
    // webServer. A no-op service satisfies those injects: their routes and
    // index taps register here and dispose immediately, nothing binds, and
    // the desktop host keeps owning dispatch over the pipes.
    hostCtx.provide('webServer', {
      register: () => () => {},
      registerUpgrade: () => () => {},
      tapIndex: () => () => {},
    })
    provideCmdline(hostCtx, { args: [], exit: () => {} })
  })
  current = ctx
  const clientModules = ctx.get('clientModules')
  if (clientModules === undefined) {
    await ctx.fiber.dispose()
    throw new Error(`${NAME}: composition did not provide clientModules`)
  }
  // The desktop patch disables the Connection web route (its node half is
  // webserver-bound and never activates without one), so this host owns the
  // shared /api handler directly. A composition that still provides a
  // Connection service with the shared handler wins, keeping stub-hosted
  // fixtures on their own face.
  const provided = ctx.get('connection') as Partial<DesktopApiFace> | undefined
  const apiFace = typeof provided?.createSharedFetchHandler === 'function'
    ? provided as DesktopApiFace
    : new HostConnectionService(ctx, [])
  const api = apiFace.createSharedFetchHandler('/api', apiFallbackHandler(ctx))
  const assets = assetHandler(ctx, absoluteRuntime)
  const requests = new Map<number, AbortController>()
  let disposing: Promise<void> | undefined

  const dispose = async (): Promise<void> => {
    disposing ??= (async () => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      await current?.fiber.dispose()
      current = undefined
    })()
    await disposing
  }

  return {
    appVersion: appVersionOf(absoluteRuntime),
    cancel(streamId) {
      requests.get(streamId)?.abort()
    },
    async fetch(command, body) {
      if (disposing !== undefined) throw new Error(`${NAME}: host is disposing`)
      const controller = new AbortController()
      requests.set(command.streamId, controller)
      try {
        const url = new URL(command.request.url)
        const init: NodeRequestInit = {
          method: command.request.method,
          headers: new Headers(command.request.headers.map(([name, value]) => [name, value] as [string, string])),
          ...(body === null ? {} : { body, duplex: 'half' }),
          signal: controller.signal,
        }
        const request = new Request(url, init)
        const response = url.pathname.startsWith('/api/')
          ? await api.fetch(request)
          : await assets.fetch(request)
        await writeResponse(encodeDesktopResponseStart(command.streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null,
        }))
        if (response.body !== null) {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk)
            for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
              await writeResponse(encodeDesktopResponseData(
                command.streamId,
                bytes.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
              ))
            }
          }
        }
        await writeResponse(encodeDesktopResponseEnd(command.streamId))
      } catch (error) {
        if (!controller.signal.aborted) {
          await writeResponse(encodeDesktopResponseError(
            command.streamId,
            error instanceof Error ? error.message : String(error),
          ))
        }
      } finally {
        requests.delete(command.streamId)
      }
    },
    dispose,
  }
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined || process.send === undefined) {
    throw new Error(`${NAME}: expected runtime and profile directories, byte pipes, and a Node IPC channel`)
  }
  const option = process.argv[4]
  if (option !== undefined && option !== '--allow-linked-profile') {
    throw new Error(`${NAME}: unsupported internal option ${JSON.stringify(option)}`)
  }
  // Client package metadata resolves from the profile's ordinary Node parent
  // walk, just as it does for the CLI's named profiles.
  healProfilesModuleFallback(packageManifestPath(runtimeDir, '@shres-code/shres-code-desktop-host'))
  const requestPipe = createReadStream('', { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false })
  const responsePipe = createWriteStream('', { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false })
  let responseWriteTail: Promise<void> = Promise.resolve()
  const writeResponse = (frame: Buffer): Promise<void> => {
    const write = responseWriteTail.then(async () => {
      if (responsePipe.destroyed) throw new Error(`${NAME}: Electron response pipe is unavailable`)
      if (!responsePipe.write(frame)) await once(responsePipe, 'drain')
    })
    responseWriteTail = write.catch(() => undefined)
    return write
  }
  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return
    try {
      process.send(event)
    } catch (error) {
      // A concurrent parent disconnect owns teardown; only that closed-channel
      // condition is safe to discard while streamed responses unwind.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }
  const controller = await runDesktopHost(runtimeDir, projectDir, writeResponse, {
    allowLinkedPackages: option !== undefined,
  })
  send({
    type: 'ready',
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    appVersion: controller.appVersion,
  })
  const decoder = new DesktopHostRequestDecoder()
  const requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const blockedRequests = new Set<number>()
  const discardedRequestBodies = new Set<number>()
  const runs = new Set<Promise<void>>()
  let lastStreamId = 0
  let requestedExitCode = 0
  let stopping: Promise<void> | undefined

  const resumeRequestPipe = (): void => {
    if (blockedRequests.size === 0) requestPipe.resume()
  }

  const stop = (exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    stopping ??= (async () => {
      requestPipe.pause()
      requestPipe.removeAllListeners('data')
      const stopped = new Error(`${NAME}: host is stopping`)
      for (const body of requestBodies.values()) body.error(stopped)
      requestBodies.clear()
      blockedRequests.clear()
      discardedRequestBodies.clear()
      requestPipe.destroy()
      closeSync(DESKTOP_REQUEST_PIPE_FD)
      await controller.dispose()
      await Promise.allSettled([...runs])
      await responseWriteTail.catch(() => undefined)
      if (!responsePipe.destroyed) {
        await new Promise<void>((resolvePromise) => { responsePipe.end(resolvePromise) })
        responsePipe.destroy()
      }
      closeSync(DESKTOP_RESPONSE_PIPE_FD)
      if (process.connected) process.disconnect?.()
      process.exitCode = requestedExitCode
    })()
    return stopping
  }

  const failTransport = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    send({ type: 'fatal', message })
    void stop(1)
  }

  const beginRequest = (frame: Extract<DesktopHostRequestFrame, { type: 'start' }>): void => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`${NAME}: Electron reused or reordered request stream ${String(frame.streamId)}`)
    }
    lastStreamId = frame.streamId
    let body: ReadableStream<Uint8Array> | null = null
    if (frame.hasBody) {
      body = new ReadableStream<Uint8Array>({
        start(controllerOfBody) {
          requestBodies.set(frame.streamId, controllerOfBody)
        },
        pull() {
          blockedRequests.delete(frame.streamId)
          resumeRequestPipe()
        },
        cancel() {
          requestBodies.delete(frame.streamId)
          blockedRequests.delete(frame.streamId)
          controller.cancel(frame.streamId)
          resumeRequestPipe()
        },
      })
    }
    const run = controller.fetch({
      streamId: frame.streamId,
      request: {
        url: frame.url,
        method: frame.method,
        headers: frame.headers,
      },
    }, body)
    runs.add(run)
    void run.catch(failTransport).finally(() => {
      runs.delete(run)
      const openBody = requestBodies.get(frame.streamId)
      if (openBody === undefined) return
      openBody.error(new Error(`${NAME}: response completed before the request body ended`))
      requestBodies.delete(frame.streamId)
      blockedRequests.delete(frame.streamId)
      discardedRequestBodies.add(frame.streamId)
      resumeRequestPipe()
    })
  }

  const handleRequestFrame = (frame: DesktopHostRequestFrame): void => {
    switch (frame.type) {
      case 'start':
        beginRequest(frame)
        return
      case 'data': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.has(frame.streamId)) return
          throw new Error(`${NAME}: Electron sent body data for inactive stream ${String(frame.streamId)}`)
        }
        body.enqueue(frame.data)
        if ((body.desiredSize ?? 0) <= 0) {
          blockedRequests.add(frame.streamId)
          requestPipe.pause()
        }
        return
      }
      case 'end': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.delete(frame.streamId)) return
          throw new Error(`${NAME}: Electron ended inactive body stream ${String(frame.streamId)}`)
        }
        body.close()
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        resumeRequestPipe()
        return
      }
      case 'cancel': {
        if (frame.streamId > lastStreamId) {
          throw new Error(`${NAME}: Electron canceled unknown stream ${String(frame.streamId)}`)
        }
        const body = requestBodies.get(frame.streamId)
        body?.error(new Error(`${NAME}: Electron canceled the request`))
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        discardedRequestBodies.delete(frame.streamId)
        controller.cancel(frame.streamId)
        resumeRequestPipe()
        return
      }
      default:
        frame satisfies never
    }
  }

  requestPipe.on('data', (chunk: string | Buffer) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame)
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('end', () => {
    if (stopping !== undefined) return
    try {
      decoder.finish()
      failTransport(new Error(`${NAME}: Electron request pipe ended`))
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('error', failTransport)
  responsePipe.once('error', failTransport)
  process.on('message', (message: unknown) => {
    if (!isDesktopHostCommand(message)) {
      send({ type: 'fatal', message: `${NAME}: invalid Electron IPC command` })
      void stop(1)
      return
    }
    void stop()
  })
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.send !== undefined) process.send({ type: 'fatal', message } satisfies DesktopHostEvent)
    else process.stderr.write(`${NAME}: ${message}\n`)
    process.exitCode = 1
  })
}
