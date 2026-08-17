/**
 * Reject tracked leftovers of retired product identities (DeepSeek Harness /
 * DSH and Roos Code) outside the keep-list (LICENSE, NOTICE, archived Agent
 * Notes, the historical rebrand notes, the rebrand/rescope/zh-purge scripts
 * that must still mention old tokens as find-strings, and vendored upstream
 * README/LICENSE). Also rejects the slash-stripped catalog slug
 * `deepseek-aidsh` and leftover mermaid node ids (`pkg_*_dsh_*`, `pkg_*_roos_*`).
 * Hyphenated `roos-code` / `shres-code` is not a slash-stripped slug.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const FORBIDDEN = [
  { id: 'scoped-dsh', pattern: /@deepseek-ai\/dsh/ },
  { id: 'env-prefix', pattern: /\bDSH_[A-Z]/ },
  { id: 'home-dir', pattern: /~\/\.dsh\b/ },
  { id: 'python-sdk', pattern: /deepseek-harness-sdk/ },
  { id: 'product-prose', pattern: /DeepSeek Harness/ },
  { id: 'product-vendor', pattern: /DeepSeek AI/ },
  { id: 'slash-stripped-slug', pattern: /deepseek-aidsh/ },
  { id: 'mermaid-dsh-node', pattern: /pkg_[A-Za-z0-9_]*_dsh_[A-Za-z0-9_]+/ },
  { id: 'scoped-roos', pattern: /@roos-code/ },
  { id: 'env-prefix-roos', pattern: /\bROOS_[A-Z]/ },
  { id: 'home-dir-roos', pattern: /~\/\.roos\b/ },
  { id: 'python-sdk-roos', pattern: /roos-code-sdk/ },
  { id: 'product-prose-roos', pattern: /Roos Code/ },
  { id: 'mermaid-roos-node', pattern: /pkg_[A-Za-z0-9_]*_roos_[A-Za-z0-9_]+/ },
] as const

/** One tracked leftover of a retired brand token. */
export interface LegacyBrandReference {
  /** Repository-relative file path. */
  file: string
  /** One-based source line. */
  line: number
  /** Which keep-list token was found. */
  id: string
}

function keepListed(file: string): boolean {
  if (file === 'LICENSE' || file === 'NOTICE') return true
  if (file.startsWith('.agents/notes/archived/')) return true
  if (file === '.agents/notes/implemented/process/2026-08-16-rebrand-to-roos-code.md') return true
  if (file === '.agents/notes/implemented/process/2026-08-17-rebrand-to-shres-code.md') return true
  if (file === 'scripts/rebrand.ts' || file === 'scripts/rebrand.spec.ts') return true
  if (file === 'scripts/rescope-vendor.ts' || file === 'scripts/rescope-vendor.spec.ts') return true
  if (file === 'scripts/verify-no-legacy-brand.ts') return true
  if (file === 'scripts/purge-zh.ts' || file === 'scripts/purge-zh.spec.ts') return true
  if (/^vendor\/[^/]+\/(README\.md|LICENSE)$/.test(file)) return true
  return false
}

/**
 * Locate retired brand tokens in one active text file.
 * @param file - Repository-relative path used in diagnostics.
 * @param source - Text to inspect.
 * @returns every matching source line outside the keep-list.
 */
export function findLegacyBrandReferences(file: string, source: string): LegacyBrandReference[] {
  if (keepListed(file)) return []
  const references: LegacyBrandReference[] = []
  for (const [index, line] of source.split('\n').entries()) {
    for (const token of FORBIDDEN) {
      if (token.pattern.test(line)) references.push({ file, line: index + 1, id: token.id })
    }
  }
  return references
}

function trackedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

function scanRepository(repoRoot: string): LegacyBrandReference[] {
  const references: LegacyBrandReference[] = []
  for (const file of trackedFiles(repoRoot)) {
    const path = resolve(repoRoot, file)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() && !stat.isSymbolicLink()) continue
    const source = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, 'utf8')
    if (source.includes('\0')) continue
    references.push(...findLegacyBrandReferences(file, source))
  }
  return references
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const references = scanRepository(root)
  if (references.length === 0) {
    console.log('verify-no-legacy-brand: tracked files carry no retired product identity.')
  } else {
    console.error('verify-no-legacy-brand: retired brand tokens found:')
    for (const reference of references) {
      console.error(`  ${reference.file}:${String(reference.line)} (${reference.id})`)
    }
    process.exitCode = 1
  }
}
