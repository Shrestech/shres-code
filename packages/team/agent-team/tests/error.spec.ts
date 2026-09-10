import { describe, expect, it } from 'vitest'
import { errorMessage, TeamError } from '../src/error.ts'

describe('TeamError', () => {
  it('preserves the machine-routable code and renders unknown rejections', () => {
    const error = new TeamError('disk full', 'TEAM_PERSISTENCE_FAILED')
    expect(error.code).toBe('TEAM_PERSISTENCE_FAILED')
    expect(errorMessage(error)).toBe('disk full')
    expect(errorMessage('boom')).toBe('boom')
  })
})
