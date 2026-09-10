import { describe, expect, it } from 'vitest'
import { TeamTaskId } from '../src/brand.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from '../src/task-graph.ts'
import { task } from './helpers.ts'

describe('assertTaskGraphCandidate', () => {
  it('accepts an acyclic graph and a deleted blocker that is no longer referenced', () => {
    const first = task()
    const second = task({
      id: TeamTaskId('task-2'),
      blockedBy: [TeamTaskId('task-1')],
    })
    expect(() => {
      assertTaskGraphCandidate([], first)
    }).not.toThrow()
    expect(() => {
      assertTaskGraphCandidate([first], second)
    }).not.toThrow()
    expect(() => {
      assertTaskGraphCandidate([first, second], {
        ...second,
        revision: 2,
        blockedBy: [],
      })
    }).not.toThrow()
    const deleted = task({ status: 'deleted' })
    const released = task({
      id: TeamTaskId('task-2'),
      blockedBy: [],
    })
    expect(() => {
      assertTaskGraphCandidate([deleted], released)
    }).not.toThrow()
    expect(() => {
      assertTaskGraphCandidate([deleted, released], task({
        id: TeamTaskId('task-3'),
        blockedBy: [TeamTaskId('task-2')],
      }))
    }).not.toThrow()
  })

  it('classifies missing, duplicate, and cyclic relations', () => {
    try {
      assertTaskGraphCandidate([], task({ blockedBy: [TeamTaskId('missing')] }))
      throw new Error('expected graph error')
    } catch (error) {
      expect(error).toBeInstanceOf(TeamTaskGraphError)
      expect((error as TeamTaskGraphError).violation).toBe('missing')
    }
    try {
      assertTaskGraphCandidate([task()], task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')],
      }))
      throw new Error('expected graph error')
    } catch (error) {
      expect((error as TeamTaskGraphError).violation).toBe('duplicate')
    }
    try {
      assertTaskGraphCandidate([task()], task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }))
      assertTaskGraphCandidate([
        task(),
        task({ id: TeamTaskId('task-2'), blockedBy: [TeamTaskId('task-1')] }),
      ], task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }))
      throw new Error('expected graph error')
    } catch (error) {
      expect((error as TeamTaskGraphError).violation).toBe('cycle')
    }
  })
})
