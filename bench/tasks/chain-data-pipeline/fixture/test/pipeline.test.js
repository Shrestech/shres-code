import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/normalize.js'
import { transform } from '../src/transform.js'
import { format } from '../src/format.js'
import { runPipeline } from '../src/pipeline.js'

describe('normalize', () => {
  it('divides each value by 100', () => {
    assert.deepEqual(normalize([100, 250, 50]), [1, 2.5, 0.5])
  })

  it('handles empty array', () => {
    assert.deepEqual(normalize([]), [])
  })
})

describe('transform', () => {
  it('adds 2.5 to each value', () => {
    assert.deepEqual(transform([1, 2.5, 0.5]), [3.5, 5, 3])
  })

  it('handles empty array', () => {
    assert.deepEqual(transform([]), [])
  })
})

describe('format', () => {
  it('rounds to 3 decimal places as strings', () => {
    assert.deepEqual(format([3.5, 5, 3]), ['3.500', '5.000', '3.000'])
  })

  it('rounds correctly', () => {
    assert.deepEqual(format([1.23456, 0.1]), ['1.235', '0.100'])
  })

  it('handles empty array', () => {
    assert.deepEqual(format([]), [])
  })
})

describe('pipeline', () => {
  it('chains normalize → transform → format', () => {
    const result = runPipeline([100, 250, 50])
    assert.deepEqual(result, ['3.500', '5.000', '3.000'])
  })

  it('processes single value', () => {
    assert.deepEqual(runPipeline([200]), ['4.500'])
  })

  it('handles empty input', () => {
    assert.deepEqual(runPipeline([]), [])
  })
})
