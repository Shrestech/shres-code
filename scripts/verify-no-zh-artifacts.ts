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
  { prefix: 'packages/client/ui-primitives/tests/fixtures/markdown-dom/cjk-strong-and-inline-code-url.settled.txt', reason: 'CJK markdown strong/inline-code rendering fixture' },
  { prefix: 'packages/client/ui-primitives/tests/fixtures/markdown-dom/cjk-strong-and-inline-code-url.streaming.txt', reason: 'CJK markdown strong/inline-code streaming fixture' },
  { prefix: 'packages/client/ui-primitives/tests/markdown.client.spec.tsx', reason: 'markdown renderer CJK emphasis and width cases' },
  { prefix: 'packages/client/ui-primitives/tests/markdown-incremental.client.spec.tsx', reason: 'incremental markdown CJK emphasis cases' },
  { prefix: 'packages/client/ui-primitives/tests/markdown-dom-parity.client.spec.tsx', reason: 'markdown DOM parity includes the CJK strong fixture' },
  { prefix: 'packages/client/ui-primitives/tests/ansi.client.spec.ts', reason: 'ANSI width table uses CJK sample cells' },
  { prefix: 'apps/web/tests/markdown-cjk-strong.e2e.ts', reason: 'assembled UI CJK markdown strong/inline-code scenario' },
  { prefix: 'apps/web/tests/snapshots/markdown-cjk-strong/', reason: 'golden for the CJK markdown strong/inline-code scenario' },
  { prefix: 'packages/e2b/fs-e2b/tests/filesystem.spec.ts', reason: 'UTF-8 path fixture uses CJK sample text' },
  { prefix: 'packages/e2b/subprocess-e2b/tests/subprocess.spec.ts', reason: 'UTF-8 env and decoder fixtures use CJK sample text' },
  { prefix: 'packages/e2b/subprocess-e2b/tests/terminal.spec.ts', reason: 'UTF-8 environment fixture uses CJK sample text' },
  { prefix: 'packages/fs/fs-local/tests/filesystem.spec.ts', reason: 'UTF-8 write fixture uses CJK sample text' },
  { prefix: 'packages/sdk/protocol/tests/transport.spec.ts', reason: 'UTF-8 JSON-RPC frame fixture uses CJK sample text' },
  { prefix: 'packages/session/session-title/tests/session-title.spec.ts', reason: 'title fallback width fixture uses CJK sample text' },
  { prefix: 'packages/shell/pwsh-local/tests/executor.spec.ts', reason: 'PowerShell UTF-8 command fixture uses CJK sample text' },
  { prefix: 'packages/terminal/terminal-bash/tests/session.spec.ts', reason: 'PTY viewport line-count fixture uses CJK sample text' },
  { prefix: 'packages/terminal/tool-terminal/tests/render.spec.ts', reason: 'East-Asian width truncation fixture uses CJK sample text' },
  { prefix: 'packages/terminal/tool-terminal/tests/tools.spec.ts', reason: 'East-Asian width truncation fixture uses CJK sample text' },
  { prefix: 'packages/test-support/llm-mock-server/tests/server.spec.ts', reason: 'UTF-8 request-body fixture uses CJK sample text' },
  { prefix: 'packages/llm/llm-deepseek/tests/serialize.spec.ts', reason: 'UTF-8 reasoning fixture uses CJK sample text' },
  { prefix: 'packages/llm/llm/tests/api-key.spec.ts', reason: 'API-key character-class fixture includes CJK sample text' },
  { prefix: 'packages/host/directory-picker-native/tests/win32-dialog-bindings.spec.ts', reason: 'Win32 folder-dialog Unicode path fixture' },
  { prefix: 'packages/host/directory-picker-native/tests/win32-dialog-logic.spec.ts', reason: 'Win32 folder-dialog Unicode path fixture' },
  { prefix: 'packages/context/agent-instructions/tests/agent-instructions.spec.ts', reason: 'UTF-8 instruction path fixture uses CJK sample text' },
  { prefix: 'packages/context/session-reference/tests/session-reference.spec.ts', reason: 'Unicode session-id and label fixtures use CJK sample text' },
  { prefix: 'packages/jobs/tool-jobs/tests/tool-jobs.spec.ts', reason: 'East-Asian width truncation fixture uses CJK sample text' },
  { prefix: 'packages/core/tools/src/py-types.ts', reason: 'documents that Unicode identifiers such as CJK remain legal Python names' },
  { prefix: 'packages/core/tools/tests/py-types.spec.ts', reason: 'generated Python types keep CJK identifiers as UTF-8 fixtures' },
  { prefix: 'packages/client/ui-settings-models/tests/components.client.spec.tsx', reason: 'API-key character-class fixture includes CJK sample text' },
  { prefix: '.agents/skills/shres-trim-cot-leakage/', reason: 'detector batteries include CJK authoring-language slips they must find' },
  { prefix: 'packages/jspace/jspace/tests/fold.spec.ts', reason: 'coverage matcher fixture proves CJK extra terms use substring includes' },
  { prefix: 'packages/jspace/jspace/tests/jspace.spec.ts', reason: 'checkpoint fixture proves extra CJK coverageTerms match at write time' },
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
