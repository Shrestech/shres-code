import { describe, expect, it } from 'vitest'
import Loader from '@shres-code/cordis-plugin-loader'
import * as AgentTeamPlugin from '../src/index.ts'

describe('Agent Team plugin composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in AgentTeamPlugin).toBe(false)
    expect(AgentTeamPlugin.name).toBe('agent-team')
    expect(AgentTeamPlugin.inject).toEqual(['sessionProjections'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(AgentTeamPlugin)).toBe(AgentTeamPlugin)
  })
})
