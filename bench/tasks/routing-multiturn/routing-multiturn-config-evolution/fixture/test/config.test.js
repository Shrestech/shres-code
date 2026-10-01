import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadSettings } from '../src/config.js'

function write(settings) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'))
  const file = path.join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(settings))
  return file
}

test('explicit refreshInterval is honored', () => {
  assert.equal(loadSettings(write({ refreshInterval: 60 })).refreshInterval, 60)
})

test('absent refreshInterval currently falls back to 0', () => {
  assert.equal(loadSettings(write({})).refreshInterval, 0)
})
