/**
 * Composed-metadata preflight tests. The real launcher boots per routing-
 * measurement arm with the generated overlay; the loopback sink must stay at
 * zero requests and no session log may appear. Keyless: the child environment
 * carries no credential and the scratch home holds none. The launcher needs
 * the repository's build outputs (`pnpm run build`) and installed workspace
 * links (`pnpm install`); the tests fail loud naming the remedy.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { access, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PREFLIGHT_ARMS, PREFLIGHT_PLUGIN_PATH, assertPreflightArms, extractArmRoutes, renderPreflightOverlay, runPreflight, spawnPreflight } from '../runner/preflight-models.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const bench = join(here, '..')

/** Fail loud when the repository build outputs the launcher needs are absent. */
async function assertBuildOutputs() {
  try {
    await access(join(repo, 'vendor', 'schemastery', 'lib', 'index.mjs'))
    await access(PREFLIGHT_PLUGIN_PATH)
  } catch {
    throw new Error(`the preflight boots the real launcher, whose plugin faces need the repository build outputs; run pnpm run build first (${PREFLIGHT_PLUGIN_PATH} or a build face is absent)`)
  }
}

/** Strip credentials the way the preflight does, for direct spawn calls. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key)),
)

/** One scratch home; the caller removes it. */
async function scratchHome() {
  const root = await mkdtemp(join(tmpdir(), 'bench-preflight-test-'))
  return { root, home: join(root, 'home') }
}

test('the launcher resolves S, C, R and N routes through the real composition with zero requests and no session', async () => {
  await assertBuildOutputs()
  for (const arm of ['route-strong', 'route-cheap', 'route-coldpoint', 'route-random']) {
    const records = await runPreflight({ repoRoot: repo, benchRoot: bench, arms: [arm], env: process.env })
    assert.equal(records.length, 1, `${arm}: the preflight covered the arm`)
    assert.equal(records[0].arm, arm)
    assert.ok(records[0].routes >= 1, `${arm}: at least the conversation route was resolved`)
    // runPreflight already refused on any sink request, any unresolved route,
    // and any session log; C additionally carried the observer requirement.
    if (arm === 'route-cheap') assert.equal(records[0].workerEscalation, true, 'arm C composes the worker-escalation observer')
  }
})

