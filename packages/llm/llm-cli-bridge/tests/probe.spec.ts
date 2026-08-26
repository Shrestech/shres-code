import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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

  it('looks for Windows executable suffixes on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-probe-win-'))
    writeFileSync(join(dir, 'codex.cmd'), '@echo off\n')
    chmodSync(join(dir, 'codex.cmd'), 0o755)
    expect(executableOnPath('codex', dir, 'win32')).toBe(true)
  })

  it('skips empty PATH segments', () => {
    expect(executableOnPath('nope', `${delimiter}${delimiter}`, 'linux')).toBe(false)
  })

  it('treats a missing PATH as empty', () => {
    const previous = process.env.PATH
    delete process.env.PATH
    try {
      expect(executableOnPath('nope')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })
})
