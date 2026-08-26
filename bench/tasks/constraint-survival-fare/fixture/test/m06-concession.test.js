import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { concessionFare } from '../src/m06-concession.js'

describe('m06-concession', () => {
  it('applies each known rate and floors the result', () => {
    assert.equal(concessionFare(400, 'adult'), 400)
    assert.equal(concessionFare(400, 'child'), 200)
    assert.equal(concessionFare(400, 'senior'), 260)
    assert.equal(concessionFare(400, 'student'), 320)
    assert.equal(concessionFare(333, 'child'), 166)
  })

  it('rejects an unknown concession kind', () => {
    assert.throws(() => concessionFare(400, 'staff'), /unknown concession/)
  })

  it('rejects a non-finite or negative fare', () => {
    assert.throws(() => concessionFare(-1, 'adult'), /invalid fare/)
    assert.throws(() => concessionFare(NaN, 'adult'), /invalid fare/)
  })
})