test('the C-arm overlay composes worker-escalation and the preflight asserts it; a missing observer fails', async () => {
  await assertBuildOutputs()
  // A hand-built composition without the observer fails the line by name.
  const overlay = renderPreflightOverlay({
    pluginPath: PREFLIGHT_PLUGIN_PATH,
    sinkUrl: 'http://127.0.0.1:9',
    routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    requireWorkerEscalation: true,
    armOverlayText: '',
  })
  const { root, home } = await scratchHome()
  try {
    const armOverlayPath = join(root, 'arm.patch.yml')
    await writeFile(armOverlayPath, '[]\n')
    const overlayPath = join(root, 'no-observer.preflight.patch.yml')
    await writeFile(overlayPath, overlay)
    const { line, exitCode } = await spawnPreflight({ repoRoot: repo, armOverlayPath, overlayPath, homeDir: home, env: CLEAN_ENV })
    assert.equal(exitCode, 1)
    assert.equal(line.ok, false)
    assert.match(String(line.reason), /worker-escalation observer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unregistered provider fails the line with the named route, and runPreflight refuses it', async () => {
  await assertBuildOutputs()
  const fakeBench = join(await mkdtemp(join(tmpdir(), 'bench-preflight-fake-')), 'bench')
  await mkdir(join(fakeBench, 'routing'), { recursive: true })
  await writeFile(join(fakeBench, 'routing', 'route-strong.patch.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: "no-such-adapter"',
    '    model: "some-model"',
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      runPreflight({ repoRoot: repo, benchRoot: fakeBench, arms: ['route-strong'], env: process.env }),
      /no-such-adapter\/some-model/,
    )
  } finally {
    await rm(join(fakeBench, '..'), { recursive: true, force: true })
  }
})

test('the generated overlay always disables both one-shot rows, and without them the runner takes over', async () => {
  const overlay = renderPreflightOverlay({
    pluginPath: PREFLIGHT_PLUGIN_PATH,
    sinkUrl: 'http://127.0.0.1:9',
    routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    requireWorkerEscalation: false,
    armOverlayText: '',
  })
  assert.match(overlay, /- id: headless-runner\n  disabled: true/)
  assert.match(overlay, /- id: headless-startup\n  disabled: true/)
  // Negative control with a real spawn: an overlay without the disable rows
  // leaves the one-shot runner in composition, which refuses the missing task
  // positional and takes the preflight's context down with it.
  await assertBuildOutputs()
  const driverOverlay = [
    '- id: llm-deepseek',
    '  config:',
    '    baseURL: "http://127.0.0.1:9"',
    '- insert:',
    '    - id: bench-preflight',
    `      name: ${JSON.stringify(PREFLIGHT_PLUGIN_PATH)}`,
    '      config:',
    '        routes:',
    '          - provider: "deepseek-official"',
    '            model: "deepseek-v4-flash"',
    '',
  ].join('\n')
  const { root, home } = await scratchHome()
  try {
    const armOverlayPath = join(root, 'arm.patch.yml')
    await writeFile(armOverlayPath, '[]\n')
    const overlayPath = join(root, 'driver-left-in.patch.yml')
    await writeFile(overlayPath, driverOverlay)
    const { line, stderr } = await spawnPreflight({ repoRoot: repo, armOverlayPath, overlayPath, homeDir: home, env: CLEAN_ENV })
    assert.notEqual(line.ok, true)
    assert.match(stderr, /a task is required/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('arm T is refused by name until the PR 13b consumer lands, before any spawn', async () => {
  await assert.rejects(
    assertPreflightArms(['route-static']),
    /route-static[\s\S]*PR 13b/,
  )
  await assert.rejects(
    runPreflight({ repoRoot: repo, benchRoot: bench, arms: ['route-static'], env: process.env }),
    /route-static/,
  )
})

test('the preflight plugin unit: loader ordering, line shape, and the appExit-absent throw', async () => {
  const plugin = await import(pathToFileURL(PREFLIGHT_PLUGIN_PATH).href)
  // apply throws synchronously when the launcher provides no appExit.
  assert.throws(() => plugin.apply({ get: () => undefined }, { routes: [] }), /appExit/)
  const order = []
  let exitCode
  /** @type {string[]} */
  const written = []
  const exits = new Map([['appExit', (code) => { exitCode = code }]])
  const entries = [{ options: { name: '@shres-code/shres-code-worker-escalation' } }]
  const services = new Map([
    ['loader', { await: async () => { order.push('loader.await') }, entries: () => entries }],
    ['llm', { resolveModelInfo: async (provider, model) => {
      order.push('resolveModelInfo')
      if (model === 'broken') throw new Error('no such model')
      return { contextWindow: 1 }
    } }],
  ])
  const ctx = {
    get: name => {
      order.push(`get:${name}`)
      return exits.get(name) ?? services.get(name)
    },
    loader: services.get('loader'),
  }
  const originalWrite = plugin.internals.write
  plugin.internals.write = chunk => { written.push(chunk) }
  try {
    plugin.apply(ctx, { routes: [{ provider: 'p', model: 'm' }], requireWorkerEscalation: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(order, ['get:appExit', 'get:loader', 'loader.await', 'get:llm', 'resolveModelInfo'])
    assert.equal(written.length, 1)
    const line = JSON.parse(written[0])
    assert.equal(line.ok, true)
    assert.equal(line.workerEscalation, true)
    assert.deepEqual(line.routes, [{ provider: 'p', model: 'm', resolved: true }])
    assert.equal(exitCode, 0)
    exitCode = undefined
    written.length = 0
    plugin.apply(ctx, { routes: [{ provider: 'p', model: 'broken' }], requireWorkerEscalation: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    const failed = JSON.parse(written[0])
    assert.equal(failed.ok, false)
    assert.match(failed.routes[0].error, /no such model/)
    assert.equal(exitCode, 1)
  } finally {
    plugin.internals.write = originalWrite
  }
})
