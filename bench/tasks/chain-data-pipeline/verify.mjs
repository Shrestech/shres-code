/**
 * Verifier for the chain-data-pipeline task.
 *
 * Resolved when (a) the pipeline produces correct output using the constants,
 * (b) the test file is unmodified, (c) constants.js is unmodified, and
 * (d) `node --test` passes.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * @param {string} detail
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const constantsFile = path.join(scratch, 'src/constants.js')
if (!existsSync(constantsFile)) fail('src/constants.js is missing')
const fixtureConstants = readFileSync(new URL('./fixture/src/constants.js', import.meta.url))
const scratchConstants = readFileSync(constantsFile)
if (!fixtureConstants.equals(scratchConstants)) fail('src/constants.js was modified')

const testFile = path.join(scratch, 'test/pipeline.test.js')
if (!existsSync(testFile)) fail('test/pipeline.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/pipeline.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/pipeline.test.js was modified')

const pipelinePath = path.join(scratch, 'src/pipeline.js')
if (!existsSync(pipelinePath)) fail('src/pipeline.js is missing')

const pipeline = await import(pathToFileURL(pipelinePath).href)
if (typeof pipeline.runPipeline !== 'function') fail('src/pipeline.js does not export runPipeline')

const result = pipeline.runPipeline([100, 250, 50])
const expected = ['3.500', '5.000', '3.000']
if (JSON.stringify(result) !== JSON.stringify(expected)) {
  fail(`pipeline output wrong: got ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`)
}

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: data pipeline correctly applies constants, tests pass')
