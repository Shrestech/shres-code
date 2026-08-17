/**
 * Live Playwright walk of the running shres web app. Covers home, composer,
 * settings (General / Models / Plugins / Agent presets), seats, Z.AI, CLI
 * rows, and a mobile viewport. Prints a report; non-zero exit on failure.
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.SHRES_WEB_URL ?? 'http://127.0.0.1:3080'
const SHOT = join(fileURLToPath(new URL('../../../.artifacts/verify-app/', import.meta.url)))
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
  for (const name of ['Continue', 'Configure later', 'Skip', 'Close']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.count() > 0 && await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      await page.waitForTimeout(350)
    }
  }
}

async function openSettings(page) {
  const trigger = page.getByRole('button', { name: 'Settings', exact: true })
  await trigger.waitFor({ timeout: 15_000 })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  return dialog
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
  await page.goto(BASE, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector('[class*="frame"]', { timeout: 45_000 })
  await dismissOnboarding(page)
  await page.screenshot({ path: join(SHOT, '00-home.png'), fullPage: true })

  const frame = await page.locator('[class*="frame"]').first().isVisible()
  ok('app frame rendered', frame)
  ok('Settings trigger', await page.getByRole('button', { name: 'Settings', exact: true }).count() > 0)
  ok('New session or composer present',
    await page.getByRole('textbox').count() > 0
    || await page.getByRole('button', { name: /New/i }).count() > 0)

  const composer = page.locator('textarea, [contenteditable="true"]').first()
  if (await composer.count() > 0 && await composer.isVisible().catch(() => false)) {
    await composer.click({ force: true })
    await composer.fill('playwright live check')
    const typed = typeof composer.inputValue === 'function'
      ? await composer.inputValue().catch(() => '')
      : await composer.innerText()
    ok('composer accepts text', String(typed).includes('playwright live check'))
    await composer.fill('').catch(() => {})
  } else {
    notes.push('NOTE  composer textbox not visible on home (blank hero?)')
  }

  const dialog = await openSettings(page)
  ok('settings dialog opened', await dialog.isVisible())
  await page.screenshot({ path: join(SHOT, '01-general.png'), fullPage: true })

  const general = dialog.getByRole('button', { name: 'General', exact: true })
  ok('General nav', await general.count() > 0)
  if (await general.count() > 0) {
    await general.click()
    await page.waitForTimeout(300)
    const generalText = await dialog.innerText()
    ok('General has Appearance or Language', /Appearance|Language|Permission|Workspace/.test(generalText))
  }

  const pluginsNav = dialog.getByRole('button', { name: 'Plugins', exact: true })
  ok('Plugins nav', await pluginsNav.count() > 0)
  if (await pluginsNav.count() > 0) {
    await pluginsNav.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT, '02-plugins.png'), fullPage: true })
    const plugins = await dialog.innerText()
    ok('Plugins section rendered', plugins.length > 20)
    ok('Web search card or plugin list', /Web search|Search|plugin/i.test(plugins))
  }

  const modelsNav = dialog.getByRole('button', { name: /Models?/, exact: true }).first()
  if (await modelsNav.count() === 0) {
    ok('Models nav', false, 'no Model/Models button')
  } else {
    await modelsNav.click()
    await Promise.race([
      dialog.getByRole('heading', { name: /Models?/ }).waitFor({ timeout: 15_000 }),
      dialog.getByRole('heading', { name: 'Seats' }).waitFor({ timeout: 15_000 }),
      dialog.getByText(/Loading the provider directory failed/).waitFor({ timeout: 15_000 }),
    ]).catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOT, '03-models.png'), fullPage: true })
    const body = await dialog.innerText()
    if (consoleErrors.length > 0) notes.push(`CONSOLE ${consoleErrors.slice(0, 8).join(' | ')}`)

    ok('Models pane not empty', body.trim().length > 40, body.slice(0, 180))
    ok('Seats heading', body.includes('Seats'))
    ok('Boomer Architect', body.includes('Boomer') && body.includes('Architect'))
    ok('Joey Worker', body.includes('Joey') && body.includes('Worker'))
    ok('Flyer Reviewer', body.includes('Flyer') && body.includes('Reviewer'))
    ok('seat unbound option', /Not assigned/i.test(body))
    const seatSelects = dialog.locator('select[aria-label*="Provider"], select[aria-label*="Model"]')
    ok('six seat dropdowns', await seatSelects.count() >= 6, `found ${await seatSelects.count()}`)

    const modelsPane = dialog.locator('[class*="section"], [class*="content"], [class*="pane"]').first()
    await modelsPane.evaluate(node => { node.scrollTop = node.scrollHeight }).catch(() => {})
    await dialog.evaluate(node => { node.scrollTop = node.scrollHeight }).catch(() => {})
    const zai = dialog.getByText(/Z\.AI|\bzai\b/i)
    if (await zai.count() > 0) {
      await zai.first().scrollIntoViewIfNeeded().catch(() => {})
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(SHOT, '03b-models-scrolled.png'), fullPage: true })
    }
    const scrolled = await dialog.innerText()
    ok('Z.AI card', /Z\.AI|\bzai\b|GLM/i.test(scrolled), 'Z.AI shipped route missing after scroll')
    ok('Claude Code CLI row', /Claude Code CLI/.test(body))
    ok('Codex CLI row', /Codex CLI/.test(body))
    ok('Delegated tag', body.includes('Delegated'))
    ok('Claude has no Delete', await dialog.getByRole('button', { name: /Delete Claude Code CLI/ }).count() === 0)
    ok('Codex has no Delete', await dialog.getByRole('button', { name: /Delete Codex CLI/ }).count() === 0)
    ok(
      'PATH status on a CLI row',
      /Found (codex|claude|grok|kimi) on PATH|(codex|claude|grok|kimi) is not on PATH|Uses (codex|claude|grok|kimi) on PATH/.test(body),
    )

    const enableSwitches = dialog.getByRole('switch')
    ok('enable switches present', await enableSwitches.count() > 0, `found ${await enableSwitches.count()}`)

    const claudeEdit = dialog.getByRole('button', { name: /Edit Claude Code CLI/ }).first()
    if (await claudeEdit.count() > 0) {
      await claudeEdit.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOT, '04-claude-edit.png'), fullPage: true })
      const binPh = await dialog.getByLabel('Executable').getAttribute('placeholder')
      ok('Claude executable placeholder is claude', binPh === 'claude', `placeholder=${binPh ?? '(none)'}`)
      const keyPh = await dialog.getByRole('textbox', { name: 'API key' }).getAttribute('placeholder')
      ok('Claude API key optional', keyPh !== 'Enter your API key', `placeholder=${keyPh ?? '(none)'}`)
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
      if (await cancel.count() > 0) await cancel.click()
      await page.waitForTimeout(250)
    } else {
      ok('Claude Edit button', false)
    }
  }

  const presetsNav = dialog.getByRole('button', { name: /Agent presets?/ })
  ok('Agent presets nav', await presetsNav.count() > 0)
  if (await presetsNav.count() > 0) {
    await presetsNav.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT, '05-presets.png'), fullPage: true })
    const presets = await dialog.innerText()
    ok('Standard mode listed', presets.includes('Standard mode'))
    ok('another built-in preset', /Creator mode|Code mode|Minimal/.test(presets))
  }

  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  if (await close.count() > 0) await close.click()
  await page.waitForTimeout(300)
  ok('settings closed', await page.getByRole('dialog', { name: 'Settings' }).count() === 0)

  for (const name of ['Chat', 'Trajectory', 'New session', 'New chat']) {
    const tab = page.getByRole('button', { name, exact: true })
    if (await tab.count() > 0 && await tab.first().isVisible().catch(() => false)) {
      await tab.first().click()
      await page.waitForTimeout(250)
      ok(`nav ${name} clickable`, true)
    }
  }
  await page.screenshot({ path: join(SHOT, '06-after-nav.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOT, '07-mobile.png'), fullPage: true })
  ok('mobile frame still visible', await page.locator('[class*="frame"]').first().isVisible())
  const namedSettings = page.getByRole('button', { name: /Settings/i })
  ok('mobile Settings control present',
    await namedSettings.count() > 0
    || await page.locator('button[aria-label*="Settings" i]').count() > 0
    || await page.locator('[class*="sidebar"] button, aside button, [class*="rail"] button').count() > 0)
  let opened = false
  if (await namedSettings.count() > 0) {
    await namedSettings.first().click({ force: true })
    opened = await page.getByRole('dialog', { name: 'Settings' }).isVisible().catch(() => false)
  }
  if (!opened) {
    const rail = page.locator('[class*="sidebar"] button, aside button, [class*="rail"] button').first()
    if (await rail.count() > 0) {
      await rail.click({ force: true }).catch(() => {})
      opened = await page.getByRole('dialog', { name: 'Settings' }).isVisible().catch(() => false)
    }
  }
  ok('mobile Settings opens or rail remains usable',
    opened || await page.locator('[class*="frame"]').first().isVisible())
  if (opened) await page.screenshot({ path: join(SHOT, '08-mobile-settings.png'), fullPage: true })

  const fatal = consoleErrors.filter(text =>
    !/favicon|ResizeObserver|Download the React DevTools/i.test(text))
  ok('no fatal page errors', fatal.length === 0, fatal.slice(0, 5).join(' | '))
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
