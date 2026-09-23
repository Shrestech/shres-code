/**
 * Live Playwright walk of Settings → Models / Customize on the running
 * shres web at 127.0.0.1:3080. Prints a report; non-zero exit on failure.
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.SHRES_WEB_URL ?? 'http://127.0.0.1:3080'
const SHOT = join(fileURLToPath(new URL('../../../.artifacts/verify-models-seats/', import.meta.url)))
const failures = []
const notes = []

function ok(name, cond, detail = '') {
  if (cond) notes.push(`PASS  ${name}`)
  else {
    failures.push(detail === '' ? name : `${name}: ${detail}`)
    notes.push(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function dismissOnboarding(page) {
  for (const name of ['Continue', 'Configure later', 'Close']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.count() > 0 && await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      await page.waitForTimeout(400)
    }
  }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' })
const consoleErrors = []
page.on('pageerror', error => { consoleErrors.push(String(error)) })
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
await mkdir(SHOT, { recursive: true })

try {
  await page.goto(BASE, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await dismissOnboarding(page)
  await page.screenshot({ path: join(SHOT, '00-home.png'), fullPage: true })

  const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true })
  await settingsTrigger.waitFor({ timeout: 15_000 })
  await settingsTrigger.click()
  const dialog = page.getByRole('region', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  ok('settings page opened', await dialog.isVisible())

  const modelsNav = dialog.getByRole('button', { name: 'Models & providers', exact: true })
  await modelsNav.click()
  await Promise.race([
    dialog.getByRole('heading', { name: 'Providers', exact: true }).waitFor({ timeout: 15_000 }),
    dialog.getByRole('heading', { name: 'Seats', exact: true }).waitFor({ timeout: 15_000 }),
    dialog.getByText('Loading the provider directory failed').waitFor({ timeout: 15_000 }),
  ]).catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOT, '01-models.png'), fullPage: true })
  if (consoleErrors.length > 0) notes.push(`CONSOLE ${consoleErrors.join(' | ')}`)

  const body = await dialog.innerText()
  ok('Models heading', body.includes('Models'))
  ok(
    'intro mentions delegated CLIs / PATH',
    /PATH|Delegated CLI|HTTP providers/i.test(body),
    body.slice(0, 200),
  )

  ok('Seats heading', body.includes('Seats'), 'Seats card missing — agent-seats namespace not exposed?')
  ok('Boomer + Architect', body.includes('Boomer') && body.includes('Architect'))
  ok('Joey + Worker', body.includes('Joey') && body.includes('Worker'))
  ok('Flyer + Reviewer', body.includes('Flyer') && body.includes('Reviewer'))
  ok(
    'seat descriptions',
    body.includes('Does not implement')
      && body.includes('bounded piece')
      && body.includes('Does not rewrite'),
  )
  ok('seat unbound option', /Not assigned/i.test(body))

  const seatSelects = dialog.locator('select[aria-label*="Provider"], select[aria-label*="Model"]')
  const seatSelectCount = await seatSelects.count()
  ok('six seat dropdowns (3 seats × provider/model)', seatSelectCount >= 6, `found ${seatSelectCount}`)

  ok('Claude Code CLI row', /Claude Code CLI/.test(body))
  ok('Codex CLI row', /Codex CLI/.test(body))
  ok('Delegated tag present', body.includes('Delegated'))

  const claudeDelete = dialog.getByRole('button', { name: /Delete Claude Code CLI/ })
  const codexDelete = dialog.getByRole('button', { name: /Delete Codex CLI/ })
  ok('Claude Code CLI has no Delete', await claudeDelete.count() === 0)
  ok('Codex CLI has no Delete', await codexDelete.count() === 0)

  const pathStatus = /Found (codex|claude|grok|kimi) on PATH|(codex|claude|grok|kimi) is not on PATH|Uses (codex|claude|grok|kimi) on PATH/
  ok('PATH status on at least one CLI row', pathStatus.test(body), 'no Found/not-on-PATH tag')

  const claudeEdit = dialog.getByRole('button', { name: /Edit Claude Code CLI/ }).first()
  if (await claudeEdit.count() > 0) {
    await claudeEdit.click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOT, '02-claude-edit.png'), fullPage: true })
    const editor = await dialog.innerText()
    const binPh = await dialog.getByLabel('Executable').getAttribute('placeholder')
    ok('Claude executable placeholder is claude', binPh === 'claude', `placeholder=${binPh ?? '(none)'}`)
    const keyPh = await dialog.getByRole('textbox', { name: 'API key' }).getAttribute('placeholder')
    ok(
      'Claude API key is optional / login copy',
      keyPh !== 'Enter your API key',
      `placeholder=${keyPh ?? '(none)'}`,
    )
    ok('leave-blank PATH hint', /Leave blank to use the shipped command/i.test(editor))
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    if (await cancel.count() > 0) await cancel.click()
    await page.waitForTimeout(300)
  } else {
    ok('Claude Code CLI Edit button', false, 'not found')
  }

  const codexEdit = dialog.getByRole('button', { name: /Edit Codex CLI/ }).first()
  if (await codexEdit.count() > 0) {
    await codexEdit.click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOT, '03-codex-edit.png'), fullPage: true })
    const keyPh = await dialog.getByRole('textbox', { name: 'API key' }).getAttribute('placeholder')
    ok(
      'Codex API key is optional / login copy',
      keyPh !== 'Enter your API key',
      `placeholder=${keyPh ?? '(none)'}`,
    )
    const binPh = await dialog.getByLabel('Executable').getAttribute('placeholder')
    ok('Codex executable placeholder is codex', binPh === 'codex', `placeholder=${binPh ?? '(none)'}`)
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    if (await cancel.count() > 0) await cancel.click()
  } else {
    ok('Codex CLI Edit button', false, 'not found')
  }

  const customizeNav = page.getByRole('button', { name: 'Customize', exact: true })
  ok('Customize destination exists', await customizeNav.count() > 0)
  if (await customizeNav.count() > 0) {
    await customizeNav.click()
    const customize = page.getByRole('region', { name: 'Customize' })
    await customize.waitFor({ timeout: 10_000 })
    const presetsNav = customize.getByRole('button', { name: /Agent presets?/ })
    ok('Agent presets nav exists', await presetsNav.count() > 0)
    if (await presetsNav.count() > 0) await presetsNav.click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOT, '04-presets.png'), fullPage: true })
    const presets = await customize.innerText()
    ok('preset intro', /plugin composition/i.test(presets))
    ok('Standard mode', presets.includes('Standard mode'))
    ok('another built-in preset', presets.includes('Creator mode') || presets.includes('Code mode'))
  }

  await page.screenshot({ path: join(SHOT, '05-final.png'), fullPage: true })
} catch (error) {
  failures.push(String(error))
  notes.push(`FAIL  uncaught: ${error}`)
  await page.screenshot({ path: join(SHOT, '99-error.png'), fullPage: true }).catch(() => {})
} finally {
  await browser.close()
}

console.log(notes.join('\n'))
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED`)
if (failures.length > 0) {
  for (const item of failures) console.log(`  - ${item}`)
  process.exit(1)
}
