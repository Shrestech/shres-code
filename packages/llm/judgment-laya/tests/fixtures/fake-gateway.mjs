// Fake Laya gateway for supervisor and composition tests.
//
// Behavior comes from fake-behavior.json in the working directory:
//   model, manifestSha256, maxSequenceTokens  identity the fake reports
//   readinessDelayMs     delay before the readiness line
//   noReadiness          never print a readiness line (stays alive)
//   readinessLine        raw line printed instead of the computed record
//   exitBeforeReady      exit with this code before any readiness line
//   stderr               text written to stderr before exiting
//   healthStatus         HTTP status for GET /healthz
//   healthModel          model reported by /healthz
//   smokeStatus          HTTP status for the first /v1/judgments request
//   smokeDelayMs         delay before answering the first (smoke) request
//   readinessSplitMs     write the readiness line in two chunks this far apart
//   readinessRaw         write this text with no newline instead of a readiness line
//   crashAfterMs         exit this many ms after the readiness line
//   crashExitCode        exit code used by crashAfterMs (default 1)
//   answerDelayMs        delay before answering judgment requests
//   choice               option id to select for choice questions (default: first)
//   routeProbability     probability given to the selected option (default 1)
//   recordEnvTo          write process.env as JSON to this path at startup
//   recordLaunchesTo     append one line per launch to this path
//   recordRequestsTo     append each judgment request body as one JSON line
//   ignoreSigterm        keep running after SIGTERM (forces SIGKILL escalation)
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const behavior = JSON.parse(readFileSync('fake-behavior.json', 'utf8'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const model = behavior.model
const limits = {
  maxSequenceTokens: behavior.maxSequenceTokens ?? 1024,
  maxHeadTokens: 256,
  maxBatchTokens: (behavior.maxSequenceTokens ?? 1024) * 16,
  manifestSha256: behavior.manifestSha256,
}

if (behavior.recordEnvTo) writeFileSync(behavior.recordEnvTo, JSON.stringify(process.env))
if (behavior.recordLaunchesTo) appendFileSync(behavior.recordLaunchesTo, 'launch\n')
if (behavior.ignoreSigterm) process.on('SIGTERM', () => {})
if (behavior.stderr) process.stderr.write(behavior.stderr + '\n')
if (behavior.exitBeforeReady !== undefined) process.exit(behavior.exitBeforeReady)

function answer(question) {
  if (question.kind === 'binary') return { kind: 'binary', id: question.id, probability: 0.25 }
  if (question.kind === 'choice') {
    const selected = behavior.choice ?? question.options[0].option
    const top = behavior.routeProbability ?? 1
    const rest = (1 - top) / (question.options.length - 1)
    const probabilities = Object.fromEntries(question.options.map(o => [o.option, o.option === selected ? top : rest]))
    return { kind: 'choice', id: question.id, option: selected, probabilities, confidence: top }
  }
  const probabilities = Object.fromEntries(question.levels.map((_l, i) => [String(i), i === 0 ? 1 : 0]))
  return { kind: 'score', id: question.id, score: 0, probabilities, confidence: 1 }
}

function envelope(questions) {
  return { engine: 'shield', model, latencyMs: 1, answers: questions.map(answer) }
}

let judgments = 0
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const send = (status, body) => {
    const data = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
    response.end(data)
  }
  if (request.method === 'GET' && request.url === '/healthz') {
    send(behavior.healthStatus ?? 200, { ok: true, model: behavior.healthModel ?? model, manifestSha256: behavior.manifestSha256 })
    return
  }
  const body = JSON.parse(raw)
  if (behavior.recordRequestsTo) appendFileSync(behavior.recordRequestsTo, JSON.stringify({ path: request.url, body }) + '\n')
  judgments += 1
  if (judgments === 1 && behavior.smokeDelayMs) await sleep(behavior.smokeDelayMs)
  if (judgments === 1 && behavior.smokeStatus !== undefined) {
    send(behavior.smokeStatus, { error: 'smoke refused' })
    return
  }
  if (judgments > 1 && behavior.answerDelayMs) await sleep(behavior.answerDelayMs)
  if (request.url === '/v1/judgments') {
    send(200, envelope(body.questions))
    return
  }
  const sequenceTokens = body.questions.map(() => 10)
  send(200, {
    kind: 'answered',
    fit: {
      selectedIndex: 0,
      stateTokens: 5,
      sequenceTokens,
      paddedTokens: sequenceTokens.length === 0 ? 0 : 10 * sequenceTokens.length,
      limits,
    },
    result: envelope(body.questions),
  })
})

server.listen(0, '127.0.0.1', async () => {
  if (behavior.noReadiness) return
  if (behavior.readinessRaw !== undefined) {
    process.stdout.write(behavior.readinessRaw)
    return
  }
  if (behavior.readinessDelayMs) await sleep(behavior.readinessDelayMs)
  const line = behavior.readinessLine ?? JSON.stringify({
    ready: true,
    port: server.address().port,
    model,
    manifestSha256: behavior.manifestSha256,
    limits,
  })
  if (behavior.readinessSplitMs) {
    process.stdout.write(line.slice(0, 10))
    await sleep(behavior.readinessSplitMs)
    process.stdout.write(line.slice(10) + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
  if (behavior.crashAfterMs !== undefined) {
    setTimeout(() => process.exit(behavior.crashExitCode ?? 1), behavior.crashAfterMs)
  }
})
