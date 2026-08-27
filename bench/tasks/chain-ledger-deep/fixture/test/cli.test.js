import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from '../src/cli.js'

test('parses long flags with a following value', () => {
  assert.deepEqual(parseArgs(['--name', 'ada', '--count', '3']), {
    flags: { name: 'ada', count: '3' },
    positionals: [],
  })
})

test('parses a bare flag as boolean true', () => {
  assert.deepEqual(parseArgs(['file.txt', '--verbose']), {
    flags: { verbose: true },
    positionals: ['file.txt'],
  })
})

test('parses --key=value', () => {
  assert.deepEqual(parseArgs(['--out=dest.json']), {
    flags: { out: 'dest.json' },
    positionals: [],
  })
})

test('treats tokens after -- as positionals', () => {
  assert.deepEqual(parseArgs(['--a', '1', '--', '--not-a-flag']), {
    flags: { a: '1' },
    positionals: ['--not-a-flag'],
  })
})

test('a flag without a value is boolean true', () => {
  assert.deepEqual(parseArgs(['--quiet']), {
    flags: { quiet: true },
    positionals: [],
  })
})
