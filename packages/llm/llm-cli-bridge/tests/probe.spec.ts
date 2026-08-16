import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableOnPath } from '../src/probe.ts'

describe('executableOnPath', () => {
  it('finds a command on PATH and rejects an absent name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-probe-'))
    const bin = join(dir, 'codex')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    expect(executableOnPath('codex', dir, 'linux')).toBe(true)
    expect(executableOnPath('claude', dir, 'linux')).toBe(false)
    expect(executableOnPath('', dir, 'linux')).toBe(false)
  })

  it('accepts an absolute executable path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-probe-abs-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    expect(executableOnPath(bin, '/does-not-exist', 'linux')).toBe(true)
  })
})
