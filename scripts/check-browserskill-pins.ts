/**
 * Compare the pinned BrowserSkill release with the recorded measurement, and
 * optionally report how far the pins trail upstream.
 *
 * Offline (default) is deterministic and gates a pull request: every pinned
 * constant must equal the evidence entry for its version pair. `--remote`
 * prints a drift report and always exits 0, because an upstream outage must
 * never fail a build; a bump is its own change carrying fresh evidence.
 * @module scripts/check-browserskill-pins
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = join(import.meta.dirname, '..')
const MANIFEST = 'packages/browser/browserskill/src/runtime/manifest.ts'
const EVIDENCE = 'scripts/browserskill-pin-evidence.json'
const LATEST = 'https://api.github.com/repos/Tencent/BrowserSkill/releases?per_page=20'

interface EvidenceEntry {
  bskVersion: string
  extensionVersion: string
  platform: string
  bsk: { assetName: string; archiveSha256: string; binarySha256: string }
  extension: { assetName: string; archiveSha256: string; treeSha256: string; permissions: readonly string[] }
}

interface Evidence {
  schemaVersion: 1
  entries: EvidenceEntry[]
}

/** One pinned constant as the manifest declares it. */
function pinned(source: string, name: string): string {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source)
  if (match?.[1] === undefined) throw new Error(`${MANIFEST}: no string constant ${name}`)
  return match[1]
}

/** One pinned constant inside the platform-pin object. */
function pinnedField(source: string, field: string): string {
  const match = new RegExp(`\\s${field}: '([0-9a-f]{64})'`).exec(source)
  if (match?.[1] === undefined) throw new Error(`${MANIFEST}: no ${field} pin`)
  return match[1]
}

/** The permission list as the manifest declares it. */
function pinnedPermissions(source: string): string[] {
  const block = /export const EXTENSION_PERMISSIONS: readonly string\[\] = \[([\s\S]*?)\]/.exec(source)
  if (block?.[1] === undefined) throw new Error(`${MANIFEST}: no EXTENSION_PERMISSIONS`)
  return [...block[1].matchAll(/'([^']+)'/g)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

/**
 * Verify the pins against the committed evidence.
 * @returns the mismatches found, empty when the pins and evidence agree.
 */
export function verifyPins(manifestSource: string, evidence: Evidence): string[] {
  const bskVersion = pinned(manifestSource, 'BSK_VERSION')
  const extensionVersion = pinned(manifestSource, 'EXTENSION_VERSION')
  const entry = evidence.entries.find(candidate => candidate.bskVersion === bskVersion && candidate.extensionVersion === extensionVersion)
  if (entry === undefined) return [`no evidence entry for bsk ${bskVersion} / extension ${extensionVersion}`]
  const problems: string[] = []
  const expect = (label: string, actual: string, recorded: string): void => {
    if (actual !== recorded) problems.push(`${label}: manifest ${actual} != evidence ${recorded}`)
  }
  expect('bsk archive', pinnedField(manifestSource, 'archiveSha256'), entry.bsk.archiveSha256)
  expect('bsk binary', pinnedField(manifestSource, 'binarySha256'), entry.bsk.binarySha256)
  const extension = /export const EXTENSION_ASSET: PinnedArtifact = \{([\s\S]*?)\}/.exec(manifestSource)?.[1]
  if (extension === undefined) problems.push('manifest declares no EXTENSION_ASSET')
  else {
    expect('extension archive', /sha256: '([0-9a-f]{64})'/.exec(extension)?.[1] ?? '', entry.extension.archiveSha256)
    expect('extension asset name', /\/([^/']+)'/.exec(extension)?.[1] ?? '', entry.extension.assetName)
  }
  expect('extension tree', pinned(manifestSource, 'EXTENSION_TREE_SHA256'), entry.extension.treeSha256)
  expect('bsk asset name', pinned(manifestSource, 'BSK_DARWIN_ARM64_ASSET'), entry.bsk.assetName)
  const permissions = pinnedPermissions(manifestSource)
  if (permissions.length !== entry.extension.permissions.length || permissions.some(name => !entry.extension.permissions.includes(name))) {
    problems.push(`extension permissions: manifest [${permissions.join(', ')}] != evidence [${entry.extension.permissions.join(', ')}]`)
  }
  return problems
}

interface ReleaseTag {
  tag_name?: unknown
  published_at?: unknown
}

/**
 * Compare the pins with the newest upstream release tags.
 * @returns the drift lines and the newest CLI and extension tags found.
 */
export async function reportDrift(
  fetchImpl: typeof fetch,
  evidence: Evidence,
): Promise<{ lines: string[]; latest: { cli: string; extension: string } }> {
  const response = await fetchImpl(LATEST, { headers: { accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`upstream releases answered ${response.status}`)
  const tags = (await response.json() as ReleaseTag[])
    .flatMap(release => typeof release.tag_name === 'string' ? [release.tag_name] : [])
  const newest = (prefix: string): string => tags.find(tag => tag.startsWith(prefix)) ?? ''
  const cli = newest('cli-v')
  const extension = newest('ext-v')
  const entry = evidence.entries.at(-1)
  const lines = [
    `pinned: bsk ${entry?.bskVersion ?? 'unknown'} / extension ${entry?.extensionVersion ?? 'unknown'}`,
    `upstream: bsk ${cli.replace('cli-v', '') || 'unknown'} / extension ${extension.replace('ext-v', '') || 'unknown'}`,
  ]
  if (cli !== '' && cli !== `cli-v${entry?.bskVersion}`) lines.push(`behind: the CLI pin trails ${cli}; follow docs/cookbook/browserskill-pin-bump.md`)
  if (extension !== '' && extension !== `ext-v${entry?.extensionVersion}`) lines.push(`behind: the extension pin trails ${extension}; follow docs/cookbook/browserskill-pin-bump.md`)
  if (lines.length === 2) lines.push('current: the pins name the newest upstream release pair')
  return { lines, latest: { cli, extension } }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false } } })
  const manifestSource = readFileSync(join(ROOT, MANIFEST), 'utf8')
  const evidence = JSON.parse(readFileSync(join(ROOT, EVIDENCE), 'utf8')) as Evidence
  const problems = verifyPins(manifestSource, evidence)
  if (problems.length > 0) {
    console.error(`check-browserskill-pins: ${problems.length} pin problem(s):\n` + problems.map(problem => '  ' + problem).join('\n'))
    process.exitCode = 1
    return
  }
  console.log(`check-browserskill-pins: pins match ${EVIDENCE} for ${evidence.entries.at(-1)?.bskVersion ?? 'unknown'}`)
  if (!values.remote) return
  try {
    const { lines } = await reportDrift(fetch, evidence)
    for (const line of lines) console.log(line)
  } catch (error) {
    // An upstream outage is not a build failure: the report is advisory.
    console.log(`upstream unreachable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
