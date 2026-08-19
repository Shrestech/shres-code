import { describe, expect, it } from 'vitest'
import { classifyJspacePass } from '../src/gate.ts'

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
