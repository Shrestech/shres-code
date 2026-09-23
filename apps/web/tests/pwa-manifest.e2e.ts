import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Shres Code',
    short_name: 'Shres',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg?v=shres4',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships a favicon with contrasting light and dark color schemes', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  expect(favicon).toMatch(/\.letter\s*{\s*fill:\s*#ffffff/)
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*\.girl\s*{\s*fill:\s*#60a5fa/)
  expect(favicon).toMatch(/\.shield\s*{\s*fill:\s*#4ade80/)
  expect(favicon).toMatch(/\.letter\s*{\s*fill:\s*#0f172a/)
})
