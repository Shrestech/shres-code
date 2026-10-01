/** Real CLI static-child routing over the public loopback HTTP fixture. @module */
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { getArm, renderArmOverlay } from '../runner/arms.js'
import { executeTrial } from '../runner/execute.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const substitution = fileURLToPath(new URL('./fixtures/real-cli/arm-t-stub.patch.yml', import.meta.url))

/** Import a package's declared built public entry without mounting a plugin. */
async function builtPackage(directory, name) {
  try {
    await access(join(repo, directory, 'lib/index.js'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error('real arm T test requires the harness build; run pnpm run build first', { cause: error })
  }
  const require = createRequire(join(repo, directory, 'package.json'))
  return import(pathToFileURL(require.resolve(name)).href)
}

/** Read real physical records through the public decoder, including packed chunks. */
async function readSession(path, decodeStorageRecord) {
  const [header, ...lines] = (await readFile(path, 'utf8')).trimEnd().split(String.fromCharCode(10))
  return { meta: JSON.parse(header), events: lines.flatMap(line => decodeStorageRecord(JSON.parse(line))) }
}

test('static T keeps the parent strong and routes a real spawned child without judgment', { timeout: 120_000 }, async () => {
  const { startMockLlmServer } = await builtPackage('packages/test-support/llm-mock-server', '@shres-code/shres-code-llm-mock-server')
  const { decodeStorageRecord } = await builtPackage('packages/core/session', '@shres-code/shres-code-session')
  const root = await mkdtemp(join(tmpdir(), 'bench-arm-t-'))
  const scratch = join(root, 'cwd')
  const home = join(root, 'home')
  const sessions = join(root, 'sessions')
  let stub
  let passed = false
  try {
    await Promise.all([scratch, home, sessions].map(path => mkdir(path)))
    const overlayPath = join(root, 'arm.patch.yml')
    const overlay = renderArmOverlay(getArm('route-static'), { sessionLogRoot: sessions })
    assert.doesNotMatch(overlay, /name:.*shres-code-judgment/)
    const route = '"provider":"anthropic","model":"claude-opus-5-5","objective":"quota"'
    assert(overlay.includes(route))
    const mockOverlay = overlay.replace(route, '"provider":"deepseek-official","model":"deepseek-v4-pro","objective":"quota"')
    await writeFile(overlayPath, mockOverlay)
    stub = await startMockLlmServer({
      port: 0,
      apiKey: 'bench-stub',
      sequence: ['tool_call_success', 'success', 'success'],
      toolName: 'subagent',
      toolArguments: JSON.stringify({ description: 'Return one short answer', prompt: 'Reply with CHILD_DONE.', run_in_background: false }),
      successText: 'DONE',
    })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(key)))
    const result = await executeTrial({
      repoRoot: repo,
      overlayPath,
      extraPatchPaths: [substitution],
      sessionArgs: ['--session-id', 'bench-static-parent'],
      taskText: 'Delegate one short foreground task, then report completion.',
      scratchDir: scratch,
      sessionLogRoot: sessions,
      timeoutMs: 90_000,
      env: { ...env, SHRES_HOME: home, SHRES_AGENTS_HOME: join(root, 'agents'), BENCH_STUB_BASE_URL: stub.baseURL + '/v1', BENCH_STUB_KEY: 'bench-stub' },
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.timedOut, false)
    assert.notEqual(result.sessionLogPath, null)
    const parent = await readSession(result.sessionLogPath, decodeStorageRecord)
    const decisions = parent.events.filter(event => event.type === 'model-routing/decision')
    assert(decisions.length > 0)
    for (const event of decisions) {
      assert.equal(event.data.outcome, 'kept-strong')
      assert(['engine-absent', 'warm-prefix'].includes(event.data.reason), event.data.reason)
    }
    const parentHeaders = parent.events.filter(event => event.type === 'request/header')
    assert.equal(parentHeaders.length, 2)
    assert(parentHeaders.every(event => event.data.header.config.model === 'deepseek-v4-pro'))
    const childDecisions = parent.events.filter(event => event.type === 'model-routing/child-decision')
    assert.equal(childDecisions.length, 1)
    assert.equal(childDecisions[0].data.outcome, 'routed')
    assert.equal(childDecisions[0].data.reason, 'child-policy')
    assert.equal(childDecisions[0].data.selection.candidateId, 'flash')
    const files = (await readdir(sessions, { recursive: true })).filter(name => basename(name) === 'session.jsonl').map(name => join(sessions, name))
    assert.equal(files.length, 2)
    const childPath = files.find(path => path !== result.sessionLogPath)
    const child = await readSession(childPath, decodeStorageRecord)
    const descriptor = child.events.find(event => event.type === 'subagent/descriptor')
    assert.equal(descriptor.data.agentRouteRequestId, childDecisions[0].data.routeRequestId)
    const ownHeader = child.events.find(event => event.type === 'request/header' && event.seq >= (child.meta.seedLength ?? 0))
    assert.equal(ownHeader.data.header.config.model, 'deepseek-v4-flash')
    assert.equal(stub.requests.length, 3)
    assert.deepEqual(stub.requests.map(request => request.body.model), ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro'])
    assert(stub.requests.every(request => request.outcome === 'completed'))
    await stub.close()
    await assert.rejects(fetch(stub.baseURL + '/v1/models'), /fetch failed/)
    passed = true
  } catch (error) {
    throw new Error('static T evidence retained at ' + root, { cause: error })
  } finally {
    await stub?.close()
    if (passed) await rm(root, { recursive: true, force: true })
  }
})
