/**
 * `nodePnpmRunner` against real child processes driven by PATH shims: the
 * outcome contract (exit codes, bounded output, scrubbed env, cwd, stdin),
 * startup failures reported as shell exit codes, and abort that kills the
 * child and reaches its close before rejecting. Shims are POSIX sh, so the
 * spawn suites skip on win32, where the runner refuses by contract.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodePnpmRunner } from '../src/profile-pnpm.ts'

/** The runner's per-stream output bound, mirrored from its fixed contract. */
const OUTPUT_BOUND = 1024 * 1024

const TRUNCATION_LABEL = (dropped: number): string =>
  `\n[output truncated: ${dropped} earlier bytes dropped]`

const createdDirs: string[] = []
let restorePath: (() => void) | undefined

afterEach(() => {
  restorePath?.()
  restorePath = undefined
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true })
})

/** Create a throwaway directory cleaned up after the test. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shres-profile-pnpm-'))
  createdDirs.push(dir)
  return dir
}

/**
 * Put a `pnpm` executable with the given sh body first on the child PATH.
 * System dirs and the running node's dir stay on the PATH so shims can use
 * dd/env/sleep and node shims can exec the same runtime.
 */
function useShim(body: string): string {
  const dir = scratchDir()
  const shim = join(dir, 'pnpm')
  writeFileSync(shim, `#!/bin/sh\n${body}\n`)
  chmodSync(shim, 0o755)
  const original = process.env.PATH
  process.env.PATH = `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`
  restorePath = () => { process.env.PATH = original }
  return dir
}

/** Temporarily present process.platform as win32. */
function stubWin32(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  return () => { Object.defineProperty(process, 'platform', descriptor) }
}

describe('nodePnpmRunner', () => {
  it('refuses to run on win32', async () => {
    const restore = stubWin32()
    try {
      await expect(nodePnpmRunner(['--version'], { cwd: scratchDir(), signal: new AbortController().signal }))
        .rejects.toThrow(/win32/)
    } finally {
      restore()
    }
  })

  describe.skipIf(process.platform === 'win32')('spawning pnpm', () => {
    it('runs in the requested cwd, forwards args, and reports a successful outcome', async () => {
      const dir = useShim('echo "cwd=$(pwd)"\necho "args=$*"')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: dir, signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(0)
      expect(outcome.stdout).toContain(`cwd=${realpathSync(dir)}`)
      expect(outcome.stdout).toContain('args=install left-pad')
      expect(outcome.stderr).toBe('')
    })

    it('reports the child exit code and both streams verbatim', async () => {
      useShim('echo out-line\necho err-line >&2\nexit 3')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(3)
      expect(outcome.stdout).toBe('out-line\n')
      expect(outcome.stderr).toBe('err-line\n')
    })

    it('reports 127 with the spawn error when pnpm is missing from PATH', async () => {
      const dir = scratchDir()
      const original = process.env.PATH
      process.env.PATH = dir
      restorePath = () => { process.env.PATH = original }
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: dir, signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(127)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr).toContain('ENOENT')
    })

    it('reports 126 with the spawn error when pnpm cannot be executed', async () => {
      const dir = scratchDir()
      writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\necho unreachable\n')
      const original = process.env.PATH
      process.env.PATH = dir
      restorePath = () => { process.env.PATH = original }
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: dir, signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(126)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr).toContain('EACCES')
    })

    it('keeps the stream tail past the bound and appends the truncation label', async () => {
      useShim('dd if=/dev/zero bs=1024 count=1025 2>/dev/null')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.stdout).toBe('\u0000'.repeat(OUTPUT_BOUND) + TRUNCATION_LABEL(1024))
      expect(outcome.stderr).toBe('')
    })

    it('bounds stderr independently of stdout', async () => {
      useShim('dd if=/dev/zero bs=1024 count=1025 >&2 2>/dev/null')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr).toBe('\u0000'.repeat(OUTPUT_BOUND) + TRUNCATION_LABEL(1024))
    })

    it('keeps output at exactly the bound untruncated', async () => {
      useShim('dd if=/dev/zero bs=1024 count=1024 2>/dev/null')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.stdout).toBe('\u0000'.repeat(OUTPUT_BOUND))
    })

    it('gives the child an ignored stdin: reads see EOF instead of the parent stdin', async () => {
      useShim('if read line; then echo "got:$line"; else echo stdin-eof; fi')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.stdout).toBe('stdin-eof\n')
    })

    it('spawns with a scrubbed environment: credential-shaped and SHRES_ names dropped, others forwarded', async () => {
      useShim('env | sort')
      process.env.SHRES_PNPM_PROBE_TOKEN = 'shres-pnpm-probe-secret'
      process.env.PNPM_PROBE_BENIGN = 'forwarded'
      try {
        const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
        expect(outcome.stdout).not.toContain('SHRES_PNPM_PROBE_TOKEN')
        expect(outcome.stdout).not.toContain('shres-pnpm-probe-secret')
        expect(outcome.stdout).toContain('PNPM_PROBE_BENIGN=forwarded')
        expect(outcome.stdout).toContain('PATH=')
      } finally {
        delete process.env.SHRES_PNPM_PROBE_TOKEN
        delete process.env.PNPM_PROBE_BENIGN
      }
    })

    it('rejects with the abort error only after the child finished closing', async () => {
      // The shim's SIGTERM handler exits 400ms after the signal, so a
      // close-awaiting rejection lands ~400ms after the abort; an immediate
      // rejection would settle within milliseconds of it.
      useShim('exec node -e "process.on(\'SIGTERM\', () => { setTimeout(() => process.exit(0), 400) }); setInterval(() => {}, 2147483000)"')
      const controller = new AbortController()
      let abortedAt = 0
      const pending = nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: controller.signal })
      setTimeout(() => { abortedAt = Date.now(); controller.abort() }, 500)
      await expect(pending).rejects.toThrow(/abort/)
      const elapsedAfterAbort = Date.now() - abortedAt
      expect(elapsedAfterAbort).toBeGreaterThanOrEqual(250)
      expect(elapsedAfterAbort).toBeLessThan(10_000)
    }, 15_000)

    it('escalates to SIGKILL when the child ignores SIGTERM and still reaches close before rejecting', async () => {
      useShim('exec node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 2147483000)"')
      const controller = new AbortController()
      let abortedAt = 0
      const pending = nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: controller.signal })
      setTimeout(() => { abortedAt = Date.now(); controller.abort() }, 500)
      await expect(pending).rejects.toThrow(/abort/)
      const elapsedAfterAbort = Date.now() - abortedAt
      expect(elapsedAfterAbort).toBeGreaterThanOrEqual(2_000)
      expect(elapsedAfterAbort).toBeLessThan(10_000)
    }, 20_000)

    it('rejects without spawning when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: controller.signal }))
        .rejects.toThrow(/abort/)
    })

    it('reports a signal-terminated child as its shell exit code', async () => {
      useShim('kill -KILL $$')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(137)
    })

    it('reports a child terminated by an unknown signal as exit code 128', async () => {
      useShim('kill -HUP $$')
      const outcome = await nodePnpmRunner(['install', 'left-pad'], { cwd: scratchDir(), signal: new AbortController().signal })
      expect(outcome.exitCode).toBe(128)
    })
  })
})
