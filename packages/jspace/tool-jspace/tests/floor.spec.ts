import { describe, expect, it } from 'vitest'
import { CharterEntryId } from '@shres-code/shres-code-jspace'
import {
  evaluateCharterFloor,
  globToRegExp,
  isTautologyCommand,
  matchReadsPattern,
  resolveInsideCwd,
  splitBashSegments,
  stripBashComments,
} from '../src/floor.ts'

const cwd = '/tmp/ws'
const id = CharterEntryId('e1')

function check(command: string, reads: readonly string[] = ['src/m01-sku.js']) {
  return evaluateCharterFloor({
    kind: 'check',
    id,
    constraint: 'audit tag',
    command,
    reads,
  }, { cwd, readOnly: true, id })
}

describe('evaluateCharterFloor', () => {
  it('rejects echo ok', () => {
    const result = check('echo ok')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_CONSTANT')
  })

  it('rejects a comment-smuggled path', () => {
    const result = check('echo ok # src/m01-sku.js')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_CONSTANT')
  })

  it('rejects true path as a tautology with an ignored operand', () => {
    const result = check('true src/m01-sku.js')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_CONSTANT')
  })

  it('passes test -f (path token); discrimination must still reject it later', () => {
    expect(check('test -f src/m01-sku.js').ok).toBe(true)
  })

  it('passes a test-runner prefix even without a path token', () => {
    expect(check('node --test', ['src/m01-sku.js']).ok).toBe(true)
    expect(check('pnpm test', ['src/m01-sku.js']).ok).toBe(true)
  })

  it('passes grep with a reads path token', () => {
    expect(check('grep AUDIT-TAG src/m01-sku.js').ok).toBe(true)
  })

  it('passes a glob reads entry when the command names a matching path', () => {
    expect(check('node tools/check-house-rules.mjs audit-tag src/m*.js', ['src/m*.js']).ok).toBe(true)
  })

  it('rejects unparseable unclosed quotes', () => {
    const result = check("echo 'unterminated src/m01-sku.js")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_COMMAND_UNPARSEABLE')
  })

  it('rejects a reads path that escapes cwd', () => {
    const result = check('cat ../secret', ['../secret'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_READS_ESCAPE')
  })

  it('rejects mutating redirects when read-only', () => {
    const result = check('cat src/m01-sku.js >/dev/null')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_MUTATING')
  })

  it('rejects failProbe.path that is not in reads', () => {
    const result = evaluateCharterFloor({
      kind: 'check',
      id,
      constraint: 'audit tag',
      command: 'grep AUDIT-TAG src/m01-sku.js',
      reads: ['src/m01-sku.js'],
      failProbe: { path: 'src/other.js', mutation: { kind: 'insert', content: 'x' } },
    }, { cwd, readOnly: true, id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('JSPACE_CHARTER_FAILPROBE_PATH')
  })
})

describe('floor helpers', () => {
  it('strips comments outside quotes and keeps quoted hashes', () => {
    expect(stripBashComments('echo ok # comment')).toBe('echo ok ')
    expect(stripBashComments("echo '# not a comment'")).toBe("echo '# not a comment'")
  })

  it('splits on && || ; outside quotes', () => {
    expect(splitBashSegments('cat a || true')).toEqual(['cat a ', ' true'])
  })

  it('matches globs and resolves inside cwd', () => {
    expect(matchReadsPattern('src/m*.js', 'src/m-probe.js')).toBe(true)
    expect(globToRegExp('src/m*.js').test('src/other.js')).toBe(false)
    expect(resolveInsideCwd(cwd, 'src/foo.js')).toBe('src/foo.js')
    expect(resolveInsideCwd(cwd, '../x')).toBeUndefined()
  })

  it('treats empty segments as tautology', () => {
    expect(isTautologyCommand(['', 'true'])).toBe(true)
  })
})
