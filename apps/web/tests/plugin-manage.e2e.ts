/** Real source-CLI, browser, RPC, and offline pnpm installation lifecycle; no model or user-browser access. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { initProfile, PROFILE_TEMPLATES } from '@shres-code/shres-code-app-boot'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, requireDist } from './support.ts'

const SNAPSHOTS = fileURLToPath(new URL('./snapshots/plugin-manage', import.meta.url))
const OFFLINE = fileURLToPath(new URL('./fixtures/plugin-manage/offline.mjs', import.meta.url))
const MODE = webSnapshotMode()
const PLUGIN = 'fixture-managed-web'

interface RunningWeb {
  url: string
  stop(): Promise<void>
}

async function startWeb(root: string): Promise<RunningWeb> {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(require.resolve('tsx/esm')).href,
    '--import', pathToFileURL(OFFLINE).href,
    join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', '0',
  ], {
    cwd: join(root, 'workspace'),
    env: {
      PATH: process.env.PATH, HOME: join(root, 'home-user'), TMPDIR: join(root, 'tmp'),
      npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'npm-globalrc'),
      DEEPSEEK_API_KEY: 'keyless-installer-no-model-call',
      SHRES_HOME: join(root, 'home'), SHRES_AGENTS_HOME: join(root, 'agents'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
      npm_config_store_dir: join(root, 'store'), npm_config_cache: join(root, 'npm-cache'), npm_config_offline: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<number | null>(resolveClose => child.once('close', resolveClose))
  async function stop(): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const deadline = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
    try { expect(await closed).toBe(0) } finally { clearTimeout(deadline) }
  }
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      let output = ''
      const timer = setTimeout(() => { reject(new Error('Web startup timed out:\n' + output)) }, 90_000)
      const collect = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-65_536)
        const match = /shres web: (http:\/\/[^\s]+)/u.exec(output)
        if (match?.[1] !== undefined) { clearTimeout(timer); resolveReady(match[1]) }
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      void closed.then((code) => { clearTimeout(timer); reject(new Error('Web exited ' + String(code) + ':\n' + output)) })
    })
    return { url, stop }
  } catch (error) {
    try { await stop() } catch { /* Preserve the startup diagnostic after the owned process has closed. */ }
    throw error
  }
}

async function openManage(page: Page, url: string, welcomePending = false): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  const pluginsButton = page.getByRole('button', { name: 'Plugins', exact: true })
  try {
    await expect.poll(async () => await notice.isVisible() || await pluginsButton.isVisible(), { timeout: 30_000 }).toBe(true)
  } catch (error) {
    throw new Error('Web navigation unavailable:\n' + await page.locator('body').innerText(), { cause: error })
  }
  if (welcomePending) {
    await notice.waitFor({ timeout: 30_000 })
    await notice.click()
    await notice.waitFor({ state: 'hidden' })
  }
  await pluginsButton.click()
  const region = page.getByRole('region', { name: 'Plugins', exact: true })
  await region.getByRole('tab', { name: 'Manage', exact: true }).click()
  const manage = region.locator('[role="tabpanel"]:not([hidden])')
  await manage.getByLabel('Package spec', { exact: true }).waitFor({ timeout: 15_000 })
  return manage
}

async function snapshot(page: Page, root: string, name: string): Promise<void> {
  const content = await captureStableAria(page, '[role="region"][aria-label="Plugins"]', root)
  await compareOrRefreshGolden(join(SNAPSHOTS, name + '.expected.md'), content, MODE)
}

