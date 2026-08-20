// Playwright coverage for the J-Space W0 bench report UI (#21): generate
// synthetic demo data, serve bench/ui, and drive Summary / Matrix / Charts /
// Trials in Chromium. No product harness and no API key.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { newEnglishPage, probeFreePort, REPO_ROOT, saveFailureShot } from './support.ts'

describe('web e2e: J-Space bench report UI', () => {
  let browser: Browser
  let page: Page
  let server: ChildProcess | undefined
  let baseUrl = ''

  beforeAll(async () => {
    execFileSync(process.execPath, [join(REPO_ROOT, 'bench/demo/generate.js')], { cwd: REPO_ROOT })
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'bench/report/build.js'), '--experiment', 'demo'],
      { cwd: REPO_ROOT },
    )
    expect(existsSync(join(REPO_ROOT, 'bench/ui/data.js'))).toBe(true)

    const port = await probeFreePort()
    baseUrl = `http://127.0.0.1:${String(port)}`
    server = spawn(
      process.execPath,
      [join(REPO_ROOT, 'bench/report/serve.js'), '--port', String(port)],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`bench report did not listen on ${baseUrl}`)) }, 15_000)
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes('bench report:')) {
          clearTimeout(timer)
          server?.stdout?.off('data', onData)
          resolve()
        }
      }
      server?.stdout?.on('data', onData)
      server?.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`bench report exited ${String(code)} before listen`))
      })
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(baseUrl, { waitUntil: 'load' })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    if (server?.pid !== undefined) {
      server.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (server?.pid !== undefined) server.kill('SIGKILL')
          resolve()
        }, 3_000)
        server?.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  })

  it('renders demo summary and every report view', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bench-report'))
    await expect.poll(() => page.locator('#demo-banner').isVisible(), { timeout: 10_000 }).toBe(true)
    expect(await page.locator('#demo-banner').textContent()).toMatch(/Synthetic demo data/)
    await expect.poll(() => page.getByRole('heading', { name: 'Summary', exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => page.getByRole('navigation', { name: 'Report views' }).count(), { timeout: 5_000 }).toBe(1)

    await page.getByRole('link', { name: 'Matrix', exact: true }).click()
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/#matrix/)
    await expect.poll(() => page.getByRole('heading', { name: 'Matrix', exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => page.getByText('chain-debug-resume', { exact: false }).count(), { timeout: 5_000 }).toBeGreaterThan(0)

    await page.getByRole('link', { name: 'Charts', exact: true }).click()
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/#charts/)
    await expect.poll(() => page.locator('svg').count(), { timeout: 5_000 }).toBeGreaterThan(0)

    await page.getByRole('link', { name: 'Trials', exact: true }).click()
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/#trials/)
    await expect.poll(() => page.getByRole('heading', { name: 'Trials', exact: true }).count(), { timeout: 5_000 }).toBe(1)

    await page.getByRole('link', { name: 'Summary', exact: true }).click()
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/#summary/)
    await expect.poll(() => page.getByRole('heading', { name: 'Summary', exact: true }).count(), { timeout: 5_000 }).toBe(1)
  }, 60_000)
})
