/**
 * Shared skill-document parser: the one YAML-frontmatter interpreter for
 * local discovery and plugin skill installation, so both surfaces accept and
 * reject exactly the same documents. The filesystem provider re-exports it
 * from its package root; the install subpath imports it directly.
 *
 * @module @shres-code/shres-code-skill-filesystem/parse
 */

import { parse as parseYaml } from 'yaml'
import type { SkillInvocationPolicy } from '@shres-code/shres-code-skill'
import { isSkillName } from '@shres-code/shres-code-skill/name'

/** Parsed frontmatter and body of one skill document. */
export interface SkillDocument {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Record<string, unknown>
  content: string
}

/**
 * Parse one skill document from its Markdown text: a `---`-delimited YAML
 * frontmatter object followed by the instruction body. This is the shared
 * parser for local discovery and plugin skill installation, so both paths
 * accept and reject exactly the same documents. Discovery logs the thrown
 * message and skips the entry; installers surface it as the refusal reason.
 * @param raw - complete skill file text, decoded as UTF-8.
 * @returns the required name and description, optional `whenToUse` and `metadata`,
 *   the resolved invocation policy, and the trimmed instruction body.
 * @throws when the frontmatter delimiters are missing, the YAML is malformed or
 *   not an object, `name`/`description` are absent, the name is not kebab-case,
 *   or an invocation field is unsupported or non-boolean; the message names the reason.
 */
export function parseSkillDocument(raw: string): SkillDocument {
  let parsed
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${errorMessage(error)}`)
  }
  if (!parsed) {
    throw new Error('missing YAML frontmatter')
  }
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) {
    throw new Error('frontmatter requires name and description')
  }
  if (!isSkillName(name)) {
    throw new Error(`invalid skill name "${name}"`)
  }
  let invocation
  try {
    invocation = parseInvocationPolicy(parsed.data)
  } catch (error) {
    throw new Error(`invalid invocation frontmatter: ${errorMessage(error)}`)
  }
  return {
    name,
    description,
    ...optionalString(parsed.data, 'whenToUse'),
    invocation,
    ...optionalMetadata(parsed.data),
    content: parsed.body.trim(),
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  const parsed = parseYaml(yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function rejectLegacyInvocationKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

function errorMessage(error: unknown): string {
  return String(error)
}
