/**
 * Mechanical charter-check floor: named-read contract plus tautology reject.
 * Decided before any process starts. Does not use `fs/observed`.
 *
 * @module @shres-code/shres-code-tool-jspace/floor
 */

import path from 'node:path'
import type { CharterCheckInput, CharterEntryId } from '@shres-code/shres-code-jspace'

/** Named floor refusal codes. */
export type CharterFloorCode =
  | 'JSPACE_CHARTER_READS_ESCAPE'
  | 'JSPACE_CHARTER_NO_READ'
  | 'JSPACE_CHARTER_CONSTANT'
  | 'JSPACE_CHARTER_MUTATING'
  | 'JSPACE_CHARTER_COMMAND_UNPARSEABLE'
  | 'JSPACE_CHARTER_FAILPROBE_PATH'
  | 'JSPACE_CHARTER_NO_READS'

/** Successful floor evaluation. */
export interface CharterFloorPass {
  readonly ok: true
}

/** Floor refusal. */
export interface CharterFloorRefuse {
  readonly ok: false
  readonly code: CharterFloorCode
  readonly message: string
}

/** Floor result. */
export type CharterFloorResult = CharterFloorPass | CharterFloorRefuse

const TEST_RUNNER = /^(?:node --test|vitest|npx vitest|npm test|pnpm test|yarn test)(?:\s|$)/u

const MUTATING = [
  /(^|[\s;|&])rm(\s|$)/u,
  /(^|[\s;|&])mv(\s|$)/u,
  /sed\s+-i/u,
  /(^|[\s;|&])tee(\s|$)/u,
  /npm\s+install/u,
  /pnpm\s+add/u,
  /git\s+commit/u,
]

/** Options for {@link evaluateCharterFloor}. */
export interface CharterFloorOptions {
  /** Session cwd used to resolve `reads`. */
  readonly cwd: string
  /** When true, refuse write-token commands. */
  readonly readOnly: boolean
  /** Entry id for named refusals. */
  readonly id: CharterEntryId | string
}

/**
 * Whether `spec` is a glob (`*`, `?`, or `**`).
 * @param spec - path or glob.
 * @returns true when the spec is a glob.
 */
export function isGlobPattern(spec: string): boolean {
  return spec.includes('*') || spec.includes('?')
}

/**
 * Convert a workspace-relative glob to a regex. `*` and `?` do not cross `/`;
 * `**` matches any path segment sequence.
 * @param pattern - glob pattern with `/` separators.
 * @returns matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  let i = 0
  let out = '^'
  const normalized = pattern.replaceAll('\\', '/')
  while (i < normalized.length) {
    if (normalized.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 3
      continue
    }
    if (normalized.startsWith('**', i) && i + 2 === normalized.length) {
      out += '.*'
      i += 2
      continue
    }
    const ch = normalized[i]
    i += 1
    if (ch === '*') {
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch !== undefined) out += ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  out += '$'
  return new RegExp(out)
}

/**
 * Whether `relPath` matches `pattern` as a glob, or equals it as a literal.
 * @param pattern - reads entry.
 * @param relPath - workspace-relative path.
 * @returns true on match.
 */
export function matchReadsPattern(pattern: string, relPath: string): boolean {
  const left = pattern.replaceAll('\\', '/')
  const right = relPath.replaceAll('\\', '/')
  if (left === right) return true
  return isGlobPattern(left) && globToRegExp(left).test(right)
}

/**
 * Resolve `spec` inside `cwd`. Rejects escape.
 * @param cwd - session cwd.
 * @param spec - relative path or glob (globs are not filesystem-resolved).
 * @returns posix-relative path inside cwd.
 */
export function resolveInsideCwd(cwd: string, spec: string): string | undefined {
  const trimmed = spec.trim()
  if (trimmed.length === 0 || trimmed !== spec) return undefined
  const posix = trimmed.replaceAll('\\', '/')
  if (posix.startsWith('/') || /^[A-Za-z]:/u.test(posix)) {
    const resolvedAbs = path.resolve(posix)
    const relAbs = path.relative(cwd, resolvedAbs)
    if (relAbs.startsWith('..') || path.isAbsolute(relAbs)) return undefined
    return relAbs.split(path.sep).join('/')
  }
  if (posix.startsWith('../') || posix === '..') return undefined
  const resolved = path.resolve(cwd, trimmed)
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join('/')
}

