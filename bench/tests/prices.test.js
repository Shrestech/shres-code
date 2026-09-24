/**
 * Schema tests for the dated bench price snapshots under bench/prices. A
 * snapshot is research data: every price is a verified non-negative number or
 * null, every null is declared in `nullFields`, and `unverified` marks an
 * entry whose whole price row is unknown.
 *
 * @module bench/tests/prices
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const pricesDir = fileURLToPath(new URL('../prices/', import.meta.url))

/** Price fields, shared by an entry and its `offPeak` sibling. */
const PRICE_FIELDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']

/** Required top-level entry fields. */
const ENTRY_FIELDS = [
  'provider', 'model', 'currency', ...PRICE_FIELDS,
  'offPeak', 'nullFields', 'peakWindowsUtc', 'offPeakWindowsUtc', 'sourceUrl', 'fetched', 'unverified',
]

/** `HH:MM-HH:MM`, both ends in UTC. */
const WINDOW = /^\d{2}:\d{2}-\d{2}:\d{2}$/

/**
 * Every dated snapshot, parsed, with its filename stem.
 * @returns {{date: string, name: string, doc: Record<string, unknown>}[]}
 */
function snapshots() {
  return readdirSync(pricesDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map(name => ({
      date: name.slice(0, -'.json'.length),
      name,
      doc: JSON.parse(readFileSync(join(pricesDir, name), 'utf8')),
    }))
}

/** Every `[entry, field, value]` price a snapshot declares, including off-peak. */
function priceFields(doc) {
  const out = []
  for (const entry of doc.models) {
    for (const field of PRICE_FIELDS) out.push([entry, field, entry[field]])
    if (entry.offPeak !== null && entry.offPeak !== undefined) {
      for (const field of PRICE_FIELDS) out.push([entry, `offPeak.${field}`, entry.offPeak[field]])
    }
  }
  return out
}

/** Price paths an entry leaves null, in the notation `nullFields` uses. */
function nullPricePaths(entry) {
  const paths = []
  for (const field of PRICE_FIELDS) if (entry[field] === null) paths.push(field)
  if (entry.offPeak !== null && entry.offPeak !== undefined) {
    for (const field of PRICE_FIELDS) if (entry.offPeak[field] === null) paths.push(`offPeak.${field}`)
  }
  return paths
}

describe('bench price snapshots', () => {
  it('finds at least one dated snapshot, each naming its own date', () => {
    const found = snapshots()
    assert.ok(found.length > 0, 'bench/prices holds a dated snapshot')
    for (const { date, doc } of found) {
      assert.equal(doc.snapshotDate, date, `${date}: snapshotDate matches the filename`)
      assert.equal(doc.currency, 'USD')
      assert.equal(doc.researchOnly, true)
      assert.ok(Array.isArray(doc.models) && doc.models.length > 0)
    }
  })

  it('gives every entry the required fields', () => {
    for (const { name, doc } of snapshots()) {
      for (const entry of doc.models) {
        for (const field of ENTRY_FIELDS) {
          assert.ok(field in entry, `${name}: ${entry.provider}/${entry.model} is missing ${field}`)
        }
        assert.equal(entry.currency, 'USD', `${name}: ${entry.model} is priced in USD`)
        assert.equal(typeof entry.unverified, 'boolean')
        assert.ok(Array.isArray(entry.nullFields))
        assert.ok(entry.fetched === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.fetched))
        assert.ok(entry.sourceUrl === null || typeof entry.sourceUrl === 'string')
        assert.ok(Array.isArray(entry.peakWindowsUtc))
        assert.ok(Array.isArray(entry.offPeakWindowsUtc))
      }
    }
  })

  it('states every price as a non-negative number or null', () => {
    for (const { name, doc } of snapshots()) {
      for (const [entry, field, value] of priceFields(doc)) {
        assert.ok(
          value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0),
          `${name}: ${entry.provider}/${entry.model} ${field} is ${String(value)}`,
        )
      }
    }
  })

  it('declares exactly the null price fields in nullFields', () => {
    for (const { name, doc } of snapshots()) {
      for (const entry of doc.models) {
        assert.deepEqual(
          [...entry.nullFields].sort(),
          nullPricePaths(entry).sort(),
          `${name}: ${entry.provider}/${entry.model} nullFields disagrees with its null price fields`,
        )
      }
    }
  })

  it('marks an entry unverified only when its whole price row is unknown', () => {
    for (const { name, doc } of snapshots()) {
      for (const entry of doc.models) {
        const priced = PRICE_FIELDS.filter(field => entry[field] !== null)
        if (entry.unverified) {
          assert.equal(priced.length, 0, `${name}: ${entry.provider}/${entry.model} is unverified but carries a price`)
        } else {
          assert.ok(priced.length > 0, `${name}: ${entry.provider}/${entry.model} is verified but carries no price`)
        }
      }
    }
  })

  it('writes every window as HH:MM-HH:MM in UTC', () => {
    for (const { name, doc } of snapshots()) {
      for (const entry of doc.models) {
        for (const window of [...entry.peakWindowsUtc, ...entry.offPeakWindowsUtc]) {
          assert.match(window, WINDOW, `${name}: ${entry.model} window ${window}`)
        }
      }
    }
  })

  it('records the verification provenance in the shape the README documents', () => {
    for (const { name, doc } of snapshots()) {
      for (const entry of doc.models) {
        if (entry.verification !== undefined) {
          assert.ok(typeof entry.verification === 'string' && entry.verification.length > 0)
        }
        if (entry.verificationSources !== undefined) {
          assert.ok(Array.isArray(entry.verificationSources) && entry.verificationSources.length > 0)
          for (const url of entry.verificationSources) assert.match(url, /^https:\/\//)
        }
      }
    }
  })

  it('keys each provider/model pair once per snapshot', () => {
    for (const { name, doc } of snapshots()) {
      const seen = new Set()
      for (const entry of doc.models) {
        const key = `${entry.provider}/${entry.model}`
        assert.ok(!seen.has(key), `${name}: duplicate entry ${key}`)
        seen.add(key)
      }
    }
  })
})
