import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceJourney } from '../src/m07-journey.js'

const TWO_LEGS = [
  { from: 'CEN', to: 'PAR' },
  { from: 'PAR', to: 'AIR' },
]

describe('m07-journey', () => {
  it('prices an adult daytime two-leg journey with a transfer', () => {
    assert.deepEqual(
      priceJourney(TWO_LEGS, { kind: 'adult', minutesAfterMidnight: 800, spentToday: 0 }),
      {
        legs: [
          {
            from: 'CEN',
            to: 'PAR',
            fromZone: 1,
            toZone: 2,
            base: 340,
            discount: 0,
            surcharge: 0,
            fare: 340,
          },
          {
            from: 'PAR',
            to: 'AIR',
            fromZone: 2,
            toZone: 4,
            base: 430,
            discount: 180,
            surcharge: 0,
            fare: 250,
          },
        ],
        subtotal: 590,
        total: 590,
      },
    )
  })

  it('applies a child concession to each leg', () => {
    const priced = priceJourney(TWO_LEGS, {
      kind: 'child',
      minutesAfterMidnight: 800,
      spentToday: 0,
    })
    assert.equal(priced.legs[0].fare, 170)
    assert.equal(priced.legs[1].fare, 125)
    assert.equal(priced.subtotal, 295)
    assert.equal(priced.total, 295)
  })

  it('adds the night surcharge before the concession', () => {
    const priced = priceJourney(TWO_LEGS, {
      kind: 'adult',
      minutesAfterMidnight: 100,
      spentToday: 0,
    })
    assert.equal(priced.legs[0].surcharge, 51)
    assert.equal(priced.legs[1].surcharge, 37)
    assert.equal(priced.legs[0].fare, 391)
    assert.equal(priced.legs[1].fare, 287)
    assert.equal(priced.subtotal, 678)
    assert.equal(priced.total, 678)
  })

  it('clips the journey total with the daily cap', () => {
    const priced = priceJourney(TWO_LEGS, {
      kind: 'adult',
      minutesAfterMidnight: 800,
      spentToday: 1300,
    })
    assert.equal(priced.subtotal, 590)
    assert.equal(priced.total, 100)
  })

  it('rejects an empty or non-array legs argument', () => {
    const options = { kind: 'adult', minutesAfterMidnight: 800, spentToday: 0 }
    assert.throws(() => priceJourney([], options), /legs must be a non-empty array/)
    assert.throws(() => priceJourney(null, options), /legs must be a non-empty array/)
  })

  it('rejects missing or malformed options', () => {
    assert.throws(() => priceJourney(TWO_LEGS, null), /invalid options/)
    assert.throws(() => priceJourney(TWO_LEGS, { minutesAfterMidnight: 800, spentToday: 0 }), /invalid options/)
    assert.throws(() => priceJourney(TWO_LEGS, { kind: 'adult', spentToday: 0 }), /invalid options/)
    assert.throws(
      () => priceJourney(TWO_LEGS, { kind: 'adult', minutesAfterMidnight: 800 }),
      /invalid options/,
    )
  })
})
