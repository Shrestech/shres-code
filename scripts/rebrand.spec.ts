/**
 * Acceptance-path coverage for the Shres Code rebrand: each token rule, the
 * keep-list non-rewrites, and the exact-edit classifier.
 */

import { describe, expect, it } from 'vitest'
import { exactEditState, rewriteText, TOKEN_RULES } from './rebrand.ts'

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    const anchor = '\n## Sync procedure'
    const inserted = `\n15. **rebrand**: one log entry.\n${anchor}`
    expect(exactEditState(`log\n${anchor}\n`, anchor, inserted, 1)).toBe('pending')
    expect(exactEditState(`log${inserted}\n`, anchor, inserted, 1)).toBe('applied')
    expect(exactEditState(`log${inserted}${inserted}\n`, anchor, inserted, 1)).toBe('invalid')
    expect(exactEditState('log\n', anchor, inserted, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

describe('rewriteText token rules', () => {
  it('rewrites scoped harness packages without swallowing the exact CLI name', () => {
    expect(rewriteText("import x from '@roos-code/roos-code-session'")).toBe("import x from '@shres-code/shres-code-session'")
    expect(rewriteText('const name = "@roos-code/roos-code"')).toBe('const name = "@shres-code/shres-code"')
    expect(rewriteText('"@roos-code/roos-code-root"')).toBe('"@shres-code/shres-code-root"')
  })

  it('rewrites vendored and landlock scopes without the shres-code- infix', () => {
    expect(rewriteText("'@roos-code/cordis'")).toBe("'@shres-code/cordis'")
    expect(rewriteText("'@roos-code/cordis-plugin-loader'")).toBe("'@shres-code/cordis-plugin-loader'")
    expect(rewriteText("'@roos-code/node-addon-landlock-run'")).toBe("'@shres-code/node-addon-landlock-run'")
    expect(rewriteText("'@roos-code/website'")).toBe("'@shres-code/website'")
  })

  it('rewrites escaped regex package names', () => {
    expect(rewriteText('/^@roos-code\\/roos-code(?:-|$)/')).toBe('/^@shres-code\\/shres-code(?:-|$)/')
    expect(rewriteText('/^@roos-code\\/(cosmokit|schemastery)(\\/|$)/')).toBe('/^@shres-code\\/(cosmokit|schemastery)(\\/|$)/')
  })

  it('rewrites every ROOS_ env/identifier prefix', () => {
    expect(rewriteText('process.env.ROOS_HOME')).toBe('process.env.SHRES_HOME')
    expect(rewriteText('ROOS_SESSION_ID ROOS_ENV_PREFIX ROOS_SNAPSHOT')).toBe('SHRES_SESSION_ID SHRES_ENV_PREFIX SHRES_SNAPSHOT')
    expect(rewriteText("export const ROOS_HOME_DIR_NAME = '.roos'")).toBe("export const SHRES_HOME_DIR_NAME = '.shres'")
    expect(rewriteText('window.__ROOS_BOOT__')).toBe('window.__SHRES_BOOT__')
  })

  it('rewrites the product name, home, and GitHub URLs to this fork', () => {
    expect(rewriteText('Roos Code is an agent harness')).toBe('Shres Code is an agent harness')
    expect(rewriteText('~/.roos and $ROOS_HOME')).toBe('~/.shres and $SHRES_HOME')
    expect(rewriteText('https://github.com/roos-code/roos-code.git')).toBe('https://github.com/parthmstech/shres-code.git')
    expect(rewriteText('git+https://github.com/roos-code/roos-code.git')).toBe('git+https://github.com/parthmstech/shres-code.git')
    expect(rewriteText('https://github.com/roos-code/cosmokit')).toBe('https://github.com/parthmstech/cosmokit')
  })

  it('does not invent github.com/shres-code/shres-code from the slug rule', () => {
    expect(rewriteText('github.com/roos-code/roos-code')).toBe('github.com/parthmstech/shres-code')
    expect(TOKEN_RULES.find(rule => rule.id === 'github-repo')?.find).toBe('github.com/roos-code/roos-code')
  })

  it('rewrites Python, bin, website, and tag tokens', () => {
    expect(rewriteText('import roos_code')).toBe('import shres_code')
    expect(rewriteText('import roos_code_runtime')).toBe('import shres_code_runtime')
    expect(rewriteText('roos-code-sdk roos-code-runtime-bin')).toBe('shres-code-sdk shres-code-runtime-bin')
    expect(rewriteText('roos-acp-demo roos-jsonrpc-agent roos-jsonrpc-agent-pkg')).toBe('shres-acp-demo shres-jsonrpc-agent shres-jsonrpc-agent-pkg')
    expect(rewriteText('roos-lockup roos-wordmark roos-tag roos-code-doc-projector')).toBe('shres-lockup shres-wordmark shres-tag shres-code-doc-projector')
    expect(rewriteText("tagPrefix = 'roos-v'")).toBe("tagPrefix = 'shres-v'")
    expect(rewriteText("program.name('roos')")).toBe("program.name('shres')")
    expect(rewriteText('roos --profile headless')).toBe('shres --profile headless')
    expect(rewriteText('name: roos-prose-standard')).toBe('name: shres-prose-standard')
    expect(rewriteText('"roos": { "bundle": { "patch": "./cordis.patch.yml" } }')).toBe('"shres": { "bundle": { "patch": "./cordis.patch.yml" } }')
  })

  it('rewrites PascalCase and camelCase Roos identifiers', () => {
    expect(rewriteText('class RoosFamily {}')).toBe('class ShresFamily {}')
    expect(rewriteText('parseRoosArgs(); roosHomePath()')).toBe('parseShresArgs(); shresHomePath()')
    expect(rewriteText('defaultRoosHome()')).toBe('defaultShresHome()')
  })

  it('is idempotent', () => {
    const once = rewriteText("import { Context } from '@roos-code/roos-code-agent'; process.env.ROOS_HOME")
    expect(rewriteText(once)).toBe(once)
    expect(once).toBe("import { Context } from '@shres-code/shres-code-agent'; process.env.SHRES_HOME")
  })
})

describe('rewriteText keep-list', () => {
  it('does not rewrite the DeepSeek API contract or official provider ids', () => {
    const source = [
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'https://api.deepseek.com',
      '/anthropic/v1',
      'deepseek-official',
      'llm-deepseek',
      'web-search-deepseek',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ].join('\n')
    expect(rewriteText(source)).toBe(source)
  })

  it('does not rewrite Cordis protocol tokens or the agents home path', () => {
    const source = [
      'cordis:include',
      'cordis.yml',
      'agent.cordis.yml',
      'cordis.patch.yml',
      "Symbol.for('schemastery')",
      '~/.agents',
    ].join('\n')
    expect(rewriteText(source)).toBe(source)
  })

  it('does not rewrite unrelated words that contain roo', () => {
    expect(rewriteText('kangaroo proofs broom')).toBe('kangaroo proofs broom')
  })

  it('does not invent a token that is not in TOKEN_RULES', () => {
    expect(TOKEN_RULES.some(rule => rule.find === 'DEEPSEEK_API_KEY')).toBe(false)
    expect(TOKEN_RULES.some(rule => rule.find === 'deepseek-official')).toBe(false)
  })
})