/**
 * Strip `#` comments to EOL outside quotes. Unclosed quote → unparseable.
 * @param command - bash command.
 * @returns stripped text, or `undefined` when quote state is open at EOL.
 */
export function stripBashComments(command: string): string | undefined {
  let out = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote === undefined && ch === '#') {
      while (i < command.length && command[i] !== '\n') i += 1
      if (command[i] === '\n') out += '\n'
      continue
    }
    if (quote === "'" && ch === "'") {
      quote = undefined
      out += ch
      continue
    }
    if (quote === '"') {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') quote = undefined
      out += ch
      continue
    }
    if (quote === undefined && (ch === "'" || ch === '"')) {
      quote = ch
      out += ch
      continue
    }
    out += ch
  }
  if (quote !== undefined) return undefined
  return out
}

/**
 * Split on `&&`, `||`, and `;` outside quotes.
 * @param command - already comment-stripped.
 * @returns segments, or `undefined` when unparseable.
 */
export function splitBashSegments(command: string): string[] | undefined {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote === "'") {
      current += ch
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      current += ch
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' ) {
      segments.push(current)
      current = ''
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '|' && command[i + 1] === '|') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
  }
  if (quote !== undefined) return undefined
  segments.push(current)
  return segments
}

/**
 * Tokenize on whitespace outside quotes; strip surrounding quotes from tokens.
 * @param command - already comment-stripped.
 * @returns tokens, or `undefined` when unparseable.
 */
export function tokenizeBash(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else current += ch
      continue
    }
    if (quote === '"') {
      if (escaped) {
        current += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        quote = undefined
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/u.test(ch)) {
      flush()
      continue
    }
    current += ch
  }
  if (quote !== undefined) return undefined
  flush()
  return tokens
}

/**
 * Unquoted scan of `>` / `>>` redirects.
 * @param command - already comment-stripped.
 * @returns true when an unquoted redirect is present.
 */
export function hasUnquotedRedirect(command: string): boolean {
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '>') return true
  }
  return false
}

/**
 * Whether a token names a `reads` entry or matches a `reads` glob.
 * @param token - unquoted token.
 * @param reads - declared reads.
 * @returns true on match.
 */
export function tokenMatchesReads(token: string, reads: readonly string[]): boolean {
  return reads.some(spec => matchReadsPattern(spec, token) || matchReadsPattern(spec, token.replaceAll('\\', '/')))
}

/**
 * Whether every segment is a constant-success tautology.
 * @param segments - split command segments.
 * @returns true when the command cannot fail on workspace content.
 */
export function isTautologyCommand(segments: readonly string[]): boolean {
  if (segments.length === 0) return true
  return segments.every(isTautologySegment)
}

/**
 * Whether one segment is a tautology (empty, true, echo, `test 1 -eq 1`, …).
 * A path token as an ignored operand of true/echo still counts as tautology.
 * @param segment - one `&&` / `||` / `;` piece.
 * @returns true when the segment cannot fail on file content.
 */
export function isTautologySegment(segment: string): boolean {
  const trimmed = collapseWhitespace(segment.trim())
  if (trimmed.length === 0) return true
  if (trimmed === 'true' || trimmed === ':' || trimmed === 'exit' || trimmed === 'exit 0') return true
  if (/^(?:true|:)\s+/u.test(trimmed)) return true
  if (/^(?:echo|printf|print)(?:\s|$)/u.test(trimmed)) return true
  if (trimmed === '[ 1 -eq 1 ]' || trimmed === 'test 1 -eq 1') return true
  return false
}

