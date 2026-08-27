import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { add, subtract, multiply } from '../src/math.js'
import { fullName, initials } from '../src/format.js'

describe('math', () => {
  it('add', () => assert.equal(add(2, 3), 5))
  it('subtract', () => assert.equal(subtract(10, 4), 6))
  it('multiply', () => assert.equal(multiply(3, 7), 21))
})

describe('format', () => {
  it('fullName', () => assert.equal(fullName('Jane', 'Doe'), 'Jane Doe'))
  it('initials', () => assert.equal(initials('Jane', 'Doe'), 'JD'))
})
