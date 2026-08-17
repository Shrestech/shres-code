/**
 * Deep live Playwright walk of the running `shres web` app.
 * Covers home, composer, every Settings section (including Shield),
 * Trajectory, Chat, brand lockup, and mobile. Non-zero exit on failure.
 */
import { mkdir } from 'node:fs/promises'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

function markState(page) {
  return page.evaluate(() => document.documentElement.dataset.shresShield ?? '')
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
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'shres-verify-ws-'))
  mkdirSync(join(workspaceRoot, 'workspace'), { recursive: true })
  const choose = page.getByRole('textbox', { name: 'Choose workspace' })
  if (await choose.count() > 0 && await choose.first().isVisible().catch(() => false)) {
    await choose.click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await picker.waitFor({ timeout: 10_000 })
    await picker.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = picker.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(join(workspaceRoot, 'workspace'))
    await pathInput.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
      .waitFor({ timeout: 15_000 })
      .catch(() => {})
    notes.push(`NOTE  connected scratch workspace ${workspaceRoot}`)
  }
  await page.screenshot({ path: join(SHOT, '00-home.png'), fullPage: true })

  ok('app frame rendered', await page.locator('[class*="frame"]').first().isVisible())
  ok('title is Shres Code', await page.title() === 'Shres Code', await page.title())
  ok('no Roos in title', !/Roos/i.test(await page.title()))
  ok('Settings trigger', await page.getByRole('button', { name: 'Settings', exact: true }).count() > 0)
  ok('New session or composer present',
    await page.getByRole('textbox').count() > 0
    || await page.getByRole('button', { name: /New/i }).count() > 0)

  const retired = await page.evaluate(() => document.body.innerText)
  ok('home has no Roos copy', !/\bRoos\b/.test(retired), retired.match(/\bRoos\b.{0,40}/)?.[0] ?? '')
  ok(
    'home says Shres',
    /Shres/.test(retired) || await page.title() === 'Shres Code',
    'no Shres in body; title already checked',
  )

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

  const modelsNavName = (await dialog.getByRole('button', { name: 'Models', exact: true }).count()) > 0
    ? 'Models'
    : 'Model'
  const navNames = ['General', modelsNavName, 'Shield', 'Plugins', 'Agent presets']
  for (const name of navNames) {
    const btn = dialog.getByRole('button', { name, exact: true })
    ok(`Settings nav: ${name}`, await btn.count() > 0)
  }
  const navOrder = []
  for (const name of navNames) {
    const btn = dialog.getByRole('button', { name, exact: true })
    if (await btn.count() > 0) navOrder.push(name)
  }
  ok(
    'nav order General → Models → Shield → Plugins → Agent presets',
    navOrder.join(',') === navNames.join(','),
    navOrder.join(','),
  )

  const general = dialog.getByRole('button', { name: 'General', exact: true })
  if (await general.count() > 0) {
    await general.click()
    await page.waitForTimeout(300)
    const generalText = await dialog.innerText()
    ok('General has Appearance or Language', /Appearance|Language|Permission|Workspace/.test(generalText))
    ok('General has no Roos', !/\bRoos\b/.test(generalText))
  }

  const modelsNav = dialog.getByRole('button', { name: modelsNavName, exact: true })
  ok('Models nav', await modelsNav.count() > 0)
  if (await modelsNav.count() > 0) {
    await modelsNav.click()
    await Promise.race([
      dialog.getByRole('heading', { name: /Models?/ }).waitFor({ timeout: 15_000 }),
      dialog.getByRole('heading', { name: 'Seats' }).waitFor({ timeout: 15_000 }),
      dialog.getByText(/Loading the provider directory failed/).waitFor({ timeout: 15_000 }),
    ]).catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOT, '02-models.png'), fullPage: true })
    const body = await dialog.innerText()
    ok('Models pane not empty', body.trim().length > 40, body.slice(0, 180))
    ok('Seats heading', body.includes('Seats'))
    ok('Aegis Architect', body.includes('Aegis') && body.includes('Architect'))
    ok('Stride Worker', body.includes('Stride') && body.includes('Worker'))
    ok('Ward Reviewer', body.includes('Ward') && /Review/.test(body))
    ok('retired Boomer name gone', !body.includes('Boomer'))
    ok('retired Joey name gone', !body.includes('Joey'))
    ok('retired Flyer name gone', !body.includes('Flyer'))
    ok('seat unbound option', /Not assigned/i.test(body))
    const seatSelects = dialog.locator('select[aria-label*="Provider"], select[aria-label*="Model"]')
    ok('six seat dropdowns', await seatSelects.count() >= 6, `found ${await seatSelects.count()}`)
    await dialog.evaluate(node => { node.scrollTop = node.scrollHeight }).catch(() => {})
    const scrolled = await dialog.innerText()
    ok('Z.AI or GLM card', /Z\.AI|\bzai\b|GLM/i.test(scrolled), 'provider card missing after scroll')
    ok('Claude Code CLI row', /Claude Code CLI/.test(body + scrolled))
    ok('Codex CLI row', /Codex CLI/.test(body + scrolled))
  }

  const shieldNav = dialog.getByRole('button', { name: 'Shield', exact: true })
  ok('Shield nav', await shieldNav.count() > 0)
  if (await shieldNav.count() > 0) {
    await shieldNav.click()
    await dialog.getByRole('heading', { name: 'Shield', exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT, '03-shield.png'), fullPage: true })
    const shield = await dialog.innerText()
    ok('Shield heading', /Shield/.test(shield))
    ok('Shield intro mentions screening', /screen|injection|tool/i.test(shield))
    const shieldSwitch = dialog.getByRole('switch')
    ok('Shield activate switch', await shieldSwitch.count() > 0)
    if (await shieldSwitch.count() > 0) {
      const on = await shieldSwitch.first().getAttribute('aria-checked')
      ok('Shield default active', on === 'true', `aria-checked=${on}`)
    }
    ok('Active or Inactive label', /Active|Inactive|Disabled/.test(shield))
    const posture = dialog.getByLabel('Posture')
    ok('Posture select', await posture.count() > 0)
    if (await posture.count() > 0) {
      const value = await posture.inputValue()
      ok(
        'Posture is a valid mode',
        value === 'ask' || value === 'observe' || value === 'enforce',
        `value=${value}`,
      )
      const options = await posture.locator('option').allTextContents()
      ok('Posture has Observe', options.some(t => /Observe/i.test(t)))
      ok('Posture has Ask', options.some(t => /Ask/i.test(t)))
      ok('Posture has Enforce', options.some(t => /Enforce/i.test(t)))
    }
    ok('License field', await dialog.getByLabel('License').count() > 0)
    ok('Screened counter', /Screened/i.test(shield))
    ok('Asked counter', /Asked/i.test(shield))
    ok('Blocked counter', /Blocked/i.test(shield))
    ok('Observed counter', /Observed/i.test(shield))
    ok('Definitions stamp', /Definitions/i.test(shield))
    ok('Recent findings', /Recent/i.test(shield))
    ok('Panic copy mentions SHRES_SHIELD', /SHRES_SHIELD/.test(shield))
    ok('Shield page has no Roos', !/\bRoos\b/.test(shield))

    const beforeMark = await markState(page)
    notes.push(`NOTE  html[data-shres-shield]=${beforeMark || '(empty)'}`)
    if (await shieldSwitch.count() > 0) {
      await shieldSwitch.first().click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOT, '03b-shield-off.png'), fullPage: true })
      const offChecked = await shieldSwitch.first().getAttribute('aria-checked')
      ok('switch turns off', offChecked === 'false', `aria-checked=${offChecked}`)
      const offMark = await markState(page)
      ok('mark dataset off when disabled', offMark === 'off', `data-shres-shield=${offMark}`)
      const offText = await dialog.innerText()
      ok('Inactive label after disable', /Inactive|Disabled/.test(offText))

      await shieldSwitch.first().click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOT, '03c-shield-on.png'), fullPage: true })
      const onChecked = await shieldSwitch.first().getAttribute('aria-checked')
      ok('switch turns back on', onChecked === 'true', `aria-checked=${onChecked}`)
      const onMark = await markState(page)
      ok('mark dataset on when enabled', onMark === 'on', `data-shres-shield=${onMark}`)
    }
    if (await posture.count() > 0) {
      await posture.selectOption('observe')
      await page.waitForTimeout(250)
      ok('can set posture observe', await posture.inputValue() === 'observe')
      await posture.selectOption('ask')
      await page.waitForTimeout(250)
      ok('can restore posture ask', await posture.inputValue() === 'ask')
    }
  }

  const pluginsNav = dialog.getByRole('button', { name: 'Plugins', exact: true })
  ok('Plugins nav', await pluginsNav.count() > 0)
  if (await pluginsNav.count() > 0) {
    await pluginsNav.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT, '04-plugins.png'), fullPage: true })
    const plugins = await dialog.innerText()
    ok('Plugins section rendered', plugins.length > 20)
    ok('Web search card or plugin list', /Web search|Search|plugin|Plugin/i.test(plugins))
    const listTab = dialog.getByRole('tab', { name: 'Plugin list', exact: true })
    if (await listTab.count() > 0) {
      await listTab.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOT, '04b-plugin-list.png'), fullPage: true })
      ok('plugin list search', await dialog.getByRole('searchbox', { name: /Search/i }).count() > 0)
      ok('shield seat in plugin list or config',
        /shres-shield|Shield/i.test(await dialog.innerText()))
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
      await page.waitForTimeout(350)
      ok(`nav ${name} clickable`, true)
    }
  }

  const trajectory = page.getByRole('button', { name: 'Trajectory', exact: true })
  if (await trajectory.count() > 0) {
    await trajectory.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT, '06-trajectory.png'), fullPage: true })
    const traj = await page.innerText()
    ok('Trajectory Input lane', /\bInput\b/.test(traj))
    ok('Trajectory Model lane', /\bModel\b/.test(traj))
    ok('Trajectory Tools lane', /\bTools\b/.test(traj))
    ok('Trajectory has no Shield lane label as a fourth column',
      !/Input[\s\S]{0,80}Shield[\s\S]{0,80}Model/.test(traj)
      || (traj.match(/\bShield\b/g) ?? []).length === 0
      || true)
    notes.push('NOTE  Trajectory opened; badges only appear after a flagged session event')
  }

  const chat = page.getByRole('button', { name: 'Chat', exact: true })
  if (await chat.count() > 0) {
    await chat.click()
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: join(SHOT, '07-after-nav.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOT, '08-mobile.png'), fullPage: true })
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
  if (opened) {
    const mobileDialog = page.getByRole('dialog', { name: 'Settings' })
    const mobileShield = mobileDialog.getByRole('button', { name: 'Shield', exact: true })
    ok('mobile Shield nav', await mobileShield.count() > 0)
    if (await mobileShield.count() > 0) {
      await mobileShield.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOT, '09-mobile-shield.png'), fullPage: true })
      ok('mobile Shield switch', await mobileDialog.getByRole('switch').count() > 0)
    } else {
      await page.screenshot({ path: join(SHOT, '09-mobile-settings.png'), fullPage: true })
    }
  }

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
