/**
 * Desktop host against a fixture runtime project: profile containment, the
 * asset, client-bundle, /api, and ndjson event-downlink routes over the
 * response frames, the fail-loud composition checks, and teardown.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDesktopHost } from '../src/index.ts'

const FRAME_MAGIC = 0x53485233
const HEADER_BYTES = 13
const APP_VERSION = '9.9.9'
const STUB_PLUGIN = 'stub-host-services.js'
const STUB_CLIENT_BUNDLE = 'stub-client.js'

interface DecodedFrame {
  readonly type: number
  readonly streamId: number
  readonly payload: Buffer
}

function decodeFrames(frames: readonly Buffer[]): DecodedFrame[] {
  const bytes = Buffer.concat([...frames])
  const decoded: DecodedFrame[] = []
  let offset = 0
  while (offset + HEADER_BYTES <= bytes.byteLength) {
    expect(bytes.readUInt32BE(offset)).toBe(FRAME_MAGIC)
    const type = bytes.readUInt8(offset + 4)
    const streamId = bytes.readUInt32BE(offset + 5)
    const length = bytes.readUInt32BE(offset + 9)
    decoded.push({ type, streamId, payload: bytes.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length) })
    offset += HEADER_BYTES + length
  }
  expect(offset).toBe(bytes.byteLength)
  return decoded
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, undefined, 2) + '\n')
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A fixture installation: the shres app manifest, the built frontend, and a linked bundle outside it. */
function stageRuntime(): { root: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'shres-desktop-runtime-'))
  const runtimeDir = join(root, 'runtime')
  writeJson(join(runtimeDir, 'package.json'), { name: 'shres-desktop-fixture-runtime', private: true })
  writeJson(join(runtimeDir, 'node_modules', '@shres-code', 'shres-code', 'package.json'),
    { name: '@shres-code/shres-code', version: APP_VERSION })
  writeJson(join(runtimeDir, 'node_modules', '@shres-code', 'shres-code-web-frontend', 'package.json'),
    { name: '@shres-code/shres-code-web-frontend', version: APP_VERSION })
  writeFile(join(runtimeDir, 'node_modules', '@shres-code', 'shres-code-web-frontend', 'dist', 'index.html'),
    '<!doctype html>\n<html><head><title>fixture</title></head><body>shell</body></html>\n')
  // A bundle resolvable from the runtime's parent walk but outside both roots.
  writeJson(join(root, 'node_modules', 'outside-bundle', 'package.json'),
    { name: 'outside-bundle', version: '1.0.0', shres: { bundle: { patch: './cordis.patch.yml' } } })
  writeFile(join(root, 'node_modules', 'outside-bundle', 'cordis.patch.yml'), '[]\n')
  // The desktop patch inserts the native picker pair; stage both as no-op
  // host plugins on the project's parent walk so the loader rows apply.
  const noopPlugin = (name: string): void => {
    writeJson(join(root, 'node_modules', ...name.split('/'), 'package.json'),
      { name, version: '0.0.0', private: true, type: 'module', main: './index.js' })
    writeFile(join(root, 'node_modules', ...name.split('/'), 'index.js'),
      'export const name = "noop"\nexport const inject = []\nexport function apply() {}\n')
  }
  noopPlugin('@shres-code/shres-code-host-directory-picker-native')
  noopPlugin('@shres-code/shres-code-client-ui-directory-picker-native')
  return { root, runtimeDir }
}

