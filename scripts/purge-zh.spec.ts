/**
 * Acceptance-path coverage for the English-only file purge: artifact
 * classification, vendor exclusion, and skill-tree matching.
 */

import { describe, expect, it } from 'vitest'
import { classifyPurgeTarget, isTranslateSkillPath, isZhArtifact } from './purge-zh.ts'

describe('isZhArtifact', () => {
  it('selects sibling Chinese markdown and pairing records outside vendor/', () => {
    expect(isZhArtifact('docs/architecture.zh.md')).toBe(true)
    expect(isZhArtifact('packages/core/session/README.zh.md')).toBe(true)
    expect(isZhArtifact('docs/architecture.i18n.yaml')).toBe(true)
    expect(isZhArtifact('docs/architecture.md')).toBe(false)
    expect(isZhArtifact('scripts/translation-pairing.manifest.json')).toBe(false)
  })

  it('never classifies vendor/ paths as purge artifacts', () => {
    expect(isZhArtifact('vendor/cordis/README.zh.md')).toBe(false)
    expect(isZhArtifact('vendor/foo/bar.i18n.yaml')).toBe(false)
  })
})

describe('isTranslateSkillPath', () => {
  it('matches both current and leftover translate-docs skill trees', () => {
    expect(isTranslateSkillPath('.agents/skills/roos-translate-docs/SKILL.md')).toBe(true)
    expect(isTranslateSkillPath('.claude/skills/roos-translate-docs/agents/openai.yaml')).toBe(true)
    expect(isTranslateSkillPath('.agents/skills/dsh-translate-docs/SKILL.md')).toBe(true)
    expect(isTranslateSkillPath('.agents/skills/roos-archive-agent-notes/SKILL.md')).toBe(false)
  })
})

describe('classifyPurgeTarget', () => {
  it('splits artifacts from skill trees and leaves everything else', () => {
    expect(classifyPurgeTarget('README.zh.md')).toBe('artifact')
    expect(classifyPurgeTarget('README.i18n.yaml')).toBe('artifact')
    expect(classifyPurgeTarget('.agents/skills/roos-translate-docs/SKILL.md')).toBe('skill')
    expect(classifyPurgeTarget('vendor/cordis/README.zh.md')).toBeUndefined()
    expect(classifyPurgeTarget('README.md')).toBeUndefined()
  })
})
