/**
 * Rebrand DeepSeek Harness to Roos Code. Every product identity token is
 * rewritten in one pass: package names, env vars, home directory, GitHub URLs,
 * Python module names, CLI/bin names, and prose. Keep-list strings
 * (`DEEPSEEK_API_KEY`, `deepseek-official`, `cordis.yml`, …) are not tokens
 * and are left alone.
 *
 * The generic pass applies ordered literal replacements (longest first) and a
 * small set of word-boundary rules. Sites the token rule cannot express are
 * listed in {@link EXACT_EDITS} with an exact hit count. Directory and file
 * renames live in {@link PATH_RENAMES}.
 *
 * Frozen trees (`.agents/notes/**`, `LICENSE`, vendored upstream README/LICENSE)
 * and this script (which must keep old tokens as find-strings) are skipped.
 *
 * Usage: `pnpm run rebrand [--apply|--check]`. Without a mode it reports what
 * would change. `--check` asserts the post-state: no residue, every exact edit
 * landed, every path rename landed, every postcondition holds, and a second
 * `--apply` would be a no-op.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const EXTENSIONS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.tpl', '.json', '.jsonl', '.yml', '.yaml', '.md',
  '.py', '.toml', '.lock', '.patch', '.css', '.html', '.txt', '.svg', '.sh',
  '.snap', '.webmanifest',
] as const

/** One ordered literal replacement. Longer `find` values are listed first. */
export interface TokenRule {
  readonly id: string
  readonly find: string
  readonly replace: string
}

/**
 * Product-identity literals, longest first so a prefix cannot steal a longer
 * name (`@deepseek-ai/dsh-` before `@deepseek-ai/dsh`, `deepseek_harness_runtime`
 * before `deepseek_harness`).
 */
export const TOKEN_RULES: readonly TokenRule[] = [
  { id: 'github-deepseek-ai-repo', find: 'github.com/deepseek-ai/deepseek-harness', replace: 'github.com/roos-code/roos-code' },
  { id: 'github-deepseek-harness-repo', find: 'github.com/deepseek-harness/deepseek-harness', replace: 'github.com/roos-code/roos-code' },
  { id: 'python-runtime-bin', find: 'deepseek-harness-runtime-bin', replace: 'roos-code-runtime-bin' },
  { id: 'doc-projector', find: 'deepseek-harness-doc-projector', replace: 'roos-code-doc-projector' },
  { id: 'python-sdk-name', find: 'deepseek-harness-sdk', replace: 'roos-code-sdk' },
  { id: 'python-runtime-module', find: 'deepseek_harness_runtime', replace: 'roos_code_runtime' },
  { id: 'python-sdk-module', find: 'deepseek_harness', replace: 'roos_code' },
  { id: 'product-slug', find: 'deepseek-harness', replace: 'roos-code' },
  { id: 'product-prose', find: 'DeepSeek Harness', replace: 'Roos Code' },
  // Escaped-slash forms must precede the raw slash so a regex source is rewritten
  // as a unit (`@deepseek-ai\/dsh-` → `@roos-code\/roos-code-`).
  { id: 'pkg-dsh-prefix-dbl-esc', find: '@deepseek-ai\\\\/dsh-', replace: '@roos-code\\\\/roos-code-' },
  { id: 'pkg-dsh-prefix-esc', find: '@deepseek-ai\\/dsh-', replace: '@roos-code\\/roos-code-' },
  { id: 'pkg-dsh-prefix', find: '@deepseek-ai/dsh-', replace: '@roos-code/roos-code-' },
  { id: 'pkg-dsh-exact-dbl-esc', find: '@deepseek-ai\\\\/dsh', replace: '@roos-code\\\\/roos-code' },
  { id: 'pkg-dsh-exact-esc', find: '@deepseek-ai\\/dsh', replace: '@roos-code\\/roos-code' },
  { id: 'pkg-dsh-exact', find: '@deepseek-ai/dsh', replace: '@roos-code/roos-code' },
  { id: 'scope-dbl-esc', find: '@deepseek-ai\\\\/', replace: '@roos-code\\\\/' },
  { id: 'scope-esc', find: '@deepseek-ai\\/', replace: '@roos-code\\/' },
  { id: 'scope-slash', find: '@deepseek-ai/', replace: '@roos-code/' },
  { id: 'scope-bare', find: '@deepseek-ai', replace: '@roos-code' },
  { id: 'env-prefix', find: 'DSH_', replace: 'ROOS_' },
  { id: 'home-display', find: '~/.dsh', replace: '~/.roos' },
  { id: 'pascal-dsh', find: 'Dsh', replace: 'Roos' },
]