it.skipIf(process.platform === 'win32')('manages plugins and skills through the real profile-backed Web UI', async () => {
  requireDist()
  // A POSIX system-temp root prevents workspace ancestor dependencies from masking profile resolution errors.
  const root = await realpath(await mkdtemp('/tmp/shres-plugin-web-'))
  const profile = join(root, 'home/profiles/web')
  const plugin = join(root, 'sources/plugin')
  const skill = join(root, 'sources/skill')
  const marker = join(root, 'plugin-mounted')
  let server: RunningWeb | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let bodyFailure: Error | undefined
  try {
    await mkdir(join(root, 'workspace'), { recursive: true })
    await mkdir(join(root, 'home-user'), { recursive: true })
    await mkdir(join(root, 'tmp'), { recursive: true })
    await writeFile(join(root, 'npmrc'), '')
    await writeFile(join(root, 'npm-globalrc'), '')
    await mkdir(plugin, { recursive: true })
    await mkdir(skill, { recursive: true })
    if (MODE === 'refresh') await mkdir(SNAPSHOTS, { recursive: true })
    // A user-authored profile without optional edition inventory: no edition package download is requested.
    initProfile(profile, PROFILE_TEMPLATES.web!)
    await writeFile(join(plugin, 'package.json'), JSON.stringify({
      name: PLUGIN, version: '1.0.0', type: 'module', main: 'index.js', shres: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    const moduleText = "import { writeFileSync } from 'node:fs'\nexport const name = 'managed-web-probe'\n"
      + "export function apply(ctx, config) { ctx.effect(() => { writeFileSync(config.marker, 'active'); "
      + "return () => { writeFileSync(config.marker, 'disposed') } }, 'managed-web-probe:marker') }\n"
    await writeFile(join(plugin, 'index.js'), moduleText)
    await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n  - id: managed-web-probe\n    name: ' + PLUGIN
      + '\n    config:\n      marker: ' + JSON.stringify(marker) + '\n')
    await writeFile(join(skill, 'SKILL.md'), '---\nname: web-install-probe\ndescription: Keyless installed skill probe.\n---\nFixture instructions.\n')

    server = await startWeb(root)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    let manage = await openManage(page, server.url, true)
    for (const template of ['@shres-code/shres-code-base', '@shres-code/shres-code-web-app']) {
      await manage.getByText(template, { exact: true }).waitFor()
      expect(await manage.getByRole('button', { name: 'Remove: ' + template, exact: true }).count()).toBe(0)
    }
    await snapshot(page, root, 'initial')

    await manage.getByLabel('Skill directory', { exact: true }).fill(skill)
    await manage.getByRole('button', { name: 'Add skill', exact: true }).click()
    await manage.getByText('Skill installed. web-install-probe', { exact: true }).waitFor()
    expect(await readFile(join(root, 'home/skills-installed/web-install-probe/SKILL.md'), 'utf8')).toContain('Fixture instructions.')
    await snapshot(page, root, 'skill-added')
    await manage.getByRole('button', { name: 'Remove: web-install-probe', exact: true }).click()
    await manage.getByText('Skill removed. web-install-probe', { exact: true }).waitFor()
    await expect(readFile(join(root, 'home/skills-installed/web-install-probe/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const original = await readFile(join(profile, 'package.json'), 'utf8')
    await manage.getByLabel('Package spec', { exact: true }).fill(plugin)
    await manage.getByRole('button', { name: 'Install', exact: true }).click()
    await manage.getByRole('heading', { name: 'Review install', exact: true }).waitFor({ timeout: 30_000 })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await snapshot(page, root, 'preview')
    await manage.getByRole('button', { name: 'Cancel', exact: true }).click()
    await manage.getByText('Install cancelled. The profile was restored.', { exact: true }).waitFor({ timeout: 30_000 })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(original)
    await expect(readFile(join(profile, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(profile, '.shres-plugin-txn.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(profile, '.shres-plugin-sources'))).toEqual([])

    const scripted = join(root, 'sources/scripted')
    const buildMarker = join(root, 'build-ran')
    await mkdir(scripted)
    await writeFile(join(scripted, 'package.json'), JSON.stringify({
      name: 'fixture-managed-scripted', version: '1.0.0', type: 'module',
      scripts: { postinstall: 'node build.js' }, shres: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    await writeFile(join(scripted, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(scripted, 'build.js'), "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(buildMarker) + ", 'unexpected')\n")
    await manage.getByLabel('Package spec', { exact: true }).fill(scripted)
    await manage.getByRole('button', { name: 'Install', exact: true }).click()
    await manage.getByRole('alert').waitFor({ timeout: 30_000 })
    expect(await manage.getByRole('alert').innerText()).toContain('Refused: the package or its dependencies declare install scripts')
    await expect(readFile(buildMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(original)
    await snapshot(page, root, 'build-refused')

    await manage.getByLabel('Package spec', { exact: true }).fill(plugin)
    await manage.getByRole('button', { name: 'Install', exact: true }).click()
    await manage.getByRole('button', { name: 'Confirm install', exact: true }).waitFor({ timeout: 30_000 })
    await manage.getByRole('button', { name: 'Confirm install', exact: true }).click()
    await manage.getByText('Plugin installed. Restart the app to activate it. ' + PLUGIN + ' 1.0.0', { exact: true }).waitFor({ timeout: 30_000 })
    await snapshot(page, root, 'installed')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(plugin, 'index.js'), 'throw new Error("original source must not be loaded")\n')
    expect(await readFile(join(profile, 'node_modules', PLUGIN, 'index.js'), 'utf8')).toBe(moduleText)
    await page.close()
    await server.stop()
    server = undefined

    server = await startWeb(root)
    expect(await readFile(marker, 'utf8')).toBe('active')
    page = await newEnglishPage(browser)
    manage = await openManage(page, server.url)
    const row = manage.locator('[data-plugin-state]').filter({ hasText: PLUGIN })
    expect(await row.getAttribute('data-plugin-state')).toBe('active')
    await snapshot(page, root, 'active')
    await manage.getByRole('button', { name: 'Remove: ' + PLUGIN, exact: true }).click()
    await manage.getByText('Plugin removed. Restart the app to finish. ' + PLUGIN, { exact: true }).waitFor({ timeout: 30_000 })
    await snapshot(page, root, 'removed')
    expect(await readdir(join(profile, '.shres-plugin-sources'))).toEqual([])
    expect(await readFile(join(profile, 'package.json'), 'utf8')).not.toContain(PLUGIN)
    expect(await readFile(marker, 'utf8')).toBe('active')
    await page.close()
    await server.stop()
    server = undefined
    await writeFile(marker, 'not-mounted')
    server = await startWeb(root)
    expect(await readFile(marker, 'utf8')).toBe('not-mounted')
    page = await newEnglishPage(browser)
    manage = await openManage(page, server.url)
    expect(await manage.locator('[data-plugin-state]').filter({ hasText: PLUGIN }).count()).toBe(0)
    await snapshot(page, root, 'removed-after-restart')
  } catch (error) {
    const text = page === undefined || page.isClosed() ? '' : await page.locator('body').innerText()
    bodyFailure = new Error(String(error) + '\nCurrent Web state:\n' + text, { cause: error })
    throw bodyFailure
  } finally {
    const cleanupErrors: unknown[] = []
    try { await browser?.close() } catch (error) { cleanupErrors.push(error) }
    try { await server?.stop() } catch (error) { cleanupErrors.push(error) }
    try { await rm(root, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(bodyFailure === undefined ? cleanupErrors : [bodyFailure, ...cleanupErrors], 'Web fixture cleanup failed', { cause: bodyFailure })
    }
  }
}, 180_000)
