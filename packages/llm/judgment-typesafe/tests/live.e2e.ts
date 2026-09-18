/**
 * Live e2e for the TypeSafe judgment engine: it lists the vendor's models and
 * runs one ask against the real endpoint with a binary and a choice question.
 * Self-skips without $TYPESAFE_API_KEY, so keyless lanes stay green; run it with
 * `pnpm run test:e2e`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type { JudgmentBinaryQuestion, JudgmentChoiceQuestion } from '@shres-code/shres-code-judgment'
import TypesafeJudgmentEngine, { DEFAULT_ENDPOINT } from '../src/index.ts'
import { MemoryCredentials } from './credentials-memory.ts'

const API_KEY_REF = 'TYPESAFE_API_KEY'
const API_KEY = process.env[API_KEY_REF]

const BINARY: JudgmentBinaryQuestion = {
  kind: 'binary',
  id: judgmentQuestionId('dependency_fault'),
  instructions: 'Is the reported failure caused by the dependency itself rather than by the code calling it?',
  criteria: { yes: 'the dependency is at fault', no: 'the calling code is at fault' },
}

const CHOICE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('next_action'),
  instructions: 'What should be done next with this failure?',
  options: [
    { option: 'inspect_lockfile', description: 'read the lockfile entry for the named version' },
    { option: 'read_changelog', description: 'read the dependency changelog for a breaking change' },
    { option: 'retry_install', description: 're-run the install without other changes' },
  ],
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(API_KEY === undefined || API_KEY === '')('judgment-typesafe live e2e', () => {
  it('lists the vendor models with the same bearer header', async () => {
    const response = await fetch(`${DEFAULT_ENDPOINT}/v1/models`, {
      headers: { authorization: `Bearer ${API_KEY!}` },
    })
    expect(response.ok).toBe(true)
    const body: unknown = await response.json()
    const models = (body as { models?: unknown }).models
    expect(Array.isArray(models)).toBe(true)
    expect((models as { name?: unknown }[]).some(model => typeof model.name === 'string' && model.name.length > 0))
      .toBe(true)
  }, 60_000)

  it('answers one binary and one choice question about a small state', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials, { [API_KEY_REF]: API_KEY! })
    await ctx.plugin(TypesafeJudgmentEngine, { apiKeyRef: API_KEY_REF, timeoutMs: 60_000 })

    const result = await ctx.judgment.ask({
      state: 'The build fails right after a dependency bump. The error names version 4.2.0 of the package, which '
        + 'the lockfile pins, and nothing in the repository changed except the lockfile bump.',
      questions: [BINARY, CHOICE],
    })

    expect(result.engine).toBe('typesafe')
    expect(result.model.length).toBeGreaterThan(0)
    expect(result.answers.map(answer => answer.kind)).toEqual(['binary', 'choice'])

    const binary = result.answers[0]
    const choice = result.answers[1]
    if (binary?.kind !== 'binary') throw new Error('the engine did not answer the binary question')
    if (choice?.kind !== 'choice') throw new Error('the engine did not answer the choice question')
    expect(binary.probability).toBeGreaterThanOrEqual(0)
    expect(binary.probability).toBeLessThanOrEqual(1)
    expect(CHOICE.options.map(option => option.option)).toContain(choice.option)
  }, 120_000)
})