const CAMEL_DSH = /dsh(?=[A-Z])/g
const WORD_DSH = /\bdsh\b/g
const WORD_DSH_UPPER = /\bDSH\b/g

/**
 * Apply every token rule, then the word-boundary CLI/identifier rules.
 * @param text - file contents to rewrite.
 * @returns the rewritten text (identical when no token is present).
 */
export function rewriteText(text: string): string {
  let out = text
  for (const rule of TOKEN_RULES) {
    if (out.includes(rule.find)) out = out.split(rule.find).join(rule.replace)
  }
  out = out.replace(CAMEL_DSH, 'roos')
  out = out.replace(WORD_DSH, 'roos')
  out = out.replace(WORD_DSH_UPPER, 'Roos')
  return out
}

/** An exact-string edit the token rule cannot express, with its required hit count. */
interface ExactEdit {
  readonly id: string
  readonly file: string
  readonly find: string
  readonly replace: string
  readonly expect: number
}

/** A string that must appear exactly `count` times once the rebrand has run. */
interface PostCondition {
  readonly file: string
  readonly text: string
  readonly count: number
}

/** A tracked path that must move with the rebrand. */
interface PathRename {
  readonly id: string
  readonly from: string
  readonly to: string
}

const EXACT_EDITS: readonly ExactEdit[] = [
  {
    id: 'hygiene-rebrand-check',
    file: 'package.json',
    find: '"hygiene": "pnpm run rescope-vendor:check && pnpm run knip',
    replace: '"hygiene": "pnpm run rescope-vendor:check && pnpm run rebrand:check && pnpm run knip',
    expect: 1,
  },
  {
    id: 'hygiene-legacy-brand',
    file: 'package.json',
    find: '&& pnpm run verify-vendored-links"',
    replace: '&& pnpm run verify-vendored-links && pnpm run verify-no-legacy-brand"',
    expect: 1,
  },
  {
    id: 'hygiene-leaf-rebrand',
    file: 'scripts/run-gates.ts',
    find: `    pnpmScript('rescope-vendor', 'rescope-vendor:check', { label: 'vendor rescope' }),
    pnpmScript('knip', 'knip'),`,
    replace: `    pnpmScript('rescope-vendor', 'rescope-vendor:check', { label: 'vendor rescope' }),
    pnpmScript('rebrand', 'rebrand:check', { label: 'Roos Code rebrand' }),
    pnpmScript('knip', 'knip'),`,
    expect: 1,
  },
  {
    id: 'hygiene-leaf-legacy-brand',
    file: 'scripts/run-gates.ts',
    find: `    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
  ]`,
    replace: `    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
    pnpmScript('legacy-brand', 'verify-no-legacy-brand', { label: 'legacy brand residue' }),
  ]`,
    expect: 1,
  },
]

const POSTCONDITIONS: readonly PostCondition[] = [
  { file: 'vendor/cordis/package.json', text: '"name": "@roos-code/cordis"', count: 1 },
  { file: 'apps/cli/package.json', text: '"name": "@roos-code/roos-code"', count: 1 },
  { file: 'apps/cli/package.json', text: '"roos": "lib/bin.js"', count: 1 },
  { file: 'package.json', text: '"name": "@roos-code/roos-code-root"', count: 1 },
  { file: 'package.json', text: '"rebrand:check": "tsx scripts/rebrand.ts --check"', count: 1 },
  { file: 'package.json', text: 'pnpm run rebrand:check', count: 1 },
  { file: 'packages/util/home-paths/src/index.ts', text: "export const ROOS_HOME_DIR_NAME = '.roos'", count: 1 },
  { file: 'packages/util/home-paths/src/index.ts', text: "export const ROOS_HOME_ENV = 'ROOS_HOME'", count: 1 },
  { file: 'apps/cli/src/args.ts', text: ".name('roos')", count: 1 },
  { file: 'scripts/release/families.ts', text: "readonly id = 'roos'", count: 1 },
  { file: 'scripts/release/families.ts', text: "readonly tagPrefix = 'roos-v'", count: 1 },
  { file: 'packages/llm/llm/src/attribution.ts', text: "product: 'roos-code'", count: 1 },
  { file: 'tsconfig.base.json', text: '"@roos-code/cordis-plugin-loader": ["./vendor/loader/src"]', count: 1 },
  { file: 'pnpm-workspace.yaml', text: "'@roos-code/cosmokit': 'link:vendor/cosmokit'", count: 1 },
  { file: 'website/package.json', text: '"name": "@roos-code/website"', count: 1 },
  { file: 'website/.vitepress/config.ts', text: "title: 'Roos Code'", count: 1 },
  { file: 'scripts/check-workspace-constraints.ts', text: "const repositoryUrl = 'git+https://github.com/roos-code/roos-code.git'", count: 1 },
  { file: 'scripts/verify-roos-package-licenses.ts', text: '/^@roos-code\\/roos-code(?:-|$)/', count: 1 },
]

