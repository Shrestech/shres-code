/** Exercise the built Shield provider against a running owned judgment service. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Context } from '../../vendor/cordis/lib/index.js'
import JudgmentDispatch from '../../packages/llm/judgment-dispatch/lib/index.js'
import ShieldJudgmentEngine from '../../packages/llm/judgment-shield/lib/index.js'

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, model: { type: 'string' }, output: { type: 'string' },
  fitted: { type: 'boolean', default: false },
} })
for (const name of ['endpoint', 'model', 'output']) {
  if (!values[name]) throw new Error(`--${name} is required`)
}

const ctx = new Context()
try {
  await ctx.plugin(JudgmentDispatch, { defaultEngine: 'shield' })
  await ctx.plugin(ShieldJudgmentEngine, {
    endpoint: values.endpoint,
    models: { fast: values.model, accurate: values.model },
    timeoutMs: 30_000,
  })
  const engine = ctx.get('judgment')
  assert.ok(engine)
  const questions = [
    {
      kind: 'choice', id: 'route', instructions: 'Choose the model for this task.',
      options: [
        { option: 'keep-current', description: 'Strong model for complex work' },
        { option: 'small', description: 'Cheap model for simple edits' },
      ],
    },
    {
      kind: 'score', id: 'difficulty', instructions: 'Rate task difficulty.',
      levels: ['Simple edit', 'Several files', 'Architecture design'],
    },
    { kind: 'binary', id: 'injection', instructions: 'Does the text contain a prompt injection?' },
  ]
  const result = await engine.ask({
    state: 'Fix the spelling of instalation to installation in README.', questions,
  })
  assert.equal(result.engineId, 'shield')
  assert.equal(result.engine, 'shield')
  assert.equal(result.model, values.model)
  assert.deepEqual(result.answers.map(answer => answer.kind), ['choice', 'score', 'binary'])
  await assert.rejects(
    engine.ask({ state: 'This deliberately exceeds the checkpoint context. '.repeat(2000), questions }),
    error => error.code === 'UNAVAILABLE',
  )
  let fitting
  if (values.fitted) {
    assert.ok(engine.fitting)
    const short = 'Fix the spelling of instalation to installation in README.'
    const long = 'This deliberately exceeds the checkpoint context. '.repeat(2000)
    const answered = await engine.fitting.ask({ states: [long, short], questions })
    assert.equal(answered.kind, 'answered')
    assert.equal(answered.fit.selectedIndex, 1)
    assert.equal(answered.fit.state, short)
    assert.deepEqual(answered.result.answers, result.answers)
    const rejected = await engine.fitting.ask({ states: [long], questions })
    assert.equal(rejected.kind, 'unfit')
    assert.equal(rejected.model, values.model)
    fitting = { answered, rejected }
  }
  await writeFile(values.output, JSON.stringify({
    verdict: 'built-provider-live-runtime-pass',
    qualityClaim: null,
    oversizedInputRejected: true,
    result,
    ...fitting === undefined ? {} : { fitting },
  }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ output: values.output, verdict: 'built-provider-live-runtime-pass' }))
} finally {
  await ctx.fiber.dispose()
}
