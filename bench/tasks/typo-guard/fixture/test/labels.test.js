import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WELCOME_LABEL, SUCCESS_STATUS, SEARCH_PLACEHOLDER } from '../src/labels.js'

describe('labels', () => {
  it('WELCOME_LABEL is spelled correctly', () => {
    assert.equal(WELCOME_LABEL, 'Welcome to the Dashboard')
  })

  it('SUCCESS_STATUS is spelled correctly', () => {
    assert.equal(SUCCESS_STATUS, 'Operation Successful')
  })

  it('SEARCH_PLACEHOLDER is spelled correctly', () => {
    assert.equal(SEARCH_PLACEHOLDER, 'Search by name or ID...')
  })
})
