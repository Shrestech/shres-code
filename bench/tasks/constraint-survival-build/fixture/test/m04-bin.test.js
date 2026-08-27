import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invBinDistance, invDecodeBin, invEncodeBin } from '../src/m04-bin.js'

describe('m04-bin', () => {
  it('encodes aisle-rack-shelf with zero-padded aisle and rack', () => {
    assert.equal(invEncodeBin(12, 3, 1), 'A12-R03-S1')
    assert.equal(invEncodeBin(2, 10, 9), 'A02-R10-S9')
  })

  it('decodes a bin code', () => {
    assert.deepEqual(invDecodeBin('A12-R03-S1'), { aisle: 12, rack: 3, shelf: 1 })
  })

  it('rejects out-of-range parts and bad codes', () => {
    assert.throws(() => invEncodeBin(0, 1, 1), /invalid bin/)
    assert.throws(() => invEncodeBin(1, 1, 10), /invalid bin/)
    assert.throws(() => invDecodeBin('X12-R03-S1'), /invalid bin/)
  })

  it('computes manhattan distance between two bins', () => {
    assert.equal(invBinDistance('A01-R01-S1', 'A03-R02-S2'), 4)
  })
})
