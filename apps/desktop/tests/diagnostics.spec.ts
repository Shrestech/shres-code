/** The Electron diagnostics writer keeps one redacted latest record on disk. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_DIAGNOSTIC_FILENAME,
  DesktopDiagnostics,
  type DesktopDiagnosticRecord,
} from '../src/diagnostics.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function diagnostics(): { writer: DesktopDiagnostics; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'shres-desktop-diagnostic-'))
  roots.push(root)
  return {
    root,
    writer: new DesktopDiagnostics({
      logDir: root,
      appVersion: '0.1.0-test',
      electronVersion: '44.0.0',
      nodeVersion: '22.19.0',
      platform: 'darwin',
      arch: 'arm64',
      now: () => new Date('2026-11-08T00:00:00.000Z'),
      memoryUsage: () => ({ rss: 10, heapTotal: 20, heapUsed: 5, external: 2, arrayBuffers: 1 }),
      rendererMemory: () => ({ pid: 42, workingSetSize: 30, privateBytes: 25 }),
    }),
  }
}

async function readRecord(writer: DesktopDiagnostics): Promise<DesktopDiagnosticRecord> {
  let record: DesktopDiagnosticRecord | undefined
  await expect.poll(async () => {
    try {
      record = JSON.parse(await readFile(writer.file, 'utf8')) as DesktopDiagnosticRecord
    } catch {
      record = undefined
    }
    return record
  }).toBeDefined()
  if (record === undefined) throw new Error('desktop diagnostic was not written')
  return record
}

describe('desktop diagnostics', () => {
  it('writes one redacted latest record with process facts', async () => {
    const { writer, root } = diagnostics()
    writer.record({
      event: 'render-process-gone',
      reason: 'crashed; conversation secret',
      exitCode: 9,
      hostVersion: '0.1.0-host',
    })

    const record = await readRecord(writer)
    expect(record).toEqual({
      event: 'render-process-gone',
      reason: 'crashed--conversation-secret',
      exitCode: 9,
      hostVersion: '0.1.0-host',
      at: '2026-11-08T00:00:00.000Z',
      appVersion: '0.1.0-test',
      electronVersion: '44.0.0',
      nodeVersion: '22.19.0',
      platform: 'darwin',
      arch: 'arm64',
      memory: {
        main: { rss: 10, heapTotal: 20, heapUsed: 5, external: 2, arrayBuffers: 1 },
        renderer: { pid: 42, workingSetSize: 30, privateBytes: 25 },
      },
      latestFailure: {
        event: 'render-process-gone',
        reason: 'crashed--conversation-secret',
        exitCode: 9,
        hostVersion: '0.1.0-host',
        at: '2026-11-08T00:00:00.000Z',
        appVersion: '0.1.0-test',
        electronVersion: '44.0.0',
        nodeVersion: '22.19.0',
        platform: 'darwin',
        arch: 'arm64',
        memory: {
          main: { rss: 10, heapTotal: 20, heapUsed: 5, external: 2, arrayBuffers: 1 },
          renderer: { pid: 42, workingSetSize: 30, privateBytes: 25 },
        },
      },
    })
    expect(readFileSync(join(root, DESKTOP_DIAGNOSTIC_FILENAME), 'utf8').split('\n')).toHaveLength(2)
  })

  it('keeps the latest failure when recovery becomes the current event', async () => {
    const { writer } = diagnostics()
    writer.record({ event: 'unresponsive', reason: 'renderer-unresponsive' })
    writer.record({ event: 'responsive', reason: 'renderer-responsive' })

    const record = await readRecord(writer)
    expect(record.event).toBe('responsive')
    expect(record.reason).toBe('renderer-responsive')
    expect(record.latestFailure).toMatchObject({
      event: 'unresponsive',
      reason: 'renderer-unresponsive',
    })
  })
})
