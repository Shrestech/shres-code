/**
 * Deterministic charter proposal extraction from the first human user message.
 * Templates are data: explicit title/keyword match, first hit wins. No work-type
 * classifier.
 *
 * @module @shres-code/shres-code-jspace/charter-seed
 */

import { CharterEntryId } from './charter.ts'
import type { CharterCheckInput, CharterEntryInput, CharterProseInput } from './types.ts'

/** Heading names that open a house-rules section. */
const SECTION_HEADINGS = ['## House rules', '## Constraints', '## Standing rules']

/**
 * House-rule catalog for `constraint-survival-build`. Commands point at the
 * task-fixture helper `tools/check-house-rules.mjs`.
 */
const HOUSE_RULE_TEMPLATES: ReadonlyArray<{
  readonly match: (text: string) => boolean
  readonly upgrade: (constraint: string) => CharterCheckInput
}> = [
  {
    match: text => /export prefix|exported function|`export \{/iu.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs export-prefix src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'insert', content: 'export function foo() {}\n' },
      },
    }),
  },
  {
    match: text => /audit tag|AUDIT-TAG/u.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs audit-tag src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'insert', content: '// no tag\n' },
      },
    }),
  },
  {
    match: text => /quantities|qty\(|bare numeric/iu.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs qty src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'prepend', content: 'const n = 3\n' },
      },
    }),
  },
  {
    match: text => /line budget|80 physical/iu.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs lines 80 src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'insert', content: `${Array.from({ length: 81 }, (_, i) => `// line ${String(i)}`).join('\n')}\n` },
      },
    }),
  },
  {
    match: text => /InventoryError|every thrown error/iu.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs inventory-error src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'insert', content: "throw new Error('x')\n" },
      },
    }),
  },
  {
    match: text => /self-check|selfCheck/u.test(text),
    upgrade: constraint => ({
      kind: 'check',
      constraint,
      command: 'node tools/check-house-rules.mjs self-check src/m*.js',
      reads: ['src/m*.js'],
      failProbe: {
        path: 'src/m-probe.js',
        mutation: { kind: 'insert', content: 'export function invNope() {}\n' },
      },
    }),
  },
]

/** Result of {@link extractCharterProposal}. */
export interface CharterProposalExtract {
  /** Proposed entries with harness-assigned ids. */
  readonly entries: readonly CharterEntryInput[]
  /** True when items were dropped at `maxCharterEntries`. */
  readonly truncated: boolean
}

/**
 * Prefer a `## House rules` (or Constraints, Standing rules) section until the
 * next `##` heading; else consecutive numbered items from the message body.
 * @param text - first human user message.
 * @param maxCharterEntries - cap; excess items set `truncated`.
 * @returns proposed entries, or empty when nothing matched.
 */
export function extractCharterProposal(
  text: string,
  maxCharterEntries = 12,
): CharterProposalExtract {
  const items = extractItems(text)
  if (items.length === 0) return { entries: [], truncated: false }
  const truncated = items.length > maxCharterEntries
  const selected = items.slice(0, maxCharterEntries)
  const entries = selected.map((item, index) => {
    const constraint = collapseConstraint(item)
    const upgraded = upgradeItem(constraint)
    const id = CharterEntryId(`e${String(index + 1)}`)
    return upgraded === undefined
      ? { kind: 'prose' as const, id, constraint } satisfies CharterProseInput
      : { ...upgraded, id }
  })
  return { entries, truncated }
}

/**
 * Collapse an extracted item to a single reprinted constraint line.
 * @param item - raw item text.
 * @returns trimmed single-line constraint.
 */
function collapseConstraint(item: string): string {
  return item.replace(/\s+/gu, ' ').trim()
}

/**
 * Upgrade a prose item via the first matching template.
 * @param constraint - item text.
 * @returns a check input, or `undefined` to keep prose.
 */
function upgradeItem(constraint: string): CharterCheckInput | undefined {
  for (const template of HOUSE_RULE_TEMPLATES) {
    if (template.match(constraint)) return template.upgrade(constraint)
  }
  return undefined
}

/**
 * Collect house-rule items from a section or a numbered list.
 * @param text - message body.
 * @returns item strings, possibly empty.
 */
function extractItems(text: string): string[] {
  const section = extractHouseRulesSection(text)
  if (section !== undefined) {
    const numbered = extractNumberedItems(section)
    return numbered.length > 0 ? numbered : splitParagraphs(section)
  }
  return extractNumberedItems(text)
}

/**
 * Slice from a known heading until the next `##` heading.
 * @param text - message body.
 * @returns section body without the heading, or `undefined`.
 */
function extractHouseRulesSection(text: string): string | undefined {
  const lines = text.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (SECTION_HEADINGS.some(heading => line.trim() === heading)) {
      start = index + 1
      break
    }
  }
  if (start < 0) return undefined
  const body: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (/^##\s/u.test(line.trim())) break
    body.push(line)
  }
  const joined = body.join('\n').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * Consecutive numbered items `^\d+\.\s+`.
 * @param text - section or message body.
 * @returns item bodies with the leading `N.` removed.
 */
function extractNumberedItems(text: string): string[] {
  const lines = text.split('\n')
  const items: string[] = []
  let current: string[] | undefined
  for (const line of lines) {
    const match = /^(\d+)\.\s+(.*)$/u.exec(line)
    if (match !== null) {
      if (current !== undefined) items.push(current.join('\n').trim())
      current = [match[2] ?? '']
      continue
    }
    if (current !== undefined) current.push(line)
  }
  if (current !== undefined) items.push(current.join('\n').trim())
  return items.filter(item => item.length > 0)
}

/**
 * Split a section with no numbered items into non-empty paragraphs.
 * @param text - section body.
 * @returns paragraphs.
 */
function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map(part => part.trim()).filter(part => part.length > 0)
}
