/**
 * Acceptance-path coverage for the Roos Code rebrand: each token rule, the
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
    expect(rewriteText("import x from '@deepseek-ai/dsh-session'")).toBe("import x from '@roos-code/roos-code-session'")
    expect(rewriteText('const name = "@deepseek-ai/dsh"')).toBe('const name = "@roos-code/roos-code"')
    expect(rewriteText('"@deepseek-ai/dsh-root"')).toBe('"@roos-code/roos-code-root"')
  })

  it('rewrites vendored and landlock scopes without the roos-code- infix', () => {
    expect(rewriteText("'@deepseek-ai/cordis'")).toBe("'@roos-code/cordis'")
    expect(rewriteText("'@deepseek-ai/cordis-plugin-loader'")).toBe("'@roos-code/cordis-plugin-loader'")
    expect(rewriteText("'@deepseek-ai/node-addon-landlock-run'")).toBe("'@roos-code/node-addon-landlock-run'")
    expect(rewriteText("'@deepseek-ai/website'")).toBe("'@roos-code/website'")
  })

  it('rewrites escaped regex package names', () => {
    expect(rewriteText('/^@deepseek-ai\\/dsh(?:-|$)/')).toBe('/^@roos-code\\/roos-code(?:-|$)/')
    expect(rewriteText('/^@deepseek-ai\\/(cosmokit|schemastery)(\\/|$)/')).toBe('/^@roos-code\\/(cosmokit|schemastery)(\\/|$)/')
  })

  it('rewrites every DSH_ env/identifier prefix', () => {
    expect(rewriteText('process.env.DSH_HOME')).toBe('process.env.ROOS_HOME')
    expect(rewriteText('DSH_SESSION_ID DSH_ENV_PREFIX DSH_SNAPSHOT')).toBe('ROOS_SESSION_ID ROOS_ENV_PREFIX ROOS_SNAPSHOT')
    expect(rewriteText("export const DSH_HOME_DIR_NAME = '.dsh'")).toBe("export const ROOS_HOME_DIR_NAME = '.roos'")
  })

  it('rewrites the product name, home, and GitHub URLs', () => {
    expect(rewriteText('DeepSeek Harness is an agent harness')).toBe('Roos Code is an agent harness')
    expect(rewriteText('~/.dsh and $DSH_HOME')).toBe('~/.roos and $ROOS_HOME')
    expect(rewriteText('https://github.com/deepseek-ai/deepseek-harness.git')).toBe('https://github.com/roos-code/roos-code.git')
    expect(rewriteText('git+https://github.com/deepseek-harness/deepseek-harness.git')).toBe('git+https://github.com/roos-code/roos-code.git')
  })

  it('rewrites Python, bin, website, and tag tokens', () => {
    expect(rewriteText('import deepseek_harness')).toBe('import roos_code')
    expect(rewriteText('import deepseek_harness_runtime')).toBe('import roos_code_runtime')
    expect(rewriteText('deepseek-harness-sdk deepseek-harness-runtime-bin')).toBe('roos-code-sdk roos-code-runtime-bin')
    expect(rewriteText('dsh-acp-demo dsh-jsonrpc-agent dsh-jsonrpc-agent-pkg')).toBe('roos-acp-demo roos-jsonrpc-agent roos-jsonrpc-agent-pkg')
    expect(rewriteText('dsh-lockup dsh-wordmark dsh-tag deepseek-harness-doc-projector')).toBe('roos-lockup roos-wordmark roos-tag roos-code-doc-projector')
    expect(rewriteText("tagPrefix = 'dsh-v'")).toBe("tagPrefix = 'roos-v'")
    expect(rewriteText("program.name('dsh')")).toBe("program.name('roos')")
    expect(rewriteText('dsh --profile headless')).toBe('roos --profile headless')
    expect(rewriteText('name: dsh-prose-standard')).toBe('name: roos-prose-standard')
  })

  it('rewrites PascalCase and camelCase Dsh identifiers', () => {
    expect(rewriteText('class DshFamily {}')).toBe('class RoosFamily {}')
    expect(rewriteText('parseDshArgs(); dshHomePath()')).toBe('parseRoosArgs(); roosHomePath()')
  })

  it('is idempotent', () => {
    const once = rewriteText("import { Context } from '@deepseek-ai/dsh-agent'; process.env.DSH_HOME")
    expect(rewriteText(once)).toBe(once)
    expect(once).toBe("import { Context } from '@roos-code/roos-code-agent'; process.env.ROOS_HOME")
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

  it('does not invent a token that is not in TOKEN_RULES', () => {
    expect(TOKEN_RULES.some(rule => rule.find === 'DEEPSEEK_API_KEY')).toBe(false)
    expect(TOKEN_RULES.some(rule => rule.find === 'deepseek-official')).toBe(false)
  })
})