/** Mux frames the fixture downlink yields. Above 1, each payload carries padding so the burst exceeds the downlink queue. */
function stubServices(muxEvents: number): string {
  const muxBody = muxEvents <= 1
    ? 'yield { rpcId: frame.rpcId, payload: { type: "session/frame", seq: 1 } }'
    : `const pad = ${JSON.stringify('x'.repeat(180))}\n`
      + `      for (let seq = 1; seq <= ${muxEvents}; seq += 1) {\n`
      + '        yield { rpcId: frame.rpcId, payload: { type: "session/frame", seq, pad } }\n'
      + '      }'
  return [
    'export const name = "stub-host-services"',
    'export const inject = []',
    'export function apply(ctx) {',
    '  ctx.provide("connection", {',
    '    createSharedFetchHandler(channel, fallback) {',
    '      return {',
    '        async fetch(request) {',
    '          if (new URL(request.url).pathname === "/api/hello/world") {',
    '            return new Response(JSON.stringify({ channel, ok: true }), { headers: { "content-type": "application/json" } })',
    '          }',
    '          return fallback.fetch(request)',
    '        },',
    '      }',
    '    },',
    '  })',
    '  ctx.provide("clientModules", {',
    '    graph: () => ({ entries: [{ id: "known-plugin", url: "/plugins/known-plugin/client.js", rev: "abc" }] }),',
    '    fetchBundle: async request => {',
    '      const id = new URL(request.url).pathname.slice("/plugins/".length, -"/client.js".length)',
    '      if (id !== "known-plugin") return new Response(null, { status: 404 })',
    '      return new Response(' + JSON.stringify('export const marker = "stub client bundle"\n') + ', { headers: { "content-type": "text/javascript; charset=utf-8" } })',
    '    },',
    '  })',
    '  ctx.provide("apiProxy", {',
    '    events: {',
    `      mux: frame => (async function* () {\n        ${muxBody}\n      })(),`,
    '      host: frame => (async function* () { yield { rpcId: frame.rpcId, payload: { type: "host/frame", n: 2 } } })(),',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n')
}

/** The picker packages the desktop patch inserts; a real profile installs them, this fixture stubs them. */
const PICKER_PACKAGES = [
  '@shres-code/shres-code-host-directory-picker-native',
  '@shres-code/shres-code-client-ui-directory-picker-native',
]

/** A desktop profile holding the stub host services the desktop host consumes. */
function stageProject(root: string, bundles: readonly string[], stubServicesEnabled: boolean, muxEvents: number): string {
  const projectDir = join(root, 'project')
  for (const packageName of PICKER_PACKAGES) {
    const dir = join(projectDir, 'node_modules', ...packageName.split('/'))
    writeJson(join(dir, 'package.json'), { name: packageName, version: '1.0.0', type: 'module', main: 'index.js' })
    writeFile(join(dir, 'index.js'),
      'export const name = ' + JSON.stringify(packageName)
      + '\nexport const inject = []'
      + '\nexport function apply() {}\n')
  }
  writeJson(join(projectDir, 'package.json'), {
    name: 'shres-desktop-fixture-profile',
    private: true,
    type: 'module',
    shres: { profile: { bundles: [...bundles] } },
  })
  writeFile(join(projectDir, 'cordis.patch.yml'),
    stubServicesEnabled ? '- insert:\n    - id: stub-host-services\n      name: ./' + STUB_PLUGIN + '\n' : '[]\n')
  writeFile(join(projectDir, STUB_PLUGIN), stubServices(muxEvents))
  writeFile(join(projectDir, STUB_CLIENT_BUNDLE), 'export const marker = "stub client bundle"\n')
  return projectDir
}

interface Harness {
  readonly controller: Awaited<ReturnType<typeof runDesktopHost>>
  readonly frames: Buffer[]
}

async function bootFixture(
  options: {
    bundles?: readonly string[]
    allowLinkedPackages?: boolean
    stubServices?: boolean
    muxEvents?: number
    onFrame?: (frame: Buffer) => Promise<void> | void
  } = {},
): Promise<Harness> {
  const { root, runtimeDir } = stageRuntime()
  const projectDir = stageProject(root, options.bundles ?? [], options.stubServices !== false, options.muxEvents ?? 1)
  const frames: Buffer[] = []
  const controller = await runDesktopHost(runtimeDir, projectDir, async (frame) => {
    frames.push(frame)
    await options.onFrame?.(frame)
  }, {
    ...(options.allowLinkedPackages === undefined ? {} : { allowLinkedPackages: options.allowLinkedPackages }),
  })
  return { controller, frames }
}

function framesOf(frames: readonly Buffer[], streamId: number): DecodedFrame[] {
  return decodeFrames(frames).filter(frame => frame.streamId === streamId)
}

function textOf(frames: readonly Buffer[], streamId: number): string {
  return Buffer.concat(framesOf(frames, streamId).filter(frame => frame.type === 2).map(frame => frame.payload))
    .toString('utf8')
}

function statusOf(frames: readonly Buffer[], streamId: number): number {
  const start = framesOf(frames, streamId)[0]
  return (JSON.parse(start?.payload.toString('utf8') ?? '{}') as { status?: number }).status ?? 0
}

function requestOf(
  streamId: number,
  url: string,
  method = 'GET',
): { streamId: number; request: { url: string; method: string; headers: [string, string][] } } {
  return { streamId, request: { url, method, headers: [] } }
}

describe('runDesktopHost', () => {
  it('serves the index document, client bundles, and /api over the response frames', async () => {
    const { controller, frames } = await bootFixture()
    expect(controller.appVersion).toBe(APP_VERSION)

    await controller.fetch(requestOf(1, 'shres-app://app/'), null)
    expect(statusOf(frames, 1)).toBe(200)
    const html = textOf(frames, 1)
    expect(html).toContain('window.__SHRES_BOOT__')
    expect(html).toContain('globalThis.__SHRES_TRANSPORT__={ownsHost:true,fetch:(input,init)=>globalThis.fetch(input,init)}')
    // The transport global precedes the boot manifest the modules node half injects.
    expect(html.indexOf('globalThis.__SHRES_TRANSPORT__')).toBeLessThan(html.indexOf('window.__SHRES_BOOT__'))
    expect(framesOf(frames, 1).at(-1)?.type).toBe(3)

    await controller.fetch(requestOf(2, 'shres-app://app/plugins/known-plugin/client.js'), null)
    expect(textOf(frames, 2)).toBe('export const marker = "stub client bundle"' + '\n')
    await controller.fetch(requestOf(3, 'shres-app://app/plugins/absent/client.js'), null)
    expect(statusOf(frames, 3)).toBe(404)

    await controller.fetch(requestOf(4, 'shres-app://app/api/hello/world'), null)
    expect(JSON.parse(textOf(frames, 4))).toEqual({ channel: '/api', ok: true })

    // An unknown asset falls back to the SPA document; an escaping path does not.
    await controller.fetch(requestOf(5, 'shres-app://app/missing.css'), null)
    expect(statusOf(frames, 5)).toBe(200)
    expect(textOf(frames, 5)).toContain('window.__SHRES_BOOT__')
    // Traversal is structurally neutralized before the containment check:
    // URL parsing consumes real dot segments, and one decode of a
    // double-encoded segment yields the literal string %2e%2e (an ordinary
    // directory name), so both forms answer the SPA fallback. The resolve +
    // realpath containment arms remain defense-in-depth for direct callers.
    await controller.fetch(requestOf(6, 'shres-app://app/%2e%2e/%2e%2e/secret'), null)
    expect(statusOf(frames, 6)).toBe(200)
    await controller.fetch(requestOf(7, 'shres-app://app/%252e%252e/secret'), null)
    expect(statusOf(frames, 7)).toBe(200)

    await controller.dispose()
    await expect(controller.fetch(requestOf(7, 'shres-app://app/'), null)).rejects.toThrow('host is disposing')
  })

  it('streams both event downlinks as one server-request envelope per ndjson line', async () => {
    const { controller, frames } = await bootFixture()
    await controller.fetch(requestOf(1, 'shres-app://app/api/events.mux', 'POST'), null)
    expect(statusOf(frames, 1)).toBe(200)
    const mux = JSON.parse(textOf(frames, 1)) as { type: string; method: string; rpcId: string; payload: unknown }
    expect(mux).toMatchObject({ type: 'server-request', method: 'session/frame', payload: { type: 'session/frame', seq: 1 } })
    expect(typeof mux.rpcId).toBe('string')

    await controller.fetch(requestOf(2, 'shres-app://app/api/events.host', 'POST'), null)
    expect(JSON.parse(textOf(frames, 2))).toMatchObject({ type: 'server-request', method: 'host/frame', payload: { n: 2 } })

    // The downlinks are POST-only; a browser GET on them is refused.
    await controller.fetch(requestOf(3, 'shres-app://app/api/events.mux'), null)
    expect(statusOf(frames, 3)).toBe(405)
    await controller.dispose()
  })

  it('coalesces a downlink burst and resumes after the first body chunk is read', async () => {
    const eventCount = 400
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    let dataFrames = 0
    const { controller, frames } = await bootFixture({
      muxEvents: eventCount,
      onFrame: async (frame) => {
        if (frame.readUInt8(4) !== 2) return
        dataFrames += 1
        if (dataFrames === 1) await firstHeld
      },
    })
    try {
      const done = controller.fetch(requestOf(1, 'shres-app://app/api/events.mux', 'POST'), null)
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      releaseFirst()
      const stalled = new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('downlink stalled after the shell resumed reading')) }, 2000)
      })
      await Promise.race([done, stalled])
      const lines = textOf(frames, 1).split('\n').filter(line => line.length > 0)
      expect(lines).toHaveLength(eventCount)
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'server-request', payload: { seq: 1 } })
      expect(JSON.parse(lines[eventCount - 1] ?? '')).toMatchObject({ payload: { seq: eventCount } })
      const bodies = framesOf(frames, 1).filter(frame => frame.type === 2)
      expect(bodies.length).toBeGreaterThan(1)
      expect(bodies.length).toBeLessThan(lines.length)
    } finally {
      await controller.dispose()
    }
  })

  it('fails loud when the composition provides no clientModules', async () => {
    await expect(bootFixture({ stubServices: false }))
      .rejects.toThrow('composition did not provide clientModules')
  })

  it('refuses a bundle resolved outside the runtime and profile unless the development option allows it', async () => {
    await expect(bootFixture({ bundles: ['outside-bundle'] }))
      .rejects.toThrow('resolved outside the desktop runtime and profile')
    await expect(bootFixture({ bundles: ['outside-bundle'], allowLinkedPackages: true, stubServices: false }))
      .rejects.toThrow('composition did not provide clientModules')
  })
})
