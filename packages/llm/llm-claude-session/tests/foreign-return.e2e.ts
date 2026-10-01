/**
 * Live probe: does Claude resume with thinking after a routed segment? A
 * conversation whose earlier assistant turn came from another model — a
 * DeepSeek-shaped tool call carrying no signed thinking block — is continued on
 * the adaptive-thinking Opus route with reasoning enabled, as the model router's
 * return to the manual route does. Passing means the request is accepted and
 * the reply carries a reasoning block.
 *
 * Opt-in because it spends subscription quota on a live Opus call: it runs only
 * with `SHRES_E2E_CLAUDE_FOREIGN_RETURN=1` and a readable Claude Code login, and
 * self-skips otherwise. Run it alone:
 *
 *     SHRES_E2E_CLAUDE_FOREIGN_RETURN=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *       packages/llm/llm-claude-session/tests/foreign-return.e2e.ts
 */

import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, {
  BlockAssembler,
  CallId,
  ReasoningEffortId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@shres-code/shres-code-llm'
import * as LlmClaudeSession from '../src/index.ts'
import { ClaudeSessionManager, resolveCredentialSpec } from '../src/index.ts'

/** The manual route the model router returns to. */
const MODEL = 'claude-opus-5-5'

const OPTED_IN = process.env.SHRES_E2E_CLAUDE_FOREIGN_RETURN === '1'
const HAS_LOGIN = OPTED_IN
  && await new ClaudeSessionManager(resolveCredentialSpec({})).current().then(() => true, () => false)

const contexts: Context[] = []

afterAll(async () => {
  await Promise.all(contexts.map(context => context.fiber.dispose()))
})

describe.skipIf(!HAS_LOGIN)('llm-claude-session foreign-segment return (live, opt-in)', () => {
  it('continues a foreign tool-call segment with thinking', { timeout: 5 * 60_000, retry: 0 }, async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    await context.plugin(LlmClaudeSession, {})

    const callId = CallId('call_00_foreign_segment')
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: 'List the files in the working directory, then tell me which one is the README.' }],
        source: { kind: 'user' },
      }),
      // The routed candidate's turn: a tool call with no thinking block, as a
      // DeepSeek model produces it.
      createAssistantMessage({
        content: [
          { type: 'text', text: 'I will list the directory.' },
          { type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command: 'ls' }) },
        ],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'README.md\npackage.json\nsrc' }],
        isError: false,
      }),
    ]
    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({
      provider: 'claude-session',
      model: MODEL,
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 2048,
      system: 'You are a coding assistant.',
      messages,
      tools: [{
        name: 'bash',
        description: 'Run one shell command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      }],
    })) {
      assembler.push(chunk)
    }

    const blocks = assembler.blocks()
    console.info(`claude-session foreign-return probe ${new Date().toISOString()}: finish ${JSON.stringify(assembler.finish)}; blocks ${JSON.stringify(blocks.map(block => block.type))}`)
    // The request is accepted: a foreign segment is no protocol error.
    expect(assembler.finish.kind).not.toBe('error')
    // The return still thinks.
    expect(blocks.some(block => block.type === 'reasoning')).toBe(true)
  })
})
