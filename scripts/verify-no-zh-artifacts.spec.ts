/**
 * Acceptance-path coverage for the English-only residue gate: artifact
 * suffixes, vendor exclusion, and CJK allowlisting.
 */

import { describe, expect, it } from 'vitest'
import { findCjkResidue, isCjkAllowlisted, isForbiddenZhArtifact } from './verify-no-zh-artifacts.ts'

describe('isForbiddenZhArtifact', () => {
  it('rejects sibling Chinese markdown and pairing records outside vendor/', () => {
    expect(isForbiddenZhArtifact('docs/architecture.zh.md')).toBe(true)
    expect(isForbiddenZhArtifact('README.i18n.yaml')).toBe(true)
    expect(isForbiddenZhArtifact('docs/architecture.md')).toBe(false)
    expect(isForbiddenZhArtifact('vendor/cordis/README.zh.md')).toBe(false)
  })
})

describe('findCjkResidue', () => {
  it('reports CJK code points and ignores allowlisted frozen archive paths', () => {
    expect(findCjkResidue('docs/architecture.md', 'Agent Note 中文 leftover\n')).toEqual([
      { file: 'docs/architecture.md', line: 1, id: 'cjk' },
    ])
    expect(isCjkAllowlisted('.agents/notes/archived/process/example.md')).toBe(true)
    expect(findCjkResidue('.agents/notes/archived/process/example.md', 'English | [中文](example.zh.md)\n')).toEqual([])
  })
})