const PATH_RENAMES: readonly PathRename[] = [
  { id: 'license-gate', from: 'scripts/verify-dsh-package-licenses.ts', to: 'scripts/verify-roos-package-licenses.ts' },
  { id: 'license-gate-spec', from: 'scripts/verify-dsh-package-licenses.spec.ts', to: 'scripts/verify-roos-package-licenses.spec.ts' },
  { id: 'python-sdk', from: 'python/sdk/src/deepseek_harness', to: 'python/sdk/src/roos_code' },
  { id: 'python-runtime', from: 'python/sdk-runtime/src/deepseek_harness_runtime', to: 'python/sdk-runtime/src/roos_code_runtime' },
  { id: 'python-runtime-json', from: 'python/sdk-runtime/src/roos_code_runtime/deepseek-harness-runtime.json', to: 'python/sdk-runtime/src/roos_code_runtime/roos-code-runtime.json' },
  { id: 'skill-archive', from: '.agents/skills/dsh-archive-agent-notes', to: '.agents/skills/roos-archive-agent-notes' },
  { id: 'skill-review', from: '.agents/skills/dsh-code-review', to: '.agents/skills/roos-code-review' },
  { id: 'skill-doc-site', from: '.agents/skills/dsh-doc-site-sync', to: '.agents/skills/roos-doc-site-sync' },
  { id: 'skill-doc-std', from: '.agents/skills/dsh-doc-standards', to: '.agents/skills/roos-doc-standards' },
  { id: 'skill-simplifications', from: '.agents/skills/dsh-find-simplifications', to: '.agents/skills/roos-find-simplifications' },
  { id: 'skill-stacks', from: '.agents/skills/dsh-merging-stacked-prs', to: '.agents/skills/roos-merging-stacked-prs' },
  { id: 'skill-pre-push', from: '.agents/skills/dsh-pre-push-checks', to: '.agents/skills/roos-pre-push-checks' },
  { id: 'skill-prose', from: '.agents/skills/dsh-prose-standard', to: '.agents/skills/roos-prose-standard' },
  { id: 'skill-translate', from: '.agents/skills/dsh-translate-docs', to: '.agents/skills/roos-translate-docs' },
  { id: 'skill-cot', from: '.agents/skills/dsh-trim-cot-leakage', to: '.agents/skills/roos-trim-cot-leakage' },
  { id: 'subagent-sdk', from: 'packages/subagent/subagent-dsh-sdk', to: 'packages/subagent/subagent-roos-sdk' },
  { id: 'subagent-sdk-fixture', from: 'examples/jsonrpc-agent/tests/fixtures/subagent/subagent-dsh-sdk', to: 'examples/jsonrpc-agent/tests/fixtures/subagent/subagent-roos-sdk' },
  { id: 'cli-badge-fixture', from: 'apps/cli/tests/fixtures/dsh-badge', to: 'apps/cli/tests/fixtures/roos-badge' },
  { id: 'cli-badge-snapshot', from: 'apps/cli/tests/dsh-badge.snapshot.ts', to: 'apps/cli/tests/roos-badge.snapshot.ts' },
  { id: 'skill-badge-md', from: 'packages/skill/skill-badge/assets/dsh-badge.md', to: 'packages/skill/skill-badge/assets/roos-badge.md' },
  { id: 'skill-badge-png', from: 'packages/skill/skill-badge/assets/dsh-badge.png', to: 'packages/skill/skill-badge/assets/roos-badge.png' },
  { id: 'cookbook-review', from: 'docs/cookbook/maintaining-dsh-code-review.md', to: 'docs/cookbook/maintaining-roos-code-review.md' },
]

