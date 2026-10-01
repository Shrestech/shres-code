#!/usr/bin/env tsx
/**
 * Report drift between the local Laya gateway's pins and their upstreams.
 *
 * Pins come from `python/laya-gateway`: the exact `laya-mlx` requirement in
 * `pyproject.toml` and every checkpoint manifest under `manifests/`. The
 * report compares them with the latest `laya-mlx` on PyPI, each pinned
 * Hugging Face repository's head, and the heads of the upstream source
 * repositories. It never changes a pin and always exits 0; a bump is its own
 * change carrying a fresh fidelity check and offline replay.
 *
 * Usage: `pnpm run check:laya-upstream`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const GATEWAY = resolve(root, 'python/laya-gateway')

/** Upstream source repositories whose heads the report shows. */
export const UPSTREAM_SOURCES = ['mizorewww/laya-mlx', 'NandhaKishorM/laya'] as const

/** Pins read from the gateway project. */
export interface LayaPins {
  /** Exact `laya-mlx` version required by `pyproject.toml`. */
  readonly layaMlx: string
  /** Pinned checkpoints, `repo` and 40-character `revision`. */
  readonly checkpoints: readonly { readonly repo: string; readonly revision: string }[]
}

/** Upstream facts fetched for one report. */
export interface UpstreamFacts {
  /** Latest `laya-mlx` version on PyPI, or an error message. */
  readonly layaMlxLatest: string
  /** Head sha and modification date per pinned Hugging Face repository. */
  readonly hubHeads: Readonly<Record<string, { readonly sha: string; readonly modified: string } | string>>
  /** Head sha and commit date per upstream source repository. */
  readonly sourceHeads: Readonly<Record<string, { readonly sha: string; readonly date: string } | string>>
}

/**
 * Read the gateway project's pins.
 * @param pyproject - `pyproject.toml` text.
 * @param manifests - checkpoint manifest texts.
 * @returns the exact `laya-mlx` version and the pinned checkpoints.
 * @throws Error when `laya-mlx` is not pinned with `==`.
 */
export function readPins(pyproject: string, manifests: readonly string[]): LayaPins {
  const layaMlx = /"laya-mlx==([^";\s]+)/.exec(pyproject)?.[1]
  if (layaMlx === undefined) throw new Error('check-laya-upstream: python/laya-gateway/pyproject.toml does not pin laya-mlx with ==')
  const checkpoints = manifests.map((text) => {
    const parsed = JSON.parse(text) as { repo: string; revision: string }
    return { repo: parsed.repo, revision: parsed.revision }
  })
  return { layaMlx, checkpoints }
}

/**
 * Render the drift report.
 * @param pins - pins read from the gateway project.
 * @param facts - fetched upstream facts.
 * @returns report lines; each drifted pin is marked `DRIFT`.
 */
export function renderReport(pins: LayaPins, facts: UpstreamFacts): string[] {
  const lines = ['Laya upstream drift report', '']
  const pypiDrift = facts.layaMlxLatest !== pins.layaMlx
  lines.push(`laya-mlx (PyPI): pinned ${pins.layaMlx}, latest ${facts.layaMlxLatest}${pypiDrift ? '  DRIFT' : ''}`)
  for (const checkpoint of pins.checkpoints) {
    const head = facts.hubHeads[checkpoint.repo]
    if (head === undefined || typeof head === 'string') {
      lines.push(`${checkpoint.repo} (Hugging Face): pinned ${checkpoint.revision.slice(0, 12)}, head unknown (${head ?? 'not fetched'})`)
      continue
    }
    const drift = head.sha !== checkpoint.revision
    lines.push(`${checkpoint.repo} (Hugging Face): pinned ${checkpoint.revision.slice(0, 12)}, head ${head.sha.slice(0, 12)} (${head.modified.slice(0, 10)})${drift ? '  DRIFT' : ''}`)
  }
  for (const source of UPSTREAM_SOURCES) {
    const head = facts.sourceHeads[source]
    lines.push(typeof head === 'object'
      ? `${source} (GitHub): head ${head.sha.slice(0, 12)} (${head.date.slice(0, 10)})`
      : `${source} (GitHub): head unknown (${head ?? 'not fetched'})`)
  }
  lines.push('', 'A pin bump is its own change with a fresh laya-mlx fidelity check and offline routing replay.')
  return lines
}

/**
 * Fetch upstream facts.
 * @param pins - pins whose repositories are queried.
 * @param fetchJson - JSON GET used for every request.
 * @returns the facts; a failed request becomes its error message.
 */
export async function fetchFacts(pins: LayaPins, fetchJson: (url: string) => Promise<unknown>): Promise<UpstreamFacts> {
  const attempt = async <T>(read: () => Promise<T>): Promise<T | string> => {
    try {
      return await read()
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const layaMlxLatest = await attempt(async () => {
    const body = await fetchJson('https://pypi.org/pypi/laya-mlx/json') as { info: { version: string } }
    return body.info.version
  })
  const hubHeads: Record<string, { sha: string; modified: string } | string> = {}
  for (const { repo } of pins.checkpoints) {
    hubHeads[repo] = await attempt(async () => {
      const body = await fetchJson(`https://huggingface.co/api/models/${repo}`) as { sha: string; lastModified: string }
      return { sha: body.sha, modified: body.lastModified }
    })
  }
  const sourceHeads: Record<string, { sha: string; date: string } | string> = {}
  for (const source of UPSTREAM_SOURCES) {
    sourceHeads[source] = await attempt(async () => {
      const body = await fetchJson(`https://api.github.com/repos/${source}/commits?per_page=1`) as Array<{ sha: string; commit: { committer: { date: string } } }>
      const head = body[0]
      if (head === undefined) throw new Error('no commits returned')
      return { sha: head.sha, date: head.commit.committer.date }
    })
  }
  return { layaMlxLatest, hubHeads, sourceHeads }
}

/** JSON GET with a bounded deadline. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

/** Read the pins, fetch the facts, and print the report. */
async function main(): Promise<void> {
  const manifestDir = resolve(GATEWAY, 'manifests')
  const pins = readPins(
    readFileSync(resolve(GATEWAY, 'pyproject.toml'), 'utf8'),
    readdirSync(manifestDir).filter(name => name.endsWith('.json')).sort().map(name => readFileSync(resolve(manifestDir, name), 'utf8')),
  )
  console.log(renderReport(pins, await fetchFacts(pins, fetchJson)).join('\n'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