/**
 * Collapse runs of whitespace to a single space.
 * @param text - segment text.
 * @returns collapsed text.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

/**
 * Evaluate the named-read + tautology + mutating floor for one check.
 * @param entry - check input (id may already be assigned).
 * @param options - cwd and read-only flag.
 * @returns pass or a named refusal.
 */
export function evaluateCharterFloor(
  entry: CharterCheckInput,
  options: CharterFloorOptions,
): CharterFloorResult {
  const id = String(entry.id ?? options.id)
  const label = `${id}`
  const constraint = entry.constraint
  if (entry.reads.length < 1) {
    return refuse('JSPACE_CHARTER_NO_READS', `charter entry "${label}" (${constraint}) names no workspace read: put a path from \`reads\` in the command, or use a listed test runner.`)
  }
  for (const spec of entry.reads) {
    if (spec.trim().length === 0 || spec !== spec.trim()) {
      return refuse('JSPACE_CHARTER_READS_ESCAPE', `charter entry "${label}" (${constraint}) has a reads path that escapes the session cwd.`)
    }
    if (resolveInsideCwd(options.cwd, spec) === undefined) {
      return refuse('JSPACE_CHARTER_READS_ESCAPE', `charter entry "${label}" (${constraint}) has a reads path that escapes the session cwd.`)
    }
  }
  if (entry.failProbe !== undefined) {
    const probe = entry.failProbe
    const probePath = resolveInsideCwd(options.cwd, probe.path)
    if (probePath === undefined) {
      return refuse('JSPACE_CHARTER_READS_ESCAPE', `charter entry "${label}" (${constraint}) has a failProbe.path that escapes the session cwd.`)
    }
    const matches = entry.reads.some(spec => matchReadsPattern(spec, probePath) || matchReadsPattern(spec, probe.path))
    if (!matches) {
      return refuse(
        'JSPACE_CHARTER_FAILPROBE_PATH',
        `charter entry "${label}" (${constraint}) failProbe.path must be a member of reads or match a reads glob.`,
      )
    }
  }
  const stripped = stripBashComments(entry.command)
  if (stripped === undefined) {
    return refuse('JSPACE_CHARTER_COMMAND_UNPARSEABLE', `charter entry "${label}" (${constraint}) command is unparseable: quote state is still open at end of line.`)
  }
  const tokens = tokenizeBash(stripped)
  if (tokens === undefined) {
    return refuse('JSPACE_CHARTER_COMMAND_UNPARSEABLE', `charter entry "${label}" (${constraint}) command is unparseable: quote state is still open at end of line.`)
  }
  const runner = TEST_RUNNER.test(collapseWhitespace(stripped.trim()))
  const namedRead = tokens.some(token => tokenMatchesReads(token, entry.reads))
  const segments = splitBashSegments(stripped)
  if (segments === undefined) {
    return refuse('JSPACE_CHARTER_COMMAND_UNPARSEABLE', `charter entry "${label}" (${constraint}) command is unparseable: quote state is still open at end of line.`)
  }
  if (isTautologyCommand(segments)) {
    return refuse(
      'JSPACE_CHARTER_CONSTANT',
      `charter entry "${label}" (${constraint}) is a constant-success command. Write a command that reads a path from \`reads\` and can fail when the constraint is broken.`,
    )
  }
  if (!namedRead && !runner) {
    return refuse(
      'JSPACE_CHARTER_NO_READ',
      `charter entry "${label}" (${constraint}) names no workspace read: put a path from \`reads\` in the command, or use a listed test runner.`,
    )
  }
  if (options.readOnly) {
    const mutating = MUTATING.some(pattern => pattern.test(stripped)) || hasUnquotedRedirect(stripped)
    if (mutating) {
      return refuse(
        'JSPACE_CHARTER_MUTATING',
        `charter entry "${label}" (${constraint}) looks mutating. Charter checks must be read-only.`,
      )
    }
  }
  return { ok: true }
}

/**
 * Build a floor refusal.
 * @param code - named code.
 * @param message - model-visible text.
 * @returns refuse result.
 */
function refuse(code: CharterFloorCode, message: string): CharterFloorRefuse {
  return { ok: false, code, message }
}
