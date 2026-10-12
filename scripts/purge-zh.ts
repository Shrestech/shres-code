/**
 * Purge Chinese-language documentation artifacts. Deletes every tracked
 * `*.zh.md` and `*.i18n.yaml` outside `vendor/`, plus leftover
 * `.claude` mirrors of the retired `roos-translate-docs` /
 * `dsh-translate-docs` skill trees. Re-running `--apply` is a no-op once
 * the tree is clean.
 *
 * Usage: `pnpm run purge-zh [--apply|--check]`. Without a mode it reports
 * what would change. `--check` asserts the post-state: zero tracked zh
 * artifacts outside vendor, and the skill trees are gone.
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** Skill trees the English-only purge deletes. */
export const TRANSLATE_SKILL_PREFIXES = [
  '.claude/skills/roos-translate-docs/',
  '.claude/skills/dsh-translate-docs/',
] as const

/** True when a tracked path is a Chinese-language artifact this purge removes. */
export function isZhArtifact(file: string): boolean {
  if (file.startsWith('vendor/')) return false
  return file.endsWith('.zh.md') || file.endsWith('.i18n.yaml')
}

/** True when a tracked path belongs to a retired translate-docs skill tree. */
export function isTranslateSkillPath(file: string): boolean {
  return TRANSLATE_SKILL_PREFIXES.some(prefix => file.startsWith(prefix))
}

/**
 * Classify one tracked path as a purge target, or `undefined` when it stays.
 * @param file - repository-relative tracked path.
 * @returns `'artifact'` for `*.zh.md` / `*.i18n.yaml`, `'skill'` for a
 *   retired translate-docs tree, otherwise `undefined`.
 */
export function classifyPurgeTarget(file: string): 'artifact' | 'skill' | undefined {
  if (isZhArtifact(file)) return 'artifact'
  if (isTranslateSkillPath(file)) return 'skill'
  return undefined
}

function trackedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

function vendorZhResidue(files: readonly string[]): string[] {
  return files.filter(file =>
    file.startsWith('vendor/') && (file.endsWith('.zh.md') || file.endsWith('.i18n.yaml')))
}

function gitRm(files: readonly string[]): void {
  const batchSize = 200
  for (let index = 0; index < files.length; index += batchSize) {
    execFileSync('git', ['rm', '-f', '--', ...files.slice(index, index + batchSize)], { cwd: root, stdio: 'inherit' })
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args.includes('--apply') ? 'apply' : args.includes('--check') ? 'check' : 'dry'
  if (args.some(arg => arg !== '--apply' && arg !== '--check')) {
    console.error('purge-zh: usage: tsx scripts/purge-zh.ts [--apply|--check]')
    process.exit(1)
  }

  const files = trackedFiles(root)
  const vendorHits = vendorZhResidue(files)
  const artifacts = files.filter(isZhArtifact)
  const skills = files.filter(isTranslateSkillPath)
  const targets = [...artifacts, ...skills]
  const failures: string[] = []

  if (vendorHits.length > 0) {
    failures.push(`vendor/ carries ${String(vendorHits.length)} zh artifact(s); the purge must not touch vendor/`)
  }

  if (mode === 'check') {
    for (const file of targets) failures.push(`residue: ${file}`)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`purge-zh: ${failure}`)
      console.error(`purge-zh: ${String(failures.length)} problem(s); expected zero tracked *.zh.md / *.i18n.yaml outside vendor/ and no translate-docs skill trees.`)
      process.exitCode = 1
      return
    }
    console.log('purge-zh: post-state verified — zero tracked zh artifacts, skill trees gone, idempotent.')
    return
  }

  console.log(`purge-zh: ${mode} — ${String(artifacts.length)} artifact(s), ${String(skills.length)} skill file(s)`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`purge-zh: ${failure}`)
    process.exitCode = 1
    return
  }
  if (targets.length === 0) {
    console.log('purge-zh: already clean — nothing to remove.')
    return
  }
  if (mode === 'apply') {
    gitRm(targets)
    console.log(`purge-zh: applied. Removed ${String(targets.length)} tracked path(s).`)
    return
  }
  for (const file of targets.slice(0, 20)) console.log(`  ${file}`)
  if (targets.length > 20) console.log(`  … ${String(targets.length - 20)} more`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
