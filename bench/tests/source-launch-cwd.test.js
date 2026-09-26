/** Real CLI source resolution from a fresh cwd; requires pnpm install and build. @module */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { getArm, renderArmOverlay } from '../runner/arms.js'
import { resolveHarnessLaunch } from '../runner/execute.js'
import { extractArmRoutes, PREFLIGHT_PLUGIN_PATH, renderPreflightOverlay, startRequestSink } from '../runner/preflight-models.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))

test('the real CLI retains source mappings outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-source-cwd-'))
  const cwd = join(root, 'cwd')
  await mkdir(cwd)
  const launch = resolveHarnessLaunch(repo)
  const sink = await startRequestSink()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)))
  delete env.TSX_TSCONFIG_PATH
  env.SHRES_HOME = join(root, 'home')
  try {
    const arm = renderArmOverlay(getArm('route-cheap'), { sessionLogRoot: join(root, 'sessions') })
    const armPath = join(root, 'arm.patch.yml')
    const probePath = join(root, 'probe.patch.yml')
    await writeFile(armPath, arm)
    await writeFile(probePath, renderPreflightOverlay({ pluginPath: PREFLIGHT_PLUGIN_PATH, sinkUrl: sink.sinkUrl, routes: extractArmRoutes(arm), armOverlayText: arm }))
    const args = [...launch.argsPrefix, '--profile', 'headless', '--patch', armPath, '--patch', probePath]
    const run = childEnv => new Promise(resolve => execFile(launch.command, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))
    const pinned = await run({ ...env, ...launch.env })
    assert.equal(pinned.code, 0, pinned.stderr)
    assert.ok(pinned.stdout.split(String.fromCharCode(10)).some(line => line.startsWith('{') && JSON.parse(line).ok === true))
    const unpinned = await run(env)
    assert.equal(unpinned.code, 1)
    assert.match(unpinned.stderr, /FiberState/)
    assert.equal(sink.count(), 0)
  } finally {
    await sink.close()
    await rm(root, { recursive: true, force: true })
  }
})
