/**
 * Fixture price snapshot and accounting config for bench tests: round prices
 * (USD per 1M tokens) so every expected figure is hand-computable, and no
 * test depends on the committed snapshot's values.
 *
 * @module bench/tests/helpers/pricing
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A research snapshot with an off-peak model, a midnight-spanning window, an unverified row, a subscription model, and a judge model. */
export const FIXTURE_SNAPSHOT = {
  snapshotDate: '2030-01-01',
  currency: 'USD',
  priceUnit: 'USD per 1,000,000 tokens',
  researchOnly: true,
  models: [
    {
      provider: 'acme', model: 'm1', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2,
      offPeak: { input: 1, output: 5, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 0.1 },
      offPeakWindowsUtc: ['00:00-01:00', '10:00-24:00'],
    },
    {
      provider: 'acme', model: 'night', input: 2, output: 10, cacheWrite5m: null, cacheWrite1h: null, cacheRead: null,
      offPeak: { input: 1, output: 5, cacheWrite5m: null, cacheWrite1h: null, cacheRead: null },
      offPeakWindowsUtc: ['22:00-02:00'],
    },
    {
      provider: 'acme', model: 'flat', input: 2, output: 10, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 0.2,
      offPeak: null, offPeakWindowsUtc: [],
    },
    {
      provider: 'acme', model: 'unverified', input: null, output: null, cacheWrite5m: null, cacheWrite1h: null, cacheRead: null,
      offPeak: null, offPeakWindowsUtc: [],
    },
    {
      provider: 'subco', model: 'big', input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.4,
      offPeak: null, offPeakWindowsUtc: [],
    },
    {
      provider: 'judgeco', model: 'j1', input: 1, output: 2, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 0.5,
      offPeak: null, offPeakWindowsUtc: [],
    },
  ],
}

/** The accounting config the fixture snapshot is priced with. */
export const FIXTURE_CONFIG = {
  subscriptionProviders: ['sub-route'],
  priceProviders: { 'acme-route': 'acme', 'sub-route': 'subco' },
  judgeEnginePriceProviders: { 'llm-judge': 'judgeco' },
  vendorPlanJudgeEngines: ['typesafe'],
}

/**
 * Write the fixture snapshot and config into a directory.
 * @param {string} [dir] - target directory; a fresh temp directory when omitted.
 * @returns {Promise<{ dir: string, pricesDir: string, configPath: string }>}
 */
export async function writeFixturePricing(dir) {
  const target = dir ?? await mkdtemp(join(tmpdir(), 'bench-accounting-'))
  await writeFile(join(target, '2030-01-01.json'), JSON.stringify(FIXTURE_SNAPSHOT))
  await writeFile(join(target, 'accounting.json'), JSON.stringify(FIXTURE_CONFIG))
  return { dir: target, pricesDir: target, configPath: join(target, 'accounting.json') }
}
