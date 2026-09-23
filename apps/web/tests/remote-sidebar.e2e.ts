// Keyless assembled-browser coverage for the sidebar remote group over the
// shipped Web bundles: the real `remoteControl/list` serves the seeded
// registry, a row click runs the real `remoteAdmin/inspect` through the
// hermetic ssh fixture (overlay), and the add/remove forms drive the
// gesture-gated registry mutations against the isolated harness home. The
// confirmed connect needs a live ssh forward and stays unit-covered.
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  asRemoteId, asRemotePort, asRemoteTarget, removeEntry, REGISTRY_VERSION, upsertEntry,
} from '@shres-code/shres-code-host-remote-control'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/remote-sidebar', import.meta.url))
const GROUP_EXPECTED = join(SNAPSHOT_DIR, 'group.expected.md')
const TRUST_MODAL_EXPECTED = join(SNAPSHOT_DIR, 'trust-modal.expected.md')
const SSH_FIXTURE = fileURLToPath(new URL('./remote-sidebar.ssh-fixture.sh', import.meta.url))
const MODE = webSnapshotMode()

/**
 * The scaffold chdirs into a temp workspace before Loader interpolation, so a
 * `!!js process.cwd()` overlay would resolve the fixture under that temp dir.
 * Bake the committed fixture's absolute path into a runtime overlay instead.
 */
async function writeRuntimeOverlay(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-sidebar-overlay-'))
  const path = join(dir, 'overlay.yml')
  await writeFile(path, [
    '- id: remote-admin',
    "  name: '@shres-code/shres-code-host-remote-control/admin'",
    '  config:',
    `    sshCommand: ${JSON.stringify(SSH_FIXTURE)}`,
    '',
  ].join('\n'))
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) }
}

describe('web e2e: sidebar remote group', () => {
  let overlay: Awaited<ReturnType<typeof writeRuntimeOverlay>>
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    overlay = await writeRuntimeOverlay()
    try {
      scaffold = await launchWebScaffold({ extraOverlayPath: overlay.path })
    } catch (error) {
      await overlay.dispose()
      throw error
    }
    // Seed the durable registry the row's initial read serves (the gateway
    // never caches, so a boot-time or post-boot write both work; seeding
    // before the page load keeps the first paint the golden's subject).
    for (const alias of ['lab', 'prod'] as const) {
      await upsertEntry(join(scaffold.harnessHome, 'remote', 'remotes.json'), {
        id: asRemoteId(alias),
        target: asRemoteTarget(`ci@${alias}.remote.example`),
        remotePort: asRemotePort(3080),
        version: REGISTRY_VERSION,
        fingerprint: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        lastConnectedAt: null,
      })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-slot="sidebar.remotes"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await overlay?.dispose()
  })

  it('renders the seeded registry, inspects through the ssh fixture, and curates rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-sidebar'))
    const group = page.locator('[data-slot="sidebar.remotes"]')

    // The seeded aliases render with their targets and the add affordance.
    await group.getByRole('button', { name: 'Connect prod' }).waitFor({ timeout: 15_000 })
    expect(await group.getByText('ci@prod.remote.example').count()).toBe(1)
    const groupSnapshot = await captureStableAria(page, '[data-slot="sidebar.remotes"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(GROUP_EXPECTED, groupSnapshot, MODE)

    // Row click inspects through the fixture: TOFU facts, matching version.
    await group.getByRole('button', { name: 'Connect prod' }).click()
    const dialog = page.getByRole('dialog', { name: 'Connect to prod' })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Trust and connect' }).waitFor({ timeout: 15_000 })
    expect(await dialog.getByLabel('0123456789abcdef').count()).toBe(1)
    const dialogSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(TRUST_MODAL_EXPECTED, dialogSnapshot, MODE)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'detached', timeout: 15_000 })

    // The add form writes through the gesture gate: the row appears.
    await group.getByRole('button', { name: 'Add remote…' }).click()
    await group.getByLabel('Alias').fill('staging')
    await group.getByLabel('Target (user@host)').fill('ci@staging.remote.example')
    await group.getByLabel('Daemon port (shres web on the remote, default 3080)', { exact: true }).fill('3080')
    await group.getByRole('button', { name: 'Save' }).click()
    await group.getByRole('button', { name: 'Connect staging' }).waitFor({ timeout: 15_000 })

    // Removal confirms first, then drops the row from the registry-backed list.
    // The kebab Menu portals menuitems outside the group slot.
    await group.getByRole('button', { name: 'Remote actions for staging' }).click()
    await page.getByRole('menuitem', { name: 'Remove' }).click()
    await group.getByRole('alertdialog', { name: 'Remove remote staging?' }).getByRole('button', { name: 'Remove' }).click()
    await expect.poll(() => group.getByRole('button', { name: 'Connect staging' }).count(), { timeout: 15_000 }).toBe(0)
    expect(await group.getByRole('button', { name: 'Connect lab' }).count()).toBe(1)
    // The durable file really dropped the alias (the gateway reads per call).
    expect(await removeEntry(join(scaffold.harnessHome, 'remote', 'remotes.json'), asRemoteId('staging'))).toBe(false)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['group.expected.md', 'trust-modal.expected.md'])
  })
})
