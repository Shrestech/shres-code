import { describe, expect, it } from 'vitest'
import { deriveTrajectoryLayout } from '../src/client/layout.ts'

describe('CHILD-ROUTE trajectory rows', () => {
  it('labels a routed child and a kept child, with a shadow suffix', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      routingChildren: [
        { seq: 10, time: 1, outcome: 'routed', reason: 'child-policy', model: 'deepseek-official/deepseek-v4-flash' },
        { seq: 11, time: 2, outcome: 'kept', reason: 'base-unlisted', shadow: true },
      ],
    })
    const texts = turns.flatMap(turn => turn.groups.flatMap(group => group.cells.map(cell => cell.text)))
    expect(texts).toContain('Subagent routed to deepseek-official/deepseek-v4-flash')
    expect(texts).toContain('Subagent kept your model: base-unlisted (shadow)')
  })
})