/** Files the rebrand must never rewrite. */
function excluded(file: string): boolean {
  if (file === 'scripts/rebrand.ts' || file === 'scripts/rebrand.spec.ts') return true
  if (file === 'scripts/verify-no-legacy-brand.ts') return true
  if (file === 'LICENSE' || file === 'NOTICE') return true
  if (file.startsWith('.agents/notes/')) return true
  if (file.endsWith('.i18n.yaml')) return true
  if (file === 'pnpm-lock.yaml') return true
  if (/^vendor\/[^/]+\/(README\.md|LICENSE)$/.test(file)) return true
  return !EXTENSIONS.some(extension => file.endsWith(extension))
}

function classify(file: string): string {
  if (file.endsWith('package.json')) return 'package.json identities'
  if (/\.(ts|tsx|js|mjs|cjs|tpl)$/.test(file)) return 'code specifiers'
  if (/\.(yml|yaml)$/.test(file)) return 'YAML configuration'
  if (file.endsWith('.json')) return 'JSON configuration'
  if (file.endsWith('.py') || file.endsWith('.toml')) return 'Python package names'
  if (file.endsWith('.md')) return 'Markdown prose and fences'
  return 'other product tokens'
}

/**
 * One exact edit's state in the text it targets. `pending` means the source
 * form is present and the target form absent; `applied` means the reverse;
 * anything else is `invalid`.
 */
export type ExactEditState = 'pending' | 'applied' | 'invalid'

/**
 * Classify one exact edit against its target text.
 * @param text - the complete current text of the edited file.
 * @param find - the source form, already oriented for the running direction.
 * @param replace - the target form, already oriented for the running direction.
 * @param expect - how many occurrences one complete application produces.
 * @returns Whether the edit is pending, already applied, or invalid.
 */
export function exactEditState(text: string, find: string, replace: string, expect: number): ExactEditState {
  const hits = text.split(find).length - 1
  const landed = text.split(replace).length - 1
  if (replace.includes(find)) {
    if (landed === expect) return 'applied'
    return landed === 0 && hits === expect ? 'pending' : 'invalid'
  }
  if (find.includes(replace)) {
    if (hits === 0) return landed === expect ? 'applied' : 'invalid'
    return hits === expect ? 'pending' : 'invalid'
  }
  if (hits === 0 && landed === expect) return 'applied'
  return hits === expect && landed === 0 ? 'pending' : 'invalid'
}

function pathRenameState(from: string, to: string): ExactEditState {
  const oldExists = existsSync(resolve(root, from))
  const newExists = existsSync(resolve(root, to))
  if (!oldExists && newExists) return 'applied'
  if (oldExists && !newExists) return 'pending'
  return 'invalid'
}

