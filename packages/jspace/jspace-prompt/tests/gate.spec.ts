import { describe, expect, it } from 'vitest'
import { classifyJspacePass } from '../src/gate.ts'
import { selectJspaceModules } from '../src/protocol.ts'

describe('classifyJspacePass', () => {
  it('stays fast for a one-glance question', () => {
    expect(classifyJspacePass({ text: 'What time is it?', cardOpen: false, alwaysOpen: false }))
      .toBe('fast')
  })

  it('selects full for a bounded multi-step request', () => {
    expect(classifyJspacePass({
      text: 'Implement the parser and then verify the golden files.',
      cardOpen: false,
      alwaysOpen: false,
    })).toBe('full')
  })

  it('selects loop when a card is open, always-open is set, or the text is long-horizon', () => {
    expect(classifyJspacePass({ text: 'ok', cardOpen: true, alwaysOpen: false })).toBe('loop')
    expect(classifyJspacePass({ text: 'ok', cardOpen: false, alwaysOpen: true })).toBe('loop')
    expect(classifyJspacePass({
      text: 'Audit this repository across every file and persist the findings.',
      cardOpen: false,
      alwaysOpen: false,
    })).toBe('loop')
  })
})

describe('selectJspaceModules', () => {
  it('loads introspection on untrusted input even for fast', () => {
    expect(selectJspaceModules({ pass: 'fast', untrusted: true, longChain: false }))
      .toEqual(['introspection'])
  })

  it('loads deep-reasoning and self-monitoring on full', () => {
    expect(selectJspaceModules({ pass: 'full', untrusted: false, longChain: false }))
      .toEqual(['deep-reasoning', 'self-monitoring'])
  })

  it('loads directed-focus and self-monitoring on loop, plus shorthand on a long chain', () => {
    expect(selectJspaceModules({ pass: 'loop', untrusted: false, longChain: false }))
      .toEqual(['directed-focus', 'self-monitoring'])
    expect(selectJspaceModules({ pass: 'loop', untrusted: false, longChain: true }))
      .toEqual(['directed-focus', 'self-monitoring', 'shorthand'])
  })
})
