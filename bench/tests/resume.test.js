/**
 * Runner --resume: delivered-verdict skipping, pin verification, error rerun.
 *
 * @module bench/tests/resume.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../runner/run.js'

describe('run.parseArgs --resume', () => {
  it('defaults to false and parses the flag', () => {
    assert.equal(parseArgs(['--experiment', 'e']).resume, false)
    assert.equal(parseArgs(['--experiment', 'e', '--resume']).resume, true)
  })

  it('combines with arms, tiers, and the token cap', () => {
    const options = parseArgs([
      '--experiment', 'e', '--resume',
      '--arms', 'off,on-charter',
      '--tier-patch', 'bench/tiers/ollama-deepseek.patch.yml',
      '--max-total-tokens', '500000',
    ])
    assert.equal(options.resume, true)
    assert.equal(options.maxTotalTokens, 500000)
    assert.deepEqual(options.arms, ['off', 'on-charter'])
  })

  it('rejects an unknown argument as before', () => {
    assert.throws(() => parseArgs(['--experiment', 'e', '--resumee']), /unknown argument/)
  })
})
