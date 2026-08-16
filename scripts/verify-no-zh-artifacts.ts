/**
 * Reject leftover Chinese-language artifacts after the English-only purge.
 * Tracked `*.zh.md` / `*.i18n.yaml` outside `vendor/` fail. Tracked text
 * files that still contain CJK code points fail unless the path is on the
 * explicit allowlist, and each allowlist entry names why the CJK is
 * legitimate.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** One leftover Chinese-language artifact or CJK code point. */
export interface ZhResidue {
  /** Repository-relative file path. */
  file: string
  /** One-based source line, or 0 for a whole-file artifact. */
  line: number
  /** Which check failed. */
  id: 'zh-md' | 'i18n-yaml' | 'cjk'
}

/**
 * Paths that may still carry CJK, each with the reason it is legitimate.
 * Prefix entries end with `/`.
 */
export const CJK_ALLOWLIST: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'vendor/', reason: 'vendored upstream source is out of scope for the English-only purge' },
  { prefix: '.agents/notes/archived/', reason: 'frozen archive English notes keep historical switcher lines and quoted Chinese' },
  { prefix: 'scripts/archived-agent-notes.ts', reason: 'archive header check still requires the historical switcher line' },
  { prefix: 'scripts/archived-agent-notes.spec.ts', reason: 'archive fixtures pin the frozen historical switcher line' },
  { prefix: 'scripts/verify-no-zh-artifacts.ts', reason: 'this gate names CJK ranges and allowlist reasons' },
  { prefix: 'scripts/verify-no-zh-artifacts.spec.ts', reason: 'acceptance fixtures include a CJK sample the gate must detect' },
  { prefix: 'examples/headless-agent/tests/fixtures/e2b/', reason: 'UTF-8 split/PTY fixture output uses CJK sample text' },
  { prefix: 'packages/e2b/e2b/tests/composition.e2e.ts', reason: 'UTF-8 split output and hover fixture uses CJK sample text' },
  { prefix: 'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts', reason: 'JSONL UTF-8 body fixture replaces a greeting with CJK sample text' },
]

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/u

/** True when a path is a retired Chinese documentation artifact. */
export function isForbiddenZhArtifact(file: string): boolean {
  if (file.startsWith('vendor/')) return false
  return file.endsWith('.zh.md') || file.endsWith('.i18n.yaml')
}

/** True when CJK in this tracked path is allowlisted. */
export function isCjkAllowlisted(file: string): boolean {
  return CJK_ALLOWLIST.some(entry => file === entry.prefix || file.startsWith(entry.prefix))
}

/**
 * Locate leftover CJK code points in one text file.
 * @param file - repository-relative path used in diagnostics.
 * @param source - text to inspect.
 * @returns every matching source line outside the allowlist.
 */
export function findCjkResidue(file: string, source: string): ZhResidue[] {
  if (isCjkAllowlisted(file)) return []
  const residue: ZhResidue[] = []
  for (const [index, line] of source.split('\n').entries()) {
    if (CJK.test(line)) residue.push({ file, line: index + 1, id: 'cjk' })
  }
  return residue
}

function trackedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

/**
 * Scan a repository worktree for leftover Chinese artifacts and CJK.
 * @param repoRoot - repository root.
 * @returns every leftover path or CJK line.
 */
export function scanZhResidue(repoRoot: string): ZhResidue[] {
  const residue: ZhResidue[] = []
  for (const file of trackedFiles(repoRoot)) {
    if (isForbiddenZhArtifact(file)) {
      residue.push({ file, line: 0, id: file.endsWith('.zh.md') ? 'zh-md' : 'i18n-yaml' })
      continue
    }
    const path = resolve(repoRoot, file)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() && !stat.isSymbolicLink()) continue
    const source = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, 'utf8')
    if (source.includes('\0')) continue
    residue.push(...findCjkResidue(file, source))
  }
  return residue
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const residue = scanZhResidue(root)
  if (residue.length === 0) {
    console.log('verify-no-zh-artifacts: tracked files carry no leftover Chinese artifacts.')
  } else {
    console.error('verify-no-zh-artifacts: leftover Chinese artifacts found:')
    for (const item of residue) {
      const loc = item.line === 0 ? item.file : `${item.file}:${String(item.line)}`
      console.error(`  ${loc} (${item.id})`)
    }
    process.exitCode = 1
  }
}