function applyPathRename(from: string, to: string): void {
  const source = resolve(root, from)
  try {
    execFileSync('git', ['mv', from, to], { cwd: root })
  } catch {
    // Untracked paths (or a worktree git-mv refusal) fall back to a filesystem move.
    renameSync(source, resolve(root, to))
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args.includes('--apply') ? 'apply' : args.includes('--check') ? 'check' : 'dry'
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '' && !excluded(file))

  const counts = new Map<string, { files: number; lines: number }>()
  const failures: string[] = []
  const outstanding: string[] = []

  const planned: { edit: ExactEdit; path: string; find: string; replace: string }[] = []
  for (const edit of EXACT_EDITS) {
    const path = resolve(root, edit.file)
    if (!existsSync(path)) {
      // Exact edits that target a path the generic pass or a PATH_RENAME will
      // create are checked after those steps.
      if (mode === 'check') failures.push(`exact edit ${edit.id}: ${edit.file} is missing`)
      else planned.push({ edit, path, find: edit.find, replace: edit.replace })
      continue
    }
    const before = readFileSync(path, 'utf8')
    const state = exactEditState(before, edit.find, edit.replace, edit.expect)
    if (state === 'invalid') {
      failures.push(`exact edit ${edit.id}: ${edit.file} is neither pending nor cleanly applied (duplicated, partial, or moved)`)
      continue
    }
    if (mode === 'check') {
      if (state !== 'applied') failures.push(`exact edit ${edit.id} did not land in ${edit.file}`)
      continue
    }
    if (state === 'pending') planned.push({ edit, path, find: edit.find, replace: edit.replace })
  }

  const plannedRenames: PathRename[] = []
  for (const rename of PATH_RENAMES) {
    const state = pathRenameState(rename.from, rename.to)
    if (state === 'invalid') {
      // python-runtime-json depends on the parent directory rename.
      if (rename.id === 'python-runtime-json' && existsSync(resolve(root, 'python/sdk-runtime/src/deepseek_harness_runtime/deepseek-harness-runtime.json'))) {
        if (mode !== 'check') plannedRenames.push(rename)
        else failures.push(`path rename ${rename.id} did not land (${rename.from} → ${rename.to})`)
        continue
      }
      if (mode === 'check') {
        failures.push(`path rename ${rename.id}: neither pending nor applied (${rename.from} → ${rename.to})`)
      } else if (existsSync(resolve(root, rename.from))) {
        plannedRenames.push(rename)
      } else {
        failures.push(`path rename ${rename.id}: ${rename.from} is missing`)
      }
      continue
    }
    if (mode === 'check') {
      if (state !== 'applied') failures.push(`path rename ${rename.id} did not land`)
      continue
    }
    if (state === 'pending') plannedRenames.push(rename)
  }

  if (failures.length > 0 && mode !== 'dry') {
    for (const failure of failures) console.error(`rebrand: ${failure}`)
    console.error(`rebrand: ${String(failures.length)} problem(s); nothing was written.`)
    process.exitCode = 1
    return
  }

  if (mode === 'apply') {
    for (const { path, find, replace } of planned) {
      if (!existsSync(path)) continue
      writeFileSync(path, readFileSync(path, 'utf8').split(find).join(replace))
    }
  }

  for (const file of files) {
    const path = resolve(root, file)
    if (!existsSync(path)) continue
    const before = readFileSync(path, 'utf8')
    if (before.includes('\0')) continue
    const after = rewriteText(before)
    if (after === before) continue
    const lines = before.split('\n').filter((line, index) => after.split('\n')[index] !== line).length
    outstanding.push(file)
    const kind = classify(file)
    const current = counts.get(kind) ?? { files: 0, lines: 0 }
    counts.set(kind, { files: current.files + 1, lines: current.lines + lines })
    if (mode === 'apply') writeFileSync(path, after)
  }

  if (mode === 'apply') {
    // Parent directories first so nested json/file renames see the new path.
    const ordered = [...plannedRenames].sort((left, right) => left.from.length - right.from.length)
    for (const rename of ordered) {
      const from = rename.id === 'python-runtime-json' && !existsSync(resolve(root, rename.from))
        ? 'python/sdk-runtime/src/deepseek_harness_runtime/deepseek-harness-runtime.json'
        : rename.from
      if (!existsSync(resolve(root, from))) {
        failures.push(`path rename ${rename.id}: ${from} is missing at apply time`)
        continue
      }
      applyPathRename(from, rename.to)
    }
  }

  console.log(`rebrand: ${mode} over ${String(files.length)} tracked files`)
  for (const kind of [...counts.keys()].sort()) {
    const { files: count, lines } = counts.get(kind) ?? { files: 0, lines: 0 }
    console.log(`  ${kind.padEnd(24)} ${String(count).padStart(4)} file(s), ${String(lines)} line(s)`)
  }
  if (plannedRenames.length > 0 && mode !== 'check') {
    console.log(`  path renames             ${String(plannedRenames.length).padStart(4)}`)
  }

  if (mode !== 'dry') {
    for (const check of POSTCONDITIONS) {
      const path = resolve(root, check.file)
      const hits = existsSync(path) ? readFileSync(path, 'utf8').split(check.text).length - 1 : -1
      if (hits !== check.count) {
        failures.push(`postcondition: ${check.file} has ${String(hits)} occurrence(s) of ${JSON.stringify(check.text)}, expected ${String(check.count)}`)
      }
    }
    if (mode === 'check') {
      for (const file of outstanding) failures.push(`residue: ${file} still carries a pre-rebrand token`)
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`rebrand: ${failure}`)
    console.error(`rebrand: ${String(failures.length)} problem(s); the mapping or a site moved.`)
    process.exitCode = 1
  } else if (mode === 'check') {
    console.log('rebrand: post-state verified — no residue, every exact edit landed, idempotent.')
  } else if (mode === 'apply') {
    console.log('rebrand: applied. Run `pnpm install` and `pnpm run gen-third-party-notices`.')
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
