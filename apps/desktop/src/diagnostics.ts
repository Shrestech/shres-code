/** Bounded local diagnostics for Electron lifecycle and host failures. */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Lifecycle signals written by the desktop shell. */
export type DesktopDiagnosticEvent =
  | 'unresponsive'
  | 'responsive'
  | 'render-process-gone'
  | 'host-failure'

/** One scalar event accepted by the diagnostics writer. */
export interface DesktopDiagnosticInput {
  readonly event: DesktopDiagnosticEvent
  readonly reason?: string
  readonly exitCode?: number
  readonly signal?: string
  readonly hostVersion?: string
}

/** Renderer process memory values in kilobytes, as returned by Electron's app metrics. */
export interface DesktopRendererMemory {
  readonly pid: number
  readonly workingSetSize: number
  readonly peakWorkingSetSize?: number
  readonly privateBytes?: number
  readonly sharedBytes?: number
}

/** Main-process memory in bytes and renderer memory in kilobytes. */
export interface DesktopDiagnosticMemory {
  readonly main: NodeJS.MemoryUsage
  readonly renderer?: DesktopRendererMemory
}

/** Scalar facts shared by the current lifecycle record and retained failure. */
interface DesktopDiagnosticSnapshot extends DesktopDiagnosticInput {
  readonly at: string
  readonly appVersion: string
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly memory: DesktopDiagnosticMemory
}

/** Latest failure retained alongside the current lifecycle event. */
export type DesktopDiagnosticFailure = Omit<DesktopDiagnosticSnapshot, 'event'> & {
  readonly event: Exclude<DesktopDiagnosticEvent, 'responsive'>
}

/** JSON record persisted as the latest desktop lifecycle diagnostic. */
export interface DesktopDiagnosticRecord extends DesktopDiagnosticSnapshot {
  /** One latest failure, retained when a later responsive event becomes current. */
  readonly latestFailure?: DesktopDiagnosticFailure
}

/** Construction inputs kept separate so the writer can be tested without Electron. */
export interface DesktopDiagnosticsOptions {
  readonly logDir: string
  readonly appVersion: string
  readonly electronVersion?: string
  readonly nodeVersion?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly now?: () => Date
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly rendererMemory?: () => DesktopRendererMemory | undefined
}

/** Name of the single latest-record file under Electron's logs directory. */
export const DESKTOP_DIAGNOSTIC_FILENAME = 'shres-desktop-diagnostic.json'

function cleanReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const cleaned = reason.replace(/[^a-z0-9._:-]/giu, '-').slice(0, 96)
  return cleaned === '' ? undefined : cleaned
}

function safeMemory(memoryUsage: () => NodeJS.MemoryUsage): NodeJS.MemoryUsage {
  return { ...memoryUsage() }
}

function safeRendererMemory(memoryUsage: (() => DesktopRendererMemory | undefined) | undefined): DesktopRendererMemory | undefined {
  if (memoryUsage === undefined) return undefined
  try {
    return memoryUsage()
  } catch (_rendererMemoryReadFailure) {
    // Electron may destroy the renderer between getOSProcessId and getAppMetrics.
    return undefined
  }
}

/**
 * Persist only the latest lifecycle record, coalescing bursts while one write
 * is in flight so an unresponsive renderer cannot grow an in-memory write queue.
 */
export class DesktopDiagnostics {
  private pending: DesktopDiagnosticRecord | undefined
  private latestFailure: DesktopDiagnosticFailure | undefined
  private writing = false

  /**
   * @param options - log location and process facts captured for every record.
   */
  constructor(private readonly options: DesktopDiagnosticsOptions) {}

  /** Absolute path of the bounded latest-record file. */
  get file(): string {
    return join(this.options.logDir, DESKTOP_DIAGNOSTIC_FILENAME)
  }

  /**
   * Queue one lifecycle record for persistence; only scalar, redacted fields
   * are accepted, so no request or conversation content is written.
   * @param input - lifecycle event and optional process-free metadata.
   */
  record(input: DesktopDiagnosticInput): void {
    const reason = cleanReason(input.reason)
    const renderer = safeRendererMemory(this.options.rendererMemory)
    const current: DesktopDiagnosticSnapshot = {
      event: input.event,
      ...reason === undefined ? {} : { reason },
      ...input.exitCode === undefined ? {} : { exitCode: input.exitCode },
      ...input.signal === undefined ? {} : { signal: input.signal },
      ...input.hostVersion === undefined ? {} : { hostVersion: input.hostVersion },
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      appVersion: this.options.appVersion,
      electronVersion: this.options.electronVersion ?? process.versions.electron,
      nodeVersion: this.options.nodeVersion ?? process.versions.node,
      platform: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      memory: {
        main: safeMemory(this.options.memoryUsage ?? (() => process.memoryUsage())),
        ...renderer === undefined
          ? {}
          : { renderer },
      },
    }
    if (input.event !== 'responsive') this.latestFailure = { ...current, event: input.event }
    const record: DesktopDiagnosticRecord = {
      ...current,
      ...this.latestFailure === undefined ? {} : { latestFailure: this.latestFailure },
    }
    this.pending = record
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      while (this.pending !== undefined) {
        const record = this.pending
        this.pending = undefined
        try {
          await mkdir(this.options.logDir, { recursive: true })
          const temporary = this.file + '.tmp'
          await writeFile(temporary, JSON.stringify(record) + '\n', 'utf8')
          await rename(temporary, this.file)
        } catch (_diagnosticWriteFailure) {
          // Diagnostics must never change the shell's lifecycle or recovery path.
        }
      }
    } finally {
      this.writing = false
      if (this.pending !== undefined) void this.flush()
    }
  }
}
