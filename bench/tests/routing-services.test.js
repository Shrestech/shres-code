/**
 * Composition checks for the shared ZAI/Ollama routing tier overlay.
 *
 * These use the built app-boot composition helper and the vendored include
 * parser, matching the patch application used by the headless launcher.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as yaml from 'js-yaml'
import { composeEntries } from '../../packages/boot/app-boot/lib/index.js'
import { entryListSchema } from '../../vendor/include/lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BASE_PATCH = 'packages/bundle/base/cordis.patch.yml'
const SHARED_PATCH = 'bench/tiers/routing-zai-ollama.patch.yml'

async function readPatch(path) {
  const parsed = yaml.load(await readFile(join(ROOT, path), 'utf8'), { schema: entryListSchema })
  assert.ok(Array.isArray(parsed), `${path} must be a patch list`)
  return parsed
}

async function composeArm(arm) {
  const warnings = []
  const entries = composeEntries([
    await readPatch(BASE_PATCH),
    await readPatch(`bench/routing/${arm}.patch.yml`),
    await readPatch(SHARED_PATCH),
  ], (...args) => warnings.push(args.map(String).join(' ')))
  return { entries: new Map(entries.map(entry => [entry.id, entry])), warnings }
}

test('shared routing tier composes both providers and preserves route-off absence', async () => {
  for (const arm of ['route-off', 'route-on', 'route-shield']) {
    const { entries, warnings } = await composeArm(arm)
    assert.deepEqual(entries.get('agent-default-model')?.config, { provider: 'zai', model: 'glm-5.3' }, arm)

    const providers = entries.get('llm-pi-ai')?.config?.providers
    assert.deepEqual(Object.keys(providers ?? {}).sort(), ['ollama-cloud', 'zai'], arm)
    assert.deepEqual(providers['ollama-cloud'], {
      displayName: 'Ollama Cloud',
      api: 'openai-completions',
      baseURL: 'https://ollama.com/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      models: [
        { id: 'deepseek-v4-flash:cloud', name: 'DeepSeek V4 Flash (cloud)', contextWindow: 1048576, maxTokens: 32768 },
        { id: 'deepseek-v4-pro:cloud', name: 'DeepSeek V4 Pro (cloud)', contextWindow: 1048576, maxTokens: 32768 },
      ],
    }, arm)
    assert.deepEqual(providers.zai, {
      apiKeyEnv: 'ZAI_API_KEY',
      hostedTools: { webSearch: true },
      models: [{ id: 'glm-5.3' }],
    }, arm)

    const router = entries.get('model-router')
    const dispatch = entries.get('judgment-dispatch')
    if (arm === 'route-off') {
      assert.equal(router, undefined)
      assert.equal(dispatch, undefined)
      assert.ok(warnings.some(warning => warning.includes('model-router')), warnings.join('\n'))
      continue
    }

    assert.equal(router?.name, '@shres-code/shres-code-model-router')
    // The dispatcher selects the one engine the arm composes.
    const engine = arm === 'route-on' ? 'typesafe' : 'shield'
    assert.equal(dispatch?.name, '@shres-code/shres-code-judgment-dispatch', arm)
    assert.deepEqual(dispatch?.config, { defaultEngine: engine }, arm)
    assert.equal(entries.get(`judgment-${engine}`)?.name, `@shres-code/shres-code-judgment-${engine}`, arm)
    assert.deepEqual(router?.config?.candidates, [{
      id: 'flash',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:cloud',
      description: 'a routine, bounded task with a known safe fit',
    }], arm)
    assert.equal(router?.config?.downgradeThreshold, 0.8)
    assert.equal(router?.config?.downgradeMargin, 0.1)
    assert.equal(router?.config?.minTurnsDowngraded, 5)
    assert.deepEqual(router?.config?.escalateBack, { scoreThreshold: 3 })
    assert.equal(router?.config?.maxRouteErrors, 2)
    assert.equal(router?.config?.onUnavailable, 'fallback')
    assert.match(router?.config?.routeInstructions, /routine, bounded task/)
    assert.match(router?.config?.routeInstructions, /uncertain, ambiguous/)
    assert.equal(warnings.length, 0, arm)
  }
})
