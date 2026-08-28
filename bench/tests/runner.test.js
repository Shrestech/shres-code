/**
 * Unit tests for bench/runner: session-log metrics folding, the arm registry
 * and overlay rendering, CLI parsing and plan building, verifier mapping, and
 * the session-log locator. Execution paths — single-session and chain trials,
 * early chain abort, and the arm-integrity audit — run through a fake harness
 * repo: a tsx/esm stand-in plus a fabricated apps/cli bin that writes canned
 * session logs and keys its failure modes off the task text. No API calls.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { ARMS, getArm, listArms, renderArmOverlay, SESSION_QUERY_DRIVER_LINE } from '../runner/arms.js'
import { computeThinDebates, emptyMetrics, foldSessionLog } from '../runner/metrics.js'
import { runSetup } from '../runner/setup.js'
import { runVerifier } from '../runner/verify.js'
import { findSessionLog, resolveHarnessLaunch } from '../runner/execute.js'
import { encodeSegment, isSeededPriorSession, projectKey, SEEDED_PRIOR_SESSION_PREFIX } from '../runner/session-layout.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'
import { createSerialQueue, mapPool } from '../runner/pool.js'
import { pairOutcomes } from '../stats/paired.js'
import {
  assertStuffedCompactionGuard,
  buildPlan,
  isForcedCompactionPatch,
  loadTaskCatalog,
  looksLikeProviderError,
  main,
  matchTaskIds,
  parseArgs,
  readStoredCredential,
  resolveTaskInstruction,
  UsageError,
} from '../runner/run.js'

/** @param {string} prefix @returns {Promise<string>} a fresh temp dir */
async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

describe('metrics.foldSessionLog', () => {
  const fixture = [
    '{"type":"session","version":0,"id":"s1","cwd":"/scratch","createdAt":"2026-08-18T00:00:00Z","delegationDepth":0}',
    '{"type":"step/start","seq":1,"time":1000,"data":{"turn":0,"step":0}}',
    '{"type":"assistant/message","seq":2,"time":2000,"data":{"turn":0,"step":0,"message":{"role":"assistant"},"usage":{"inputTokens":100,"outputTokens":50}}}',
    '{"type":"tool/call","seq":3,"time":2100,"data":{"turn":0,"step":0,"callId":"c1","name":"read_file","arguments":"{\\"a\\":1,\\"b\\":2}"}}',
    // Same call with different key order: one identical retry.
    '{"type":"tool/call","seq":4,"time":2200,"data":{"turn":0,"step":0,"callId":"c2","name":"read_file","arguments":"{\\"b\\":2,\\"a\\":1}"}}',
    '{"type":"tool/call","seq":5,"time":2300,"data":{"turn":0,"step":0,"callId":"c3","name":"jspace_checkpoint","arguments":"{\\"check\\":\\"imports\\"}"}}',
    '{"type":"tool/call","seq":6,"time":2400,"data":{"turn":0,"step":0,"callId":"c4","name":"jspace_ship","arguments":"{}"}}',
    // A packed chunk row: ignored by the fold and by the duration span.
    '{"type":"text-chunks","seq0":7,"time0":2500,"rows":[]}',
    '{"type":"step/end","seq":10,"time":3000,"data":{"turn":0,"step":0}}',
    '{"type":"assistant/message","seq":11,"time":4000,"data":{"turn":0,"step":1,"message":{"role":"assistant"},"usage":{"inputTokens":200,"outputTokens":70,"cacheReadTokens":40}}}',
    '{"type":"step/end","seq":12,"time":5000,"data":{"turn":0,"step":1}}',
    '',
  ].join('\n')

  it('folds turns, tool calls, retries, jspace calls, tokens, and duration', () => {
    const result = foldSessionLog(fixture)
    assert.equal(result.inputTokens, 300)
    assert.equal(result.outputTokens, 120)
    assert.equal(result.durationMs, 4000)
    assert.equal(result.turns, 2)
    assert.equal(result.toolCalls, 4)
    assert.equal(result.identicalRetries, 1)
    assert.equal(result.checkpoints, 1)
    assert.equal(result.shipPasses, 1)
    assert.equal(result.coverageRefusalThenPad, 0)
    assert.equal(result.noopNoteRefusals, 0)
    assert.equal(result.noteCapRefusals, 0)
    assert.equal(result.danglingCard, false)
    assert.equal(result.sessionQueryCalls, 0)
    assert.equal(result.compactionCount, 0)
    assert.equal(result.pressureFired, false)
  })

  it('counts compaction/end events and ignores other compaction types', () => {
    const log = [
      '{"type":"compaction/start","seq":1,"time":1,"data":{"compactionId":"c1","turn":1}}',
      '{"type":"compaction/summary","seq":2,"time":2,"data":{"compactionId":"c1"}}',
      '{"type":"compaction/end","seq":3,"time":3,"data":{"compactionId":"c1","turn":1}}',
      '{"type":"compaction/prune","seq":4,"time":4,"data":{}}',
      '{"type":"unknown/future","seq":5,"time":5,"data":{}}',
      '{"type":"compaction/end","seq":6,"time":6,"data":{"compactionId":"c2","turn":2,"error":"failed"}}',
    ].join('\n')
    const metrics = foldSessionLog(log)
    assert.equal(metrics.compactionCount, 2)
    assert.equal(metrics.pressureFired, true)
  })

  it('tracks danglingCard from jspace/card and jspace/closed events', () => {
    const open = '{"type":"jspace/card","seq":1,"time":1,"data":{}}'
    const closed = '{"type":"jspace/closed","seq":2,"time":2,"data":{}}'
    assert.equal(foldSessionLog(open + '\n').danglingCard, true)
    assert.equal(foldSessionLog(open + '\n' + closed + '\n').danglingCard, false)
  })

  it('groups unparseable arguments by their raw text', () => {
    const log = [
      '{"type":"tool/call","seq":1,"time":1,"data":{"name":"bash","arguments":"not json {"}}',
      '{"type":"tool/call","seq":2,"time":2,"data":{"name":"bash","arguments":"not json {"}}',
      '{"type":"tool/call","seq":3,"time":3,"data":{"name":"bash","arguments":"different"}}',
    ].join('\n')
    const metrics = foldSessionLog(log)
    assert.equal(metrics.toolCalls, 3)
    assert.equal(metrics.identicalRetries, 1)
    assert.equal(metrics.durationMs, 2)
  })

  it('returns zeros for an empty log', () => {
    const result = foldSessionLog('\n')
    assert.equal(result.inputTokens, 0)
    assert.equal(result.turns, 0)
    assert.equal(result.danglingCard, false)
    assert.equal(result.sessionQueryCalls, 0)
    assert.equal(result.compactionCount, 0)
    assert.equal(result.pressureFired, false)
    assert.equal(result.charterRunFailNamed, false)
    assert.equal(result.emptyCharterRate, 1)
    assert.equal(result.unverifiedShare, null)
    assert.equal(result.echoOkRejectRate, null)
  })

  it('counts session-query tool calls for adoption forensics', () => {
    const log = [
      '{"type":"tool/call","seq":1,"time":1,"data":{"name":"session_search","arguments":"{\\"query\\":\\"origin\\"}"}}',
      '{"type":"tool/call","seq":2,"time":2,"data":{"name":"session_event_read","arguments":"{}"}}',
      '{"type":"tool/call","seq":3,"time":3,"data":{"name":"read_file","arguments":"{}"}}',
    ].join('\n')
    assert.equal(foldSessionLog(log).sessionQueryCalls, 2)
    assert.equal(foldSessionLog(log, { expectsSessionQuery: false, expectsJspace: false }).sessionQueryCalls, null)
  })

  it('sets charterRunFailNamed from a failed checkpoint or ship charter-run', () => {
    const fail = '{"type":"jspace/charter-run","seq":1,"time":1,"data":{"entryId":"e1","phase":"checkpoint","passed":false}}'
    const shipFail = '{"type":"jspace/charter-run","seq":2,"time":2,"data":{"entryId":"e1","phase":"ship","passed":false}}'
    const probeFail = '{"type":"jspace/charter-run","seq":3,"time":3,"data":{"entryId":"e1","phase":"probe","passed":false}}'
    const pass = '{"type":"jspace/charter-run","seq":4,"time":4,"data":{"entryId":"e1","phase":"checkpoint","passed":true}}'
    assert.equal(foldSessionLog(fail + '\n').charterRunFailNamed, true)
    assert.equal(foldSessionLog(shipFail + '\n').charterRunFailNamed, true)
    assert.equal(foldSessionLog(probeFail + '\n').charterRunFailNamed, false)
    assert.equal(foldSessionLog(pass + '\n').charterRunFailNamed, false)
    assert.equal(
      foldSessionLog(fail + '\n', { expectsSessionQuery: false, expectsJspace: false }).charterRunFailNamed,
      null,
    )
  })

  it('sets emptyCharterRate from the last jspace/card charter', () => {
    const empty = '{"type":"jspace/card","seq":1,"time":1,"data":{"charter":[]}}'
    const filled = '{"type":"jspace/card","seq":2,"time":2,"data":{"charter":[{"kind":"check","id":"e1","discrimination":"demonstrated"}]}}'
    const closed = '{"type":"jspace/closed","seq":3,"time":3,"data":{}}'
    assert.equal(foldSessionLog('\n').emptyCharterRate, 1)
    assert.equal(foldSessionLog(empty + '\n').emptyCharterRate, 1)
    assert.equal(foldSessionLog(filled + '\n').emptyCharterRate, 0)
    assert.equal(foldSessionLog(empty + '\n' + filled + '\n').emptyCharterRate, 0)
    assert.equal(foldSessionLog(filled + '\n' + empty + '\n').emptyCharterRate, 1)
    assert.equal(foldSessionLog(filled + '\n' + closed + '\n').emptyCharterRate, 0)
    assert.equal(
      foldSessionLog(empty + '\n', { expectsSessionQuery: false, expectsJspace: false }).emptyCharterRate,
      null,
    )
  })

  it('sets unverifiedShare from last-card check discrimination', () => {
    const mixed = JSON.stringify({
      type: 'jspace/card',
      seq: 1,
      time: 1,
      data: {
        charter: [
          { kind: 'check', id: 'e1', discrimination: 'demonstrated' },
          { kind: 'check', id: 'e2', discrimination: 'unverified' },
          { kind: 'prose', id: 'e3', constraint: 'be kind' },
        ],
      },
    })
    const allDemo = '{"type":"jspace/card","seq":1,"time":1,"data":{"charter":[{"kind":"check","id":"e1","discrimination":"demonstrated"}]}}'
    const proseOnly = '{"type":"jspace/card","seq":1,"time":1,"data":{"charter":[{"kind":"prose","id":"e1"}]}}'
    assert.equal(foldSessionLog(mixed + '\n').unverifiedShare, 0.5)
    assert.equal(foldSessionLog(allDemo + '\n').unverifiedShare, 0)
    assert.equal(foldSessionLog(proseOnly + '\n').unverifiedShare, null)
    assert.equal(foldSessionLog('\n').unverifiedShare, null)
  })

  it('sets echoOkRejectRate from floor refusals on open and charter_amend', () => {
    const openCall = '{"type":"tool/call","seq":1,"time":1,"data":{"callId":"c1","name":"jspace_open","arguments":"{}"}}'
    const openRefuse = '{"type":"tool/result","seq":2,"time":2,"data":{"name":"jspace_open","result":"Error: charter entry \\"e1\\" (qty) is a constant-success command. Write a command that reads a path from `reads`."}}'
    const amendCall = '{"type":"tool/call","seq":3,"time":3,"data":{"callId":"c2","name":"jspace_charter_amend","arguments":"{}"}}'
    const amendOk = '{"type":"tool/result","seq":4,"time":4,"data":{"name":"jspace_charter_amend","result":"Amended."}}'
    const noRead = '{"type":"tool/result","seq":5,"time":5,"data":{"name":"jspace_open","result":"JSPACE_CHARTER_NO_READ: charter entry \\"e1\\" names no workspace read"}}'
    const durable = JSON.stringify({
      type: 'tool/result',
      seq: 6,
      time: 6,
      data: {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            isError: true,
            content: [{ type: 'text', text: 'Error: charter entry "e1" (qty) is a constant-success command.' }],
          }],
        },
      },
    })
    assert.equal(foldSessionLog([openCall, openRefuse].join('\n')).echoOkRejectRate, 1)
    assert.equal(foldSessionLog([openCall, openRefuse, amendCall, amendOk].join('\n')).echoOkRejectRate, 0.5)
    assert.equal(foldSessionLog([openCall, noRead].join('\n')).echoOkRejectRate, 1)
    assert.equal(foldSessionLog([openCall, durable].join('\n')).echoOkRejectRate, 1)
    assert.equal(foldSessionLog(openCall + '\n').echoOkRejectRate, null)
    assert.equal(
      foldSessionLog([openCall, openRefuse].join('\n'), { expectsSessionQuery: false, expectsJspace: false }).echoOkRejectRate,
      null,
    )
  })

  it('throws with the line number on corrupt JSON', () => {
    assert.throws(() => foldSessionLog('{"type":"session"}\nnot json\n'), /line 2/)
  })

  it('folds researcher integrity metrics from a research session log', () => {
    const metrics = foldSessionLog([
      // Design-defense refusal on a gated tool.
      '{"type":"tool/call","seq":1,"time":1,"data":{"callId":"c0","name":"experiment_log_run","arguments":"{}"}}',
      '{"type":"tool/result","seq":2,"time":2,"data":{"name":"experiment_log_run","result":"Error: research protocol requires a design defense before logging a run: completed calls missing for: aegis, ward"}}',
      // A completed debate pair: aegis and ward each with a non-error result.
      '{"type":"tool/call","seq":3,"time":3,"data":{"callId":"a1","name":"aegis","arguments":"{}"}}',
      '{"type":"tool/result","seq":4,"time":4,"data":{"name":"aegis","result":"aegis report: the mean is below the bound"}}',
      '{"type":"tool/call","seq":5,"time":5,"data":{"callId":"w1","name":"ward","arguments":"{}"}}',
      '{"type":"tool/result","seq":6,"time":6,"data":{"name":"ward","result":"ward report: I agree, reject"}}',
      // A run lands and a verify call is satisfied.
      '{"type":"tool/call","seq":7,"time":7,"data":{"callId":"r1","name":"experiment_log_run","arguments":"{}"}}',
      '{"type":"tool/result","seq":8,"time":8,"data":{"name":"experiment_log_run","result":"Logged experiment run r-123."}}',
      '{"type":"tool/call","seq":9,"time":9,"data":{"callId":"v1","name":"experiment_verify_decision_rule","arguments":"{}"}}',
      '{"type":"tool/result","seq":10,"time":10,"data":{"name":"experiment_verify_decision_rule","result":"Decision rule satisfied: share > 0.6 (actual 0.7)"}}',
      '{"type":"tool/result","seq":11,"time":11,"data":{"name":"ledger_record_decision","result":"Decision L1 was not recorded (reason: unverified-run)."}}',
      '{"type":"ledger/decision","seq":12,"time":12,"data":{"entryId":"L1","hypothesis":"h","decision":"rejected","runIds":["r-123"]}}',
      '{"type":"ledger/decision","seq":13,"time":13,"data":{"entryId":"L2","hypothesis":"h","decision":"deferred","runIds":[]}}',
    ].join('\n'), { expectsResearcher: true, expectsJspace: true })
    assert.equal(metrics.gateRefusals, 1)
    assert.equal(metrics.debateCalls, 1)
    assert.equal(metrics.runsLogged, 1)
    assert.equal(metrics.verifySatisfiedRate, 1)
    assert.equal(metrics.unverifiedRunRefusals, 1)
    assert.deepEqual(metrics.ledgerDecisions, { accepted: 0, rejected: 1, deferred: 1 })
    assert.equal(metrics.deferredShare, 0.5)
    assert.equal(metrics.ledgerAbandoned, false)
    assert.equal(metrics.unverifiedAcceptRecovery, true)
  })

  it('nulls researcher integrity metrics for arms without the researcher surface', () => {
    const metrics = foldSessionLog('{"type":"tool/call","seq":1,"time":1,"data":{"name":"aegis","arguments":"{}"}}\n', { expectsResearcher: false })
    assert.equal(metrics.gateRefusals, null)
    assert.equal(metrics.debateCalls, null)
    assert.equal(metrics.runsLogged, null)
    assert.equal(metrics.verifySatisfiedRate, null)
    assert.equal(metrics.unverifiedRunRefusals, null)
    assert.equal(metrics.ledgerDecisions, null)
    assert.equal(metrics.deferredShare, null)
    assert.equal(metrics.ledgerAbandoned, null)
    assert.equal(metrics.unverifiedAcceptRecovery, null)
    assert.equal(metrics.thinDebates, null)
  })

  it('counts completed debate pairs per Goal epoch', () => {
    const metrics = foldSessionLog([
      // Epoch 0 (before any card): one aegis call, no ward call -> 0 pairs.
      '{"type":"tool/call","seq":1,"time":1,"data":{"callId":"a1","name":"aegis","arguments":"{}"}}',
      '{"type":"tool/result","seq":2,"time":2,"data":{"name":"aegis","result":"ok"}}',
      // Open a goal epoch (goalOpenedSeq 10).
      '{"type":"jspace/card","seq":10,"time":10,"data":{"goalOpenedSeq":10,"goal":"g"}}',
      // Epoch 10: two aegis calls, one ward call -> 1 pair.
      '{"type":"tool/call","seq":11,"time":11,"data":{"callId":"a2","name":"aegis","arguments":"{}"}}',
      '{"type":"tool/result","seq":12,"time":12,"data":{"name":"aegis","result":"ok"}}',
      '{"type":"tool/call","seq":13,"time":13,"data":{"callId":"a3","name":"aegis","arguments":"{}"}}',
      '{"type":"tool/result","seq":14,"time":14,"data":{"name":"aegis","result":"ok"}}',
      '{"type":"tool/call","seq":15,"time":15,"data":{"callId":"w1","name":"ward","arguments":"{}"}}',
      '{"type":"tool/result","seq":16,"time":16,"data":{"name":"ward","result":"ok"}}',
      // An errored aegis result does not count as completed.
      '{"type":"tool/call","seq":17,"time":17,"data":{"callId":"a4","name":"aegis","arguments":"{}"}}',
      JSON.stringify({ type: 'tool/result', seq: 18, time: 18, data: { message: { source: { kind: 'tool', callId: 'a4' }, content: [{ type: 'tool-result', toolCallId: 'a4', isError: true, content: [{ type: 'text', text: 'boom' }] }] } } }),
    ].join('\n'), { expectsResearcher: true, expectsJspace: true })
    assert.equal(metrics.debateCalls, 1)
  })

  it('computes thinDebates from descendant seat-token volume', async () => {
    const root = await tempDir('bench-thin-')
    try {
      const rootLog = '{"type":"tool/call","seq":1,"time":100,"data":{"callId":"a1","name":"aegis","arguments":"{}"}}\n{"type":"tool/call","seq":2,"time":200,"data":{"callId":"w1","name":"ward","arguments":"{}"}}\n'
      // A descendant bucketed to the aegis call (createdAt 150 <= 200) with 120 tokens.
      const childA = join(root, 'childA')
      await mkdir(childA, { recursive: true })
      const childAHeader = JSON.stringify({ type: 'session', id: 'childA', createdAt: 150, parentSession: 'root', origin: 'subagent' })
      await writeFile(join(childA, 'session.jsonl'), childAHeader + '\n{"type":"assistant/message","time":160,"data":{"usage":{"inputTokens":100,"outputTokens":20}}}\n')
      // Combined aegis+ward tokens (120) sit under the thinDebates floor -> thin.
      assert.equal(await computeThinDebates(root, rootLog), 1)
      // A ward-bucketed descendant (createdAt 250) with 550 tokens pushes the
      // pair over the floor -> not thin.
      const childW = join(root, 'childW')
      await mkdir(childW, { recursive: true })
      const childWHeader = JSON.stringify({ type: 'session', id: 'childW', createdAt: 250, parentSession: 'root', origin: 'subagent' })
      await writeFile(join(childW, 'session.jsonl'), childWHeader + '\n{"type":"assistant/message","time":260,"data":{"usage":{"inputTokens":500,"outputTokens":50}}}\n')
      assert.equal(await computeThinDebates(root, rootLog), 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('arms registry', () => {
  it('registers the jspace ladder and the OOLONG-lite arms in order', () => {
    assert.deepEqual(
      listArms(),
      ['off', 'on', 'sq-only', 'sq-driver', 'on-sq', 'on-sq-verified', 'on-adaptive', 'on-core', 'on-charter', 'stuffed', 'read', 'code', 'research-inert', 'research-lite', 'research-on'],
    )
    assert.equal(ARMS.off.jspace.enabled, false)
    assert.equal(ARMS.on.jspace.enabled, true)
    assert.equal(ARMS.on.jspace.mode, 'available')
    assert.equal(ARMS['on-sq-verified'].jspace.requireVerifiedEvidence, true)
    assert.deepEqual(ARMS['on-sq-verified'].jspace.verifierTools, ['bash'])
    assert.equal(ARMS['on-adaptive'].jspace.enabled, true)
    assert.equal(ARMS['on-adaptive'].jspace.engageAfterSteps, 10)
    assert.equal(ARMS.on.jspace.engageAfterSteps, undefined)
    assert.deepEqual(ARMS['on-core'].jspace, ARMS.on.jspace)
    assert.equal(ARMS['on-core'].toolJspace.requireCoreOnOpen, true)
    assert.equal(ARMS['on-core'].toolJspace.requireCoreForShip, true)
    assert.deepEqual(ARMS['on-charter'].jspace, ARMS.on.jspace)
    assert.deepEqual(ARMS['on-charter'].toolJspace, {
      requireCharter: true,
      requireExecutableCharter: true,
      charterSeed: true,
      charterDiscrimination: 'required',
      charterCheckTimeoutMs: 30_000,
      maxCharterEntries: 12,
      charterChecksMustBeReadOnly: true,
    })
    assert.equal(ARMS.on.toolJspace, undefined)
    assert.equal(getArm('off'), ARMS.off)
  })

  it('session-query mounting matches arm semantics', () => {
    assert.equal(ARMS.off.sessionQuery, false)
    assert.equal(ARMS.on.sessionQuery, false)
    assert.equal(ARMS['sq-only'].sessionQuery, true)
    assert.equal(ARMS['sq-driver'].sessionQuery, true)
    assert.equal(ARMS['on-sq'].sessionQuery, true)
    assert.equal(ARMS['on-sq-verified'].sessionQuery, true)
    assert.equal(ARMS['on-adaptive'].sessionQuery, true)
    assert.equal(ARMS['on-core'].sessionQuery, false)
    assert.equal(ARMS['on-charter'].sessionQuery, false)
    assert.equal(ARMS.stuffed.sessionQuery, false)
    assert.equal(ARMS.read.sessionQuery, true)
    assert.equal(ARMS.code.sessionQuery, true)
  })

  it('expectsJspace and expectsSessionQuery match arm semantics', () => {
    assert.equal(ARMS.off.expectsJspace, false)
    assert.equal(ARMS.off.expectsSessionQuery, false)
    assert.equal(ARMS.on.expectsJspace, true)
    assert.equal(ARMS.on.expectsSessionQuery, false)
    assert.equal(ARMS['sq-only'].expectsJspace, false)
    assert.equal(ARMS['sq-only'].expectsSessionQuery, true)
    assert.equal(ARMS['sq-driver'].expectsJspace, false)
    assert.equal(ARMS['sq-driver'].expectsSessionQuery, true)
    assert.equal(ARMS['sq-driver'].driverLine, true)
    assert.equal(ARMS['sq-only'].driverLine, undefined)
    assert.equal(ARMS['on-sq'].expectsJspace, true)
    assert.equal(ARMS['on-sq'].expectsSessionQuery, true)
    // Permission, not a requirement: a trial that never reaches step 10 logs
    // no jspace event and the audit records no violation.
    assert.equal(ARMS['on-adaptive'].expectsJspace, true)
    assert.equal(ARMS['on-adaptive'].expectsSessionQuery, true)
    assert.equal(ARMS['on-core'].expectsJspace, true)
    assert.equal(ARMS['on-core'].expectsSessionQuery, false)
    assert.equal(ARMS['on-charter'].expectsJspace, true)
    assert.equal(ARMS['on-charter'].expectsSessionQuery, false)
    assert.equal(ARMS.stuffed.expectsJspace, false)
    assert.equal(ARMS.stuffed.expectsSessionQuery, false)
    assert.equal(ARMS.stuffed.stuffed, true)
    assert.equal(ARMS.read.expectsJspace, false)
    assert.equal(ARMS.read.expectsSessionQuery, true)
    assert.equal(ARMS.code.expectsJspace, false)
    assert.equal(ARMS.code.expectsSessionQuery, true)
    assert.equal(ARMS.code.codeMode, true)
    assert.equal(ARMS.read.codeMode, undefined)
  })

  it('renders the constraint-capture requirements into the on-core overlay', () => {
    const overlay = renderArmOverlay(ARMS['on-core'], {
      sessionLogRoot: '/tmp/bench/on-core/sessions/t/0',
    })
    assert.match(overlay, /^- id: tool-jspace$/m)
    assert.match(overlay, /requireCoreOnOpen: true/)
    assert.match(overlay, /requireCoreForShip: true/)
    assert.doesNotMatch(overlay, /tool-session-query/)
    assert.doesNotMatch(
      renderArmOverlay(ARMS.on, { sessionLogRoot: '/x' }),
      /^- id: tool-jspace$/m,
    )
  })

  it('renders the executor-enforced charter requirements into the on-charter overlay', () => {
    const overlay = renderArmOverlay(ARMS['on-charter'], {
      sessionLogRoot: '/tmp/bench/on-charter/sessions/t/0',
    })
    assert.match(overlay, /^- id: jspace$/m)
    assert.match(overlay, /enabled: true/)
    assert.match(overlay, /mode: "available"/)
    assert.match(overlay, /requireCoverage: true/)
    assert.match(overlay, /^- id: tool-jspace$/m)
    assert.match(overlay, /requireCharter: true/)
    assert.match(overlay, /requireExecutableCharter: true/)
    assert.match(overlay, /charterSeed: true/)
    assert.match(overlay, /charterDiscrimination: "required"/)
    assert.match(overlay, /charterCheckTimeoutMs: 30000/)
    assert.match(overlay, /maxCharterEntries: 12/)
    assert.match(overlay, /charterChecksMustBeReadOnly: true/)
    assert.doesNotMatch(overlay, /tool-session-query/)
    assert.doesNotMatch(overlay, /session-query/)
    assert.doesNotMatch(overlay, /requireCoreOnOpen/)
  })

  it('renders the engagement threshold into the on-adaptive overlay', () => {
    const overlay = renderArmOverlay(ARMS['on-adaptive'], {
      sessionLogRoot: '/tmp/bench/on-adaptive/sessions/t/0',
    })
    assert.match(overlay, /engageAfterSteps: 10/)
    assert.match(overlay, /- id: tool-session-query$/m)
  })

  it('renders the session-query driver line only on sq-driver', () => {
    const driver = renderArmOverlay(ARMS['sq-driver'], { sessionLogRoot: '/tmp/bench/sq-driver/sessions/t/0' })
    assert.match(driver, /^- id: system-prompt$/m)
    assert.match(driver, /session_search/)
    assert.ok(driver.includes(JSON.stringify(SESSION_QUERY_DRIVER_LINE).slice(1, -1)))
    assert.match(driver, /- id: tool-session-query$/m)
    const baseline = renderArmOverlay(ARMS['sq-only'], { sessionLogRoot: '/x' })
    assert.doesNotMatch(baseline, /^- id: system-prompt$/m)
    assert.ok(!baseline.includes('session_search or session_event_search'))
    assert.match(driver, /You are a coding agent powered by the \{\{model\}\} model/)
  })

  it('fails loud on unknown arms, naming the valid set', () => {
    assert.throws(() => getArm('always-open'), /unknown arm "always-open"/)
  })

  it('renders a patch overlay with jspace config, log root, and session-query mount', () => {
    const onSq = renderArmOverlay(ARMS['on-sq'], { sessionLogRoot: '/tmp/bench/on-sq/sessions/t/0' })
    assert.match(onSq, /^- id: jspace$/m)
    assert.match(onSq, /enabled: true/)
    assert.match(onSq, /mode: "available"/)
    assert.match(onSq, /requireCoverage: true/)
    assert.match(onSq, /^- id: session-persistence-jsonl$/m)
    assert.match(onSq, /compression: none/)
    assert.match(onSq, /^- id: session-query-sqlite$/m)
    assert.match(onSq, /openAt: startup/)
    assert.match(onSq, /session-query\.db/)
    assert.match(onSq, /^- insert:$/m)
    assert.match(onSq, /tool-session-query/)

    const off = renderArmOverlay(ARMS.off, { sessionLogRoot: '/x' })
    assert.match(off, /enabled: false/)
    assert.ok(!off.includes('session-query'), 'off arm leaves session-query untouched')
    assert.ok(!off.includes('insert'), 'off arm inserts nothing')
  })

  it('renders the researcher surface and per-trial persistence into a research arm overlay', () => {
    const root = '/tmp/bench/research-on/sessions/t/0'
    const overlay = renderArmOverlay(ARMS['research-on'], { sessionLogRoot: root })
    // research-protocol is INSERTED (the base headless composition does not
    // mount it); a patch row against a missing entry no-ops silently.
    assert.match(overlay, /^- insert:$/m)
    assert.match(overlay, /^    - id: research-protocol$/m)
    assert.match(overlay, /"@shres-code\/shres-code-research-protocol"/)
    assert.match(overlay, /enabled: true/)
    assert.match(overlay, /requireDesignDefense: "per-epoch"/)
    assert.match(overlay, /tracker\.invalid/)
    assert.match(overlay, /research-spool\.jsonl/)
    assert.match(overlay, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/research-spool.jsonl'))
    assert.match(overlay, /^\s*- id: tool-tracker$/m)
    assert.match(overlay, /^\s*- id: ledger$/m)
    assert.match(overlay, /research-ledger\.jsonl/)
    assert.match(overlay, /^\s*- id: tool-ledger$/m)
    assert.match(overlay, /^\s*- id: tool-subagent-aegis$/m)
    assert.match(overlay, /toolName: aegis/)
    assert.match(overlay, /^\s*- id: tool-subagent-ward$/m)
    assert.match(overlay, /toolName: ward/)
    assert.match(overlay, /^\s*- id: tool-subagent-stride$/m)
    assert.match(overlay, /toolName: stride/)
    assert.match(overlay, /provider: spawn/)
    // Fork seats are one-shot; the spawn seat is continuable, mirroring the
    // base headless tool-subagent / tool-subagent-fork rows.
    assert.match(overlay, /provider: fork\n\s+toolName: aegis\n\s+backgroundMode: one-shot/)
    assert.match(overlay, /provider: spawn\n\s+toolName: stride\n\s+backgroundMode: continuable/)
    // research-on carries the on-sq-verified jspace verifier extras.
    assert.match(overlay, /verifierTools/)
    assert.match(overlay, /experiment_verify_decision_rule/)
    assert.match(overlay, /requireVerifiedEvidence: true/)
  })

  it('renders stuffed without session-query or code-mode', () => {
    const overlay = renderArmOverlay(ARMS.stuffed, { sessionLogRoot: '/tmp/bench/stuffed/sessions/t/0' })
    assert.match(overlay, /enabled: false/)
    assert.doesNotMatch(overlay, /tool-session-query/)
    assert.doesNotMatch(overlay, /^- id: tools$/m)
    assert.doesNotMatch(overlay, /mode: "both"/)
  })

  it('renders read like sq-only: session-query mounted, jspace off', () => {
    const overlay = renderArmOverlay(ARMS.read, { sessionLogRoot: '/tmp/bench/read/sessions/t/0' })
    assert.match(overlay, /enabled: false/)
    assert.match(overlay, /- id: tool-session-query$/m)
    assert.match(overlay, /openAt: startup/)
    assert.doesNotMatch(overlay, /^- id: tools$/m)
  })

  it('renders code as read plus tools.mode both, without re-inserting code-runtime', () => {
    const overlay = renderArmOverlay(ARMS.code, { sessionLogRoot: '/tmp/bench/code/sessions/t/0' })
    assert.match(overlay, /enabled: false/)
    assert.match(overlay, /- id: tool-session-query$/m)
    assert.match(overlay, /^- id: tools$/m)
    assert.match(overlay, /mode: "both"/)
    assert.doesNotMatch(overlay, /code-runtime/)
  })
})

describe('run.parseArgs', () => {
  it('applies defaults', () => {
    const options = parseArgs(['--experiment', 'w0'])
    assert.equal(options.experiment, 'w0')
    assert.deepEqual(options.arms, listArms())
    assert.equal(options.repeats, 3)
    assert.equal(options.taskGlob, null)
    assert.equal(options.dryRun, false)
    assert.equal(options.apiKeyEnv, 'DEEPSEEK_API_KEY')
    assert.deepEqual(options.tierPatches, [])
    assert.equal(options.concurrency, 1)
  })

  it('parses every flag', () => {
    const options = parseArgs([
      '--experiment', 'w1',
      '--arms', 'on,off',
      '--repeats', '5',
      '--tasks', 'multi-*',
      '--model', 'deepseek-v4-pro',
      '--temperature', '0.2',
      '--base-url', 'https://example.test',
      '--api-key-env', 'ZAI_API_KEY',
      '--tier-patch', 'bench/tiers/zai.patch.yml',
      '--concurrency', '4',
      '--dry-run',
    ])
    assert.deepEqual(options.arms, ['on', 'off'])
    assert.equal(options.repeats, 5)
    assert.equal(options.taskGlob, 'multi-*')
    assert.equal(options.model, 'deepseek-v4-pro')
    assert.equal(options.temperature, 0.2)
    assert.equal(options.baseUrl, 'https://example.test')
    assert.equal(options.apiKeyEnv, 'ZAI_API_KEY')
    assert.deepEqual(options.tierPatches, ['bench/tiers/zai.patch.yml'])
    assert.equal(options.concurrency, 4)
    assert.equal(options.dryRun, true)
  })

  it('accepts repeatable --tier-patch in given order', () => {
    const options = parseArgs([
      '--experiment', 'w1',
      '--arms', 'off,on',
      '--tier-patch', 'bench/tiers/zai.patch.yml',
      '--tier-patch', 'bench/pressure/forced-compaction.patch.yml',
    ])
    assert.deepEqual(options.tierPatches, [
      'bench/tiers/zai.patch.yml',
      'bench/pressure/forced-compaction.patch.yml',
    ])
  })

  it('refuses stuffed together with the forced-compaction overlay', () => {
    assert.throws(
      () => parseArgs([
        '--experiment', 'x',
        '--arms', 'stuffed',
        '--tier-patch', 'bench/pressure/forced-compaction.patch.yml',
      ]),
      /stuffed arm \(stuffed\) cannot combine with the forced-compaction overlay.*whole-corpus-in-the-prompt/,
    )
    assert.throws(
      () => parseArgs([
        '--experiment', 'x',
        '--arms', 'read,stuffed,code',
        '--tier-patch', 'bench/tiers/zai.patch.yml',
        '--tier-patch', 'bench/pressure/forced-compaction.patch.yml',
      ]),
      /stuffed arm \(stuffed\).*forced-compaction/,
    )
    assert.throws(
      () => parseArgs([
        '--experiment', 'x',
        '--tier-patch', 'bench/pressure/forced-compaction.patch.yml',
      ]),
      /stuffed arm/,
    )
    const ok = parseArgs([
      '--experiment', 'x',
      '--arms', 'read,code',
      '--tier-patch', 'bench/pressure/forced-compaction.patch.yml',
    ])
    assert.deepEqual(ok.arms, ['read', 'code'])
    assert.equal(isForcedCompactionPatch('bench/pressure/forced-compaction.patch.yml'), true)
    assert.equal(isForcedCompactionPatch('bench/tiers/zai.patch.yml'), false)
    assert.doesNotThrow(() => assertStuffedCompactionGuard({ arms: ['off'], tierPatches: ['bench/pressure/forced-compaction.patch.yml'] }))
  })

  it('accepts --api-key-env none for keyless tiers', () => {
    const options = parseArgs(['--experiment', 'w2', '--api-key-env', 'none'])
    assert.equal(options.apiKeyEnv, 'none')
  })

  it('rejects malformed invocations', () => {
    assert.throws(() => parseArgs([]), /--experiment is required/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--bogus']), /unknown argument "--bogus"/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--repeats', '0']), /positive integer/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--repeats', 'abc']), /positive integer/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--concurrency', '0']), /integer >= 1/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--concurrency', '-1']), /integer >= 1/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--concurrency', '1.5']), /integer >= 1/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--concurrency', 'abc']), /integer >= 1/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--concurrency']), /needs a value/)
    assert.throws(() => parseArgs(['--experiment', 'x', '--arms', 'on,nope']), /unknown arm "nope"/)
    assert.throws(() => parseArgs(['--experiment']), /needs a value/)
    assert.throws(() => parseArgs(['--experiment', 'a/b']), /plain directory name/)
  })

  it('treats --help as a flag, not an error', () => {
    assert.equal(parseArgs(['--help']).help, true)
  })
})

describe('pressure overlay', () => {
  it('exists as a YAML list patching compaction-basic', () => {
    const overlayPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'pressure', 'forced-compaction.patch.yml')
    const text = readFileSync(overlayPath, 'utf8')
    assert.match(text, /^- id: compaction-basic$/m)
    assert.match(text, /^\s+auto: true$/m)
    assert.match(text, /^\s+thresholdRatio: 0\.015$/m)
    assert.match(text, /^\s+retainRatio: 0\.003$/m)
    assert.match(text, /^\s+maxTokens: 8192$/m)
    assert.match(text, /^\s+compactionRetries: 1$/m)
    assert.match(text, /^\s+maxOverflowRetries: 1$/m)
  })
})

describe('schema compaction fields', () => {
  /**
   * @param {Record<string, unknown>} [metrics]
   * @returns {import('../schema/trial.js').Trial}
   */
  function trial(metrics = {}) {
    return {
      taskId: 'task-a',
      trialIndex: 0,
      arm: 'off',
      status: 'success',
      resolved: true,
      failureMode: null,
      verifier: { command: 'node verify.mjs', exitCode: 0 },
      metrics: {
        inputTokens: 100, outputTokens: 50, durationMs: 1000, turns: 4,
        toolCalls: 3, identicalRetries: 0, checkpoints: 0, shipPasses: 0,
        tokensIncludingDescendants: null, costIncludingDescendants: null, descendantSessions: 0, outOfLoopExperiments: 0,
        danglingCard: null, verifiedCheckpointShare: null,
        coverageRefusalThenPad: 0, noopNoteRefusals: 0, noteCapRefusals: 0,
        sessionQueryCalls: null,
        compactionCount: 1,
        pressureFired: true,
        gateRefusals: null, debateCalls: null, runsLogged: null, verifySatisfiedRate: null, unverifiedRunRefusals: null,
        ledgerDecisions: null, deferredShare: null, ledgerAbandoned: null, unverifiedAcceptRecovery: null, thinDebates: null,
        ...metrics,
      },
      sessionFile: null,
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:00:01.000Z',
    }
  }

  it('accepts compactionCount and pressureFired', () => {
    validateTrial(trial())
    validateTrial(trial({ compactionCount: 0, pressureFired: false }))
  })

  it('rejects a wrong-typed compactionCount or pressureFired', () => {
    assert.throws(() => validateTrial(trial({ compactionCount: '1' })), /compactionCount must be a non-negative number/)
    assert.throws(() => validateTrial(trial({ pressureFired: 1 })), /pressureFired must be a boolean/)
  })

  it('accepts an empty tierPatches array and rejects a non-array', () => {
    const manifest = {
      version: 1,
      experiment: 'w0',
      arm: 'off',
      armConfig: { enabled: false },
      model: 'deepseek-chat',
      baseUrl: null,
      temperature: 0,
      repeats: 1,
      taskIds: ['a'],
      gitCommit: 'deadbeef',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      tierPatches: [],
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:00:01.000Z',
    }
    validateRunManifest(manifest)
    assert.throws(
      () => validateRunManifest({ ...manifest, tierPatches: null }),
      /tierPatches must be an array/,
    )
  })
})

describe('run.matchTaskIds', () => {
  const ids = ['multi-file-rename', 'single-function-fix', 'injection-ignore']

  it('keeps the catalog order and supports * and ?', () => {
    assert.deepEqual(matchTaskIds(ids, null), ids)
    assert.deepEqual(matchTaskIds(ids, '*'), ids)
    assert.deepEqual(matchTaskIds(ids, 'multi-*'), ['multi-file-rename'])
    assert.deepEqual(matchTaskIds(ids, '*-fix'), ['single-function-fix'])
    assert.deepEqual(matchTaskIds(ids, 'injection-ignor?'), ['injection-ignore'])
    assert.deepEqual(matchTaskIds(ids, 'nomatch'), [])
  })

  it('treats a comma-separated list as the union of globs', () => {
    assert.deepEqual(
      matchTaskIds(ids, 'multi-*,*-fix'),
      ['multi-file-rename', 'single-function-fix'],
    )
    assert.deepEqual(
      matchTaskIds(ids, ' injection-ignor? , multi-* '),
      ['multi-file-rename', 'injection-ignore'],
    )
    assert.deepEqual(matchTaskIds(ids, 'nomatch,also-missing'), [])
  })
})

describe('run.buildPlan', () => {
  it('interleaves arms inside every (task, trial) pair', () => {
    const plan = buildPlan({ taskIds: ['a', 'b'], arms: ['off', 'on'], repeats: 2 })
    assert.deepEqual(plan, [
      { taskId: 'a', trialIndex: 0, arm: 'off' },
      { taskId: 'a', trialIndex: 0, arm: 'on' },
      { taskId: 'a', trialIndex: 1, arm: 'off' },
      { taskId: 'a', trialIndex: 1, arm: 'on' },
      { taskId: 'b', trialIndex: 0, arm: 'off' },
      { taskId: 'b', trialIndex: 0, arm: 'on' },
      { taskId: 'b', trialIndex: 1, arm: 'off' },
      { taskId: 'b', trialIndex: 1, arm: 'on' },
    ])
  })
})

describe('run.looksLikeProviderError', () => {
  it('matches provider failure signatures only', () => {
    assert.equal(looksLikeProviderError('', 'Error: DeepSeek API returned 429 Too Many Requests'), true)
    assert.equal(looksLikeProviderError('fetch failed', ''), true)
    assert.equal(looksLikeProviderError('', 'everything looked fine until the verifier ran'), false)
  })
})

describe('run.loadTaskCatalog', () => {
  it('loads valid tasks and rejects authoring errors early', async () => {
    const root = await tempDir('bench-runner-catalog-')
    try {
      const taskDir = join(root, 'alpha')
      await mkdir(join(taskDir, 'fixture'), { recursive: true })
      await writeFile(join(taskDir, 'task.json'), JSON.stringify({
        taskId: 'alpha',
        stratum: 'short',
        description: 'a',
        instruction: 'do the thing',
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      const [task] = await loadTaskCatalog(root)
      assert.equal(task.taskId, 'alpha')
      assert.equal(task.timeoutMs, 1000)
      assert.equal(task.setup, null)
      assert.equal(task.stuffedInstruction, null)
      assert.equal(task.armInstructions, null)

      const badDir = join(root, 'bad')
      await mkdir(badDir, { recursive: true })
      await writeFile(join(badDir, 'task.json'), JSON.stringify({
        taskId: 'not-the-dir',
        instruction: 'x',
        verify: 'node verify.mjs',
        timeoutMs: 1,
      }))
      await assert.rejects(() => loadTaskCatalog(root), /taskId must equal the directory name/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads stuffedInstruction and armInstructions and resolveTaskInstruction selects them', async () => {
    const root = await tempDir('bench-runner-stuffed-')
    try {
      const taskDir = join(root, 'oolong')
      await mkdir(join(taskDir, 'fixture'), { recursive: true })
      await writeFile(join(taskDir, 'task.json'), JSON.stringify({
        taskId: 'oolong',
        stratum: 'long',
        description: 'd',
        instruction: 'on disk',
        stuffedInstruction: 'inline corpus',
        armInstructions: { read: 'read cue', code: 'code cue', stuffed: 'stuffed cue' },
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      const [task] = await loadTaskCatalog(root)
      assert.equal(task.instruction, 'on disk')
      assert.equal(task.stuffedInstruction, 'inline corpus')
      assert.deepEqual(task.armInstructions, { read: 'read cue', code: 'code cue', stuffed: 'stuffed cue' })
      assert.equal(resolveTaskInstruction(task, ARMS.stuffed), 'stuffed cue')
      assert.equal(resolveTaskInstruction(task, ARMS.read), 'read cue')
      assert.equal(resolveTaskInstruction(task, ARMS.code), 'code cue')
      assert.equal(resolveTaskInstruction(task, ARMS.off), 'on disk')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolveTaskInstruction uses stuffedInstruction when armInstructions omit the stuffed arm', async () => {
    const task = {
      taskId: 'x',
      instruction: 'on disk',
      stuffedInstruction: 'inline',
      armInstructions: null,
      phases: null,
      verify: 'node verify.mjs',
      setup: null,
      timeoutMs: 1,
      dir: '/tmp',
    }
    assert.equal(resolveTaskInstruction(task, ARMS.stuffed), 'inline')
    assert.equal(resolveTaskInstruction(task, ARMS.read), 'on disk')
  })

  it('parses a chain task: phases with per-phase timeout overrides, no top-level instruction', async () => {
    const root = await tempDir('bench-runner-chain-catalog-')
    try {
      const taskDir = join(root, 'omega')
      await mkdir(join(taskDir, 'fixture'), { recursive: true })
      await writeFile(join(taskDir, 'task.json'), JSON.stringify({
        taskId: 'omega',
        stratum: 'chain',
        description: 'chain task',
        phases: [
          { instruction: 'phase one' },
          { instruction: 'phase two', timeoutMs: 5000 },
          { instruction: 'phase three' },
        ],
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      const [task] = await loadTaskCatalog(root)
      assert.equal(task.instruction, null)
      assert.deepEqual(task.phases, [
        { instruction: 'phase one', timeoutMs: null },
        { instruction: 'phase two', timeoutMs: 5000 },
        { instruction: 'phase three', timeoutMs: null },
      ])
      assert.equal(task.timeoutMs, 1000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parses optional setup and rejects an empty setup string', async () => {
    const root = await tempDir('bench-runner-setup-catalog-')
    try {
      const taskDir = join(root, 'plant')
      await mkdir(join(taskDir, 'fixture'), { recursive: true })
      await writeFile(join(taskDir, 'task.json'), JSON.stringify({
        taskId: 'plant',
        stratum: 'pressure',
        description: 'plant',
        instruction: 'continue',
        setup: 'node setup.mjs',
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      const [task] = await loadTaskCatalog(root)
      assert.equal(task.setup, 'node setup.mjs')

      await writeFile(join(taskDir, 'task.json'), JSON.stringify({
        taskId: 'plant',
        instruction: 'continue',
        setup: '   ',
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      await assert.rejects(() => loadTaskCatalog(root), /setup must be a non-empty string/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails loud on malformed chain tasks before any trial starts', async () => {
    const cases = [
      {
        name: 'top-level instruction alongside phases',
        definition: { instruction: 'nope', phases: [{ instruction: 'a' }, { instruction: 'b' }] },
        pattern: /instruction is not allowed when phases is present/,
      },
      {
        name: 'fewer than two phases',
        definition: { phases: [{ instruction: 'a' }] },
        pattern: /phases must be an array of at least 2 phases/,
      },
      {
        name: 'phases not an array',
        definition: { phases: 'two of them' },
        pattern: /phases must be an array of at least 2 phases/,
      },
      {
        name: 'phase that is not a record',
        definition: { phases: [{ instruction: 'a' }, null] },
        pattern: /phases\[1\] must be a record/,
      },
      {
        name: 'phase without an instruction',
        definition: { phases: [{ instruction: 'a' }, { instruction: '  ' }] },
        pattern: /phases\[1\]\.instruction must be a non-empty string/,
      },
      {
        name: 'phase with a bad timeoutMs',
        definition: { phases: [{ instruction: 'a' }, { instruction: 'b', timeoutMs: 0 }] },
        pattern: /phases\[1\]\.timeoutMs must be a positive integer/,
      },
      {
        name: 'single-session task without instruction',
        definition: {},
        pattern: /instruction must be a non-empty string/,
      },
    ]
    for (const { name, definition, pattern } of cases) {
      const root = await tempDir('bench-runner-chain-bad-')
      try {
        const taskDir = join(root, 'gamma')
        await mkdir(join(taskDir, 'fixture'), { recursive: true })
        await writeFile(join(taskDir, 'task.json'), JSON.stringify({
          taskId: 'gamma',
          verify: 'node verify.mjs',
          timeoutMs: 1000,
          ...definition,
        }))
        await assert.rejects(() => loadTaskCatalog(root), pattern, name)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})

describe('run.main --dry-run', () => {
  /** @param {string} root */
  async function writeTask(root, taskId) {
    const dir = join(root, 'tasks', taskId)
    await mkdir(join(dir, 'fixture'), { recursive: true })
    await writeFile(join(dir, 'task.json'), JSON.stringify({
      taskId,
      stratum: 'short',
      description: taskId,
      instruction: `instruction for ${taskId}`,
      verify: 'node verify.mjs',
      timeoutMs: 1000,
    }))
  }

  it('prints the interleaved plan and writes nothing', async () => {
    const benchRoot = await tempDir('bench-runner-dry-')
    try {
      await writeTask(benchRoot, 'alpha')
      await writeTask(benchRoot, 'beta')
      /** @type {string[]} */
      const lines = []
      const code = await main(
        ['--experiment', 'demo', '--repeats', '2', '--tasks', 'a*', '--arms', 'off,on', '--dry-run'],
        { benchRoot, env: {}, print: line => lines.push(line) },
      )
      assert.equal(code, 0)
      assert.equal(lines[0], 'experiment: demo')
      assert.ok(lines.some(line => line.includes('1 tasks × 2 repeats × 2 arms')))
      assert.deepEqual(lines.slice(-4), [
        '  alpha #0 [off]',
        '  alpha #0 [on]',
        '  alpha #1 [off]',
        '  alpha #1 [on]',
      ])
      assert.deepEqual(await readdir(benchRoot), ['tasks'])
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('marks chain tasks with their phase count', async () => {
    const benchRoot = await tempDir('bench-runner-dry-chain-')
    try {
      await writeTask(benchRoot, 'alpha')
      const dir = join(benchRoot, 'tasks', 'gamma-chain')
      await mkdir(join(dir, 'fixture'), { recursive: true })
      await writeFile(join(dir, 'task.json'), JSON.stringify({
        taskId: 'gamma-chain',
        stratum: 'chain',
        description: 'gamma-chain',
        phases: [{ instruction: 'one' }, { instruction: 'two' }],
        verify: 'node verify.mjs',
        timeoutMs: 1000,
      }))
      /** @type {string[]} */
      const lines = []
      const code = await main(
        ['--experiment', 'demo', '--repeats', '1', '--arms', 'off,on', '--dry-run'],
        { benchRoot, env: {}, print: line => lines.push(line) },
      )
      assert.equal(code, 0)
      assert.deepEqual(lines.slice(-4), [
        '  alpha #0 [off]',
        '  alpha #0 [on]',
        '  gamma-chain #0 [off] (2 phases)',
        '  gamma-chain #0 [on] (2 phases)',
      ])
      assert.deepEqual(await readdir(benchRoot), ['tasks'])
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('refuses a real run without the named API key', async () => {
    const benchRoot = await tempDir('bench-runner-nokey-')
    // SHRES_HOME pins the credential-store fallback to an empty temp dir so
    // the machine's real ~/.shres store cannot satisfy the gate under test.
    const emptyHome = await tempDir('bench-runner-nokey-home-')
    try {
      await writeTask(benchRoot, 'alpha')
      await assert.rejects(
        () => main(['--experiment', 'demo'], { benchRoot, env: { SHRES_HOME: emptyHome }, print: () => {} }),
        error => error instanceof UsageError && /DEEPSEEK_API_KEY/.test(error.message),
      )
      await assert.rejects(
        () => main(['--experiment', 'demo2', '--api-key-env', 'ZAI_API_KEY'], { benchRoot, env: { SHRES_HOME: emptyHome }, print: () => {} }),
        error => error instanceof UsageError && /ZAI_API_KEY/.test(error.message),
      )
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
      await rm(emptyHome, { recursive: true, force: true })
    }
  })

  it('reads a missing API key from the harness credential store', async () => {
    const home = await tempDir('bench-runner-credstore-')
    try {
      await writeFile(join(home, '.credentials.yaml'), [
        'OTHER_KEY: plain-value',
        "ZAI_API_KEY: 'quoted-value'",
        'EMPTY_KEY:   ',
      ].join('\n'))
      assert.equal(await readStoredCredential({ SHRES_HOME: home }, 'OTHER_KEY'), 'plain-value')
      assert.equal(await readStoredCredential({ SHRES_HOME: home }, 'ZAI_API_KEY'), 'quoted-value')
      assert.equal(await readStoredCredential({ SHRES_HOME: home }, 'ABSENT_KEY'), null)
      assert.equal(await readStoredCredential({ SHRES_HOME: join(home, 'nowhere') }, 'ZAI_API_KEY'), null)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('accepts --api-key-env none without requiring any key', async () => {
    const benchRoot = await tempDir('bench-runner-nokey-none-')
    try {
      await writeTask(benchRoot, 'alpha')
      /** @type {string[]} */
      const lines = []
      const code = await main(
        ['--experiment', 'demo', '--arms', 'off', '--api-key-env', 'none', '--dry-run'],
        { benchRoot, env: {}, print: line => lines.push(line) },
      )
      assert.equal(code, 0)
      assert.ok(lines.some(l => l.includes('apiKeyEnv: none')))
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('dry-run prints tier patch info', async () => {
    const benchRoot = await tempDir('bench-runner-tier-dry-')
    try {
      await writeTask(benchRoot, 'alpha')
      const tierPath = join(benchRoot, 'tiers', 'test.patch.yml')
      await mkdir(join(benchRoot, 'tiers'), { recursive: true })
      await writeFile(tierPath, '- id: llm-deepseek\n  disabled: true\n')
      /** @type {string[]} */
      const lines = []
      const code = await main(
        ['--experiment', 'demo', '--arms', 'off', '--api-key-env', 'none', '--tier-patch', tierPath, '--dry-run'],
        { benchRoot, env: {}, print: line => lines.push(line) },
      )
      assert.equal(code, 0)
      assert.ok(lines.some(l => l.includes('tierPatches:') && l.includes('test.patch.yml')))
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('dry-run prints repeatable --tier-patch files in given order', async () => {
    const benchRoot = await tempDir('bench-runner-tier-multi-dry-')
    try {
      await writeTask(benchRoot, 'alpha')
      await mkdir(join(benchRoot, 'tiers'), { recursive: true })
      await mkdir(join(benchRoot, 'pressure'), { recursive: true })
      const first = join(benchRoot, 'tiers', 'a.patch.yml')
      const second = join(benchRoot, 'pressure', 'b.patch.yml')
      await writeFile(first, '- id: first\n  disabled: true\n')
      await writeFile(second, '- id: second\n  disabled: true\n')
      /** @type {string[]} */
      const lines = []
      const code = await main(
        [
          '--experiment', 'demo', '--arms', 'off', '--api-key-env', 'none',
          '--tier-patch', first, '--tier-patch', second, '--dry-run',
        ],
        { benchRoot, env: {}, print: line => lines.push(line) },
      )
      assert.equal(code, 0)
      const summary = lines.find(l => l.includes('tierPatches:'))
      assert.ok(summary)
      assert.ok(summary.indexOf('a.patch.yml') < summary.indexOf('b.patch.yml'))
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('refuses a comma-separated --tasks list that matches nothing', async () => {
    const benchRoot = await tempDir('bench-runner-notasks-')
    try {
      await writeTask(benchRoot, 'alpha')
      await writeTask(benchRoot, 'beta')
      await assert.rejects(
        () => main(
          ['--experiment', 'demo', '--tasks', 'nomatch,also-missing', '--dry-run'],
          { benchRoot, env: {}, print: () => {} },
        ),
        error => error instanceof UsageError && /no tasks match/.test(error.message),
      )
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })

  it('refuses --tier-patch when file does not exist', async () => {
    const benchRoot = await tempDir('bench-runner-tier-missing-')
    try {
      await writeTask(benchRoot, 'alpha')
      await assert.rejects(
        () => main(
          ['--experiment', 'demo', '--arms', 'off', '--api-key-env', 'none', '--tier-patch', '/nonexistent/patch.yml', '--dry-run'],
          { benchRoot, env: {}, print: () => {} },
        ),
        error => error instanceof UsageError && /tier-patch file not found/.test(error.message),
      )
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })
})

describe('verify.runVerifier', () => {
  it('maps exit 0 to resolved and nonzero to VERIFY_FAILED', async () => {
    const root = await tempDir('bench-runner-verify-')
    try {
      const scratchDir = join(root, 'scratch')
      await mkdir(scratchDir, { recursive: true })
      await writeFile(join(root, 'pass.mjs'), 'console.log("all good")\n')
      const pass = await runVerifier({ taskDir: root, verify: 'node pass.mjs', scratchDir })
      assert.equal(pass.resolved, true)
      assert.equal(pass.exitCode, 0)
      assert.equal(pass.failureMode, null)
      assert.equal(pass.detail, 'all good')
      assert.equal(pass.command, `node pass.mjs ${scratchDir}`)

      await writeFile(join(root, 'fail.mjs'), 'console.error("nope")\nprocess.exit(1)\n')
      const fail = await runVerifier({ taskDir: root, verify: 'node fail.mjs', scratchDir })
      assert.equal(fail.resolved, false)
      assert.equal(fail.exitCode, 1)
      assert.equal(fail.failureMode, 'VERIFY_FAILED')
      assert.equal(fail.detail, 'nope')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps a verifier timeout to exit 124 VERIFY_FAILED', async () => {
    const root = await tempDir('bench-runner-verify-timeout-')
    try {
      const scratchDir = join(root, 'scratch')
      await mkdir(scratchDir, { recursive: true })
      await writeFile(join(root, 'slow.mjs'), 'setTimeout(() => {}, 60_000)\n')
      const outcome = await runVerifier({ taskDir: root, verify: 'node slow.mjs', scratchDir, timeoutMs: 300 })
      assert.equal(outcome.resolved, false)
      assert.equal(outcome.exitCode, 124)
      assert.equal(outcome.failureMode, 'VERIFY_FAILED')
      assert.match(/** @type {string} */ (outcome.detail), /timed out/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('setup.runSetup', () => {
  it('runs node setup.mjs with scratch dir and session-log root', async () => {
    const root = await tempDir('bench-runner-setup-ok-')
    try {
      const scratchDir = join(root, 'scratch')
      const sessionLogRoot = join(root, 'sessions')
      await mkdir(scratchDir, { recursive: true })
      await mkdir(sessionLogRoot, { recursive: true })
      await writeFile(join(root, 'setup.mjs'), `
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
await writeFile(join(process.argv[3], 'planted.txt'), process.argv[2])
console.log('ok')
`)
      await runSetup({ taskDir: root, setup: 'node setup.mjs', scratchDir, sessionLogRoot })
      assert.equal(await readFile(join(sessionLogRoot, 'planted.txt'), 'utf8'), scratchDir)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a nonzero setup as infrastructure failure', async () => {
    const root = await tempDir('bench-runner-setup-fail-')
    try {
      const scratchDir = join(root, 'scratch')
      await mkdir(scratchDir, { recursive: true })
      await writeFile(join(root, 'setup.mjs'), 'console.log("fail: boom")\nprocess.exit(1)\n')
      await assert.rejects(
        () => runSetup({
          taskDir: root,
          setup: 'node setup.mjs',
          scratchDir,
          sessionLogRoot: join(root, 'sessions'),
        }),
        /setup failed \(exit 1\): fail: boom/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('session-layout', () => {
  it('matches the JSONL persistence encodeSegment and projectKey vectors', () => {
    assert.equal(encodeSegment('..'), '~002E~002E')
    assert.equal(encodeSegment('.'), '~002E')
    assert.equal(encodeSegment('a/b'), 'a~002Fb')
    assert.equal(encodeSegment('plain-ID_1.2'), 'plain-ID_1.2')
    assert.equal(encodeSegment('bench-prior-session-query-adoption'), 'bench-prior-session-query-adoption')
    assert.equal(projectKey('/Users/qyj/work/shres-code'), '--Users-qyj-work-shres-code--')
    assert.equal(projectKey('/'), '--root--')
  })

  it('reserves the bench-prior- session-id prefix', () => {
    assert.equal(SEEDED_PRIOR_SESSION_PREFIX, 'bench-prior-')
    assert.equal(isSeededPriorSession('bench-prior-session-query-adoption'), true)
    assert.equal(isSeededPriorSession('bench-prior'), false)
    assert.equal(isSeededPriorSession('session-abc'), false)
    assert.equal(isSeededPriorSession(1), false)
  })
})

describe('execute.findSessionLog', () => {
  /**
   * @param {string} path
   * @param {number} delegationDepth
   * @param {string} cwd
   * @param {{ id?: string, createdAt?: number }} [extra]
   */
  async function writeLog(path, delegationDepth, cwd, extra = {}) {
    await mkdir(join(path, '..'), { recursive: true })
    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: extra.id ?? 's',
      cwd,
      delegationDepth,
      ...(extra.createdAt !== undefined ? { createdAt: extra.createdAt } : {}),
    })
    await writeFile(path, `${header}\n{"type":"step/end","seq":1,"time":1,"data":{"turn":0,"step":0}}\n`)
  }

  it('selects the top-level session among child logs', async () => {
    const root = await tempDir('bench-runner-logs-')
    try {
      const top = join(root, '--scratch--', 'AAA', 'session.jsonl')
      const child = join(root, '--scratch--', 'BBB', 'session.jsonl')
      await writeLog(child, 1, '/scratch')
      await writeLog(top, 0, '/scratch')
      assert.equal(await findSessionLog(root, '/scratch'), top)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to any depth-0 log when no cwd matches, and null when absent', async () => {
    const root = await tempDir('bench-runner-logs-')
    try {
      const top = join(root, '--other--', 'CCC', 'session.jsonl')
      await writeLog(top, 0, '/somewhere-else')
      assert.equal(await findSessionLog(root, '/scratch'), top)
      assert.equal(await findSessionLog(join(root, 'missing'), '/scratch'), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips seeded prior-session fixtures even when cwd matches', async () => {
    const root = await tempDir('bench-runner-prior-logs-')
    try {
      const prior = join(root, '--scratch--', 'bench-prior-x', 'session.jsonl')
      const trial = join(root, '--scratch--', 'live', 'session.jsonl')
      await writeLog(prior, 0, '/scratch', { id: 'bench-prior-x', createdAt: 9_999 })
      await writeLog(trial, 0, '/scratch', { id: 's1', createdAt: 1 })
      assert.equal(await findSessionLog(root, '/scratch'), trial)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns null when only a seeded prior log exists', async () => {
    const root = await tempDir('bench-runner-prior-only-')
    try {
      const prior = join(root, '--scratch--', 'bench-prior-x', 'session.jsonl')
      await writeLog(prior, 0, '/scratch', { id: 'bench-prior-x' })
      assert.equal(await findSessionLog(root, '/scratch'), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('execute.resolveHarnessLaunch', () => {
  it('fails loud when the harness repo has no installed dependencies', async () => {
    const root = await tempDir('bench-runner-norepo-')
    try {
      await writeFile(join(root, 'package.json'), '{"name":"fake","type":"module"}')
      assert.throws(() => resolveHarnessLaunch(root), /pnpm install/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * Fake harness bin (written to apps/cli/src/bin.ts in a fake repo). Reads the
 * per-spawn persistence root out of the `--patch` overlay, appends its task
 * text to spawn-log.txt in the scratch dir (proving the carried workspace),
 * and fabricates a one-turn session log. Failure steering via the task text:
 * PROVIDER_FAIL exits 1 with a provider signature after logging; HARNESS_DIE
 * exits 2 without logging; JSPACE_LEAK logs a jspace/card event; HANG
 * never finishes (the runner's timeout kills it).
 */
const FAKE_BIN = `import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
// Read the first --patch (arm overlay) to find the session root.
const overlay = await readFile(args[args.indexOf('--patch') + 1], 'utf8')
const root = JSON.parse(overlay.match(/root: ("(?:[^"\\\\]|\\\\.)*")/)[1])
const taskText = args[args.length - 1]

await appendFile(join(process.cwd(), 'spawn-log.txt'), taskText + '\\n')

if (taskText.includes('HANG')) {
  setTimeout(() => {}, 60000)
} else if (taskText.includes('HARNESS_DIE')) {
  process.exit(2)
} else {
  if (taskText.includes('GATE') && process.env.BENCH_TEST_GATE_DIR) {
    const gateDir = process.env.BENCH_TEST_GATE_DIR
    const gateN = Number(process.env.BENCH_TEST_GATE_N ?? '3')
    const id = String(process.pid)
    await writeFile(join(gateDir, 'start-' + id), '')
    const seen = (await readdir(gateDir)).filter(name => name.startsWith('start-')).length
    await writeFile(join(gateDir, 'seen-' + id), String(seen))
    const t0 = Date.now()
    while ((await readdir(gateDir)).filter(name => name.startsWith('start-')).length < gateN) {
      if (Date.now() - t0 > 8000) break
      await new Promise(r => setTimeout(r, 15))
    }
  }
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 's1', cwd: process.cwd(), delegationDepth: 0 }),
    JSON.stringify({ type: 'step/end', seq: 1, time: 1000, data: { turn: 0, step: 0 } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, time: 2000, data: { turn: 0, step: 0, usage: { inputTokens: 100, outputTokens: 20 } } }),
  ]
  if (taskText.includes('JSPACE_LEAK')) {
    lines.push(JSON.stringify({ type: 'jspace/card', seq: 3, time: 3000, data: {} }))
  }
  const dir = join(root, 'workspace', 's1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), lines.join('\\n') + '\\n')
  if (taskText.includes('PROVIDER_FAIL')) {
    console.error('Error: DeepSeek API returned 429 Too Many Requests')
    process.exit(1)
  }
}
`

/** Loader hook registered by the fake tsx/esm so plain JS in a .ts file runs. */
const FAKE_TSX_HOOKS = `import { readFile } from 'node:fs/promises'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    return { format: 'module', source: await readFile(new URL(url), 'utf8'), shortCircuit: true }
  }
  return nextLoad(url, context)
}
`

/**
 * Build a runnable world: a fake harness repo (package.json, a tsx/esm
 * stand-in that registers the .ts hook, the fake bin) with bench/ inside it,
 * plus the given tasks in bench/tasks.
 * @param {string} root - temp root.
 * @param {{ taskId: string, definition: Record<string, unknown>, passes?: boolean, setupSource?: string }[]} tasks -
 *   task definitions; `passes` decides the verifier's exit code; `setupSource`
 *   writes `setup.mjs` when the definition names a setup command.
 * @returns {Promise<{ benchRoot: string, repoRoot: string }>} paths; benchRoot feeds main().
 */
async function writeBenchWorld(root, tasks) {
  const repoRoot = join(root, 'repo')
  const benchRoot = join(repoRoot, 'bench')
  await mkdir(join(repoRoot, 'node_modules', 'tsx'), { recursive: true })
  await writeFile(join(repoRoot, 'package.json'), '{"name":"fake-harness","type":"module"}\n')
  await writeFile(join(repoRoot, 'node_modules', 'tsx', 'package.json'), '{"name":"tsx","version":"0.0.0","type":"module"}\n')
  await writeFile(
    join(repoRoot, 'node_modules', 'tsx', 'esm.js'),
    "import { register } from 'node:module'\nregister('./hooks.mjs', import.meta.url)\n",
  )
  await writeFile(join(repoRoot, 'node_modules', 'tsx', 'hooks.mjs'), FAKE_TSX_HOOKS)
  await mkdir(join(repoRoot, 'apps', 'cli', 'src'), { recursive: true })
  await writeFile(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'), FAKE_BIN)
  for (const { taskId, definition, passes = true, setupSource } of tasks) {
    const dir = join(benchRoot, 'tasks', taskId)
    await mkdir(join(dir, 'fixture'), { recursive: true })
    await writeFile(join(dir, 'fixture', 'seed.txt'), `${taskId} fixture\n`)
    await writeFile(join(dir, 'task.json'), JSON.stringify({
      taskId,
      stratum: 'short',
      description: taskId,
      verify: 'node verify.mjs',
      timeoutMs: 30000,
      ...definition,
    }))
    await writeFile(join(dir, 'verify.mjs'), `process.exit(${passes ? 0 : 1})\n`)
    if (setupSource !== undefined) await writeFile(join(dir, 'setup.mjs'), setupSource)
  }
  return { benchRoot, repoRoot }
}

/**
 * Run one experiment to completion under the fake harness and read one arm's
 * trials back from trials.jsonl.
 * @param {string} benchRoot - the world's bench directory.
 * @param {string[]} argv - run.js arguments after the script path.
 * @param {string} arm - the arm to read.
 * @returns {Promise<{ code: number, lines: string[], trials: object[] }>} exit code, progress lines, trials.
 */
async function runWorld(benchRoot, argv, arm, io = {}) {
  /** @type {string[]} */
  const lines = []
  const code = await main(argv, {
    benchRoot,
    env: { DEEPSEEK_API_KEY: 'fake-key', ...io.env },
    print: line => lines.push(line),
    signal: io.signal,
  })
  return { code, lines, trials: await readTrials(benchRoot, argv[1], arm) }
}

/**
 * Read one arm's trials.jsonl of a finished experiment.
 * @param {string} benchRoot - the world's bench directory.
 * @param {string} experiment - experiment name.
 * @param {string} arm - the arm to read.
 * @returns {Promise<object[]>} parsed trial records.
 */
async function readTrials(benchRoot, experiment, arm) {
  const text = await readFile(join(benchRoot, 'runs', experiment, arm, 'trials.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}

describe('run.main execution (fake harness)', () => {
  it('runs a chain trial: cold per-phase session roots, carried workspace, summed metrics', async () => {
    const root = await tempDir('bench-runner-chain-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'resume-chain',
        definition: {
          stratum: 'chain',
          phases: [
            { instruction: 'diagnose the crash' },
            { instruction: 'fix it', timeoutMs: 20000 },
          ],
          timeoutMs: 30000,
        },
      }])
      const { code, trials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1'], 'off')
      assert.equal(code, 0)
      assert.equal(trials.length, 1)
      const [trial] = trials
      validateTrial(trial)

      // Per-phase records: fresh session root per phase, cold carry.
      assert.equal(trial.phases.length, 2)
      assert.deepEqual(trial.phases.map(p => p.phaseIndex), [0, 1])
      for (const [index, phase] of trial.phases.entries()) {
        assert.equal(phase.sessionFile, `sessions/resume-chain/0/phase-${index}/workspace/s1/session.jsonl`)
        assert.equal(phase.resumedFrom, null)
        assert.equal(phase.exitCode, 0)
        assert.equal(phase.timedOut, false)
        assert.equal(phase.metrics.inputTokens, 100)
        assert.equal(phase.metrics.turns, 1)
        // The phase's overlay pins its own session root.
        const overlay = await readFile(
          join(benchRoot, 'runs', 'e2e', 'off', 'sessions', 'resume-chain', '0', `phase-${index}`, 'arm-overlay.yml'),
          'utf8',
        )
        assert.match(overlay, new RegExp(`root: ".*phase-${index}"`))
        assert.match(overlay, /enabled: false/)
      }

      // Trial level: per-phase sums, the final phase's session file, one verifier run.
      assert.equal(trial.metrics.inputTokens, 200)
      assert.equal(trial.metrics.turns, 2)
      assert.equal(trial.sessionFile, trial.phases[1].sessionFile)
      assert.equal(trial.status, 'success')
      assert.equal(trial.resolved, true)
      assert.equal(trial.failureMode, null)
      assert.equal(trial.verifier.exitCode, 0)
      assert.ok(!('integrity' in trial), 'clean trials omit integrity')

      // The scratch workspace carried across phases: both phase prompts landed
      // in the same scratch dir, in order.
      const spawnLog = await readFile(
        join(benchRoot, 'runs', 'e2e', 'scratch', 'off', 'resume-chain', '0', 'spawn-log.txt'),
        'utf8',
      )
      assert.equal(spawnLog, 'diagnose the crash\nfix it\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs a single-session trial unchanged (no phases key, per-trial session root)', async () => {
    const root = await tempDir('bench-runner-single-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'plain',
        definition: { instruction: 'do the plain thing' },
      }])
      const { code, trials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1', '--arms', 'on'], 'on')
      assert.equal(code, 0)
      const [trial] = trials
      validateTrial(trial)
      assert.ok(!('phases' in trial))
      assert.ok(!('integrity' in trial))
      assert.equal(trial.sessionFile, 'sessions/plain/0/workspace/s1/session.jsonl')
      assert.equal(trial.metrics.inputTokens, 100)
      assert.equal(trial.resolved, true)
      const overlay = await readFile(join(benchRoot, 'runs', 'e2e', 'on', 'sessions', 'plain', '0', 'arm-overlay.yml'), 'utf8')
      assert.match(overlay, /enabled: true/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts a chain on PROVIDER_ERROR: completed phases recorded, verifier never runs', async () => {
    const root = await tempDir('bench-runner-abort-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'abort-chain',
        definition: {
          stratum: 'chain',
          phases: [
            { instruction: 'phase zero is fine' },
            { instruction: 'phase one hits PROVIDER_FAIL' },
            { instruction: 'phase two never runs' },
          ],
        },
      }])
      const { code, trials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'], 'off')
      assert.equal(code, 1, 'every trial errored')
      const [trial] = trials
      validateTrial(trial)
      assert.equal(trial.status, 'error')
      assert.equal(trial.failureMode, 'PROVIDER_ERROR')
      assert.equal(trial.resolved, false)
      assert.equal(trial.phases.length, 2)
      assert.equal(trial.phases[0].exitCode, 0)
      assert.equal(trial.phases[1].exitCode, 1)
      assert.match(trial.verifier.detail, /not run: provider error in phase 1 \(agent exit 1\)/)
      assert.equal(trial.verifier.exitCode, -1)
      // Metrics still sum the completed phases; sessionFile is the failed phase's log.
      assert.equal(trial.metrics.inputTokens, 200)
      assert.equal(trial.sessionFile, trial.phases[1].sessionFile)
      // Phase 2 never spawned: no session root, no prompt in the workspace.
      const phaseDirs = await readdir(join(benchRoot, 'runs', 'e2e', 'off', 'sessions', 'abort-chain', '0'))
      assert.deepEqual(phaseDirs.sort(), ['phase-0', 'phase-1'])
      const spawnLog = await readFile(
        join(benchRoot, 'runs', 'e2e', 'scratch', 'off', 'abort-chain', '0', 'spawn-log.txt'),
        'utf8',
      )
      assert.equal(spawnLog, 'phase zero is fine\nphase one hits PROVIDER_FAIL\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('times out one phase without aborting the chain; unresolved verdict is AGENT_TIMEOUT', async () => {
    const root = await tempDir('bench-runner-timeout-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'hang-chain',
        passes: false,
        definition: {
          stratum: 'chain',
          phases: [
            { instruction: 'phase zero will HANG', timeoutMs: 500 },
            { instruction: 'phase one completes' },
          ],
        },
      }])
      const { code, trials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'], 'off')
      assert.equal(code, 0)
      const [trial] = trials
      validateTrial(trial)
      assert.equal(trial.status, 'success')
      assert.equal(trial.resolved, false)
      assert.equal(trial.failureMode, 'AGENT_TIMEOUT')
      assert.equal(trial.phases.length, 2)
      const [hung, done] = trial.phases
      assert.equal(hung.timedOut, true)
      assert.equal(hung.exitCode, null)
      assert.equal(hung.sessionFile, null)
      // No log was written: every folded field is zero; durationMs is wall time.
      assert.deepEqual({ ...hung.metrics, durationMs: 0 }, emptyMetrics())
      assert.ok(hung.metrics.durationMs > 0)
      assert.equal(done.timedOut, false)
      assert.equal(done.metrics.inputTokens, 100)
      // The verifier ran once, on the carried workspace, after the final phase.
      assert.equal(trial.verifier.exitCode, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flags jspace events in the off arm only; the on arm stays clean', async () => {
    const root = await tempDir('bench-runner-leak-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'leak-task',
        definition: { instruction: 'do the JSPACE_LEAK thing' },
      }])
      const { code, trials: offTrials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1'], 'off')
      assert.equal(code, 0)
      const [offTrial] = offTrials
      validateTrial(offTrial)
      assert.equal(offTrial.status, 'success', 'violations never abort the trial')
      assert.deepEqual(offTrial.integrity, { violations: ['off-arm-jspace-event:jspace/card'] })

      const [onTrial] = await readTrials(benchRoot, 'e2e', 'on')
      assert.ok(!('integrity' in onTrial), 'the on arm may log jspace events')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('run.json records apiKeyEnv and empty tierPatches', async () => {
    const root = await tempDir('bench-runner-manifest-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'manifest-check',
        definition: { instruction: 'just checking manifests' },
      }])
      const { code } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'], 'off')
      assert.equal(code, 0)
      const manifest = JSON.parse(await readFile(join(benchRoot, 'runs', 'e2e', 'off', 'run.json'), 'utf8'))
      assert.equal(manifest.apiKeyEnv, 'DEEPSEEK_API_KEY')
      assert.deepEqual(manifest.tierPatches, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('run.json records repeatable --tier-patch files in given order', async () => {
    const root = await tempDir('bench-runner-tier-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'tier-task',
        definition: { instruction: 'test tier patch propagation' },
      }])
      const tierDir = join(benchRoot, 'tiers')
      await mkdir(tierDir, { recursive: true })
      await mkdir(join(benchRoot, 'pressure'), { recursive: true })
      const first = join(tierDir, 'test.patch.yml')
      const second = join(benchRoot, 'pressure', 'forced.patch.yml')
      await writeFile(first, '- id: llm-deepseek\n  disabled: true\n')
      await writeFile(second, '- id: compaction-basic\n  config:\n    auto: true\n')
      const code = await main(
        [
          '--experiment', 'tier-e2e', '--repeats', '1', '--arms', 'off',
          '--tier-patch', first, '--tier-patch', second,
        ],
        { benchRoot, env: { DEEPSEEK_API_KEY: 'fake-key' }, print: () => {} },
      )
      assert.equal(code, 0)
      const manifest = JSON.parse(await readFile(join(benchRoot, 'runs', 'tier-e2e', 'off', 'run.json'), 'utf8'))
      assert.equal(manifest.apiKeyEnv, 'DEEPSEEK_API_KEY')
      assert.equal(manifest.tierPatches.length, 2)
      assert.match(manifest.tierPatches[0].path, /tiers\/test\.patch\.yml/)
      assert.match(manifest.tierPatches[1].path, /pressure\/forced\.patch\.yml/)
      for (const record of manifest.tierPatches) {
        assert.equal(typeof record.sha256, 'string')
        assert.equal(record.sha256.length, 64)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flags a preexisting chain session root as leakage', async () => {
    const root = await tempDir('bench-runner-preexisting-e2e-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'pre-chain',
        definition: {
          stratum: 'chain',
          phases: [{ instruction: 'one' }, { instruction: 'two' }],
        },
      }])
      // Leakage from a previous trial: phase-1's root exists before the trial starts.
      await mkdir(join(benchRoot, 'runs', 'e2e', 'off', 'sessions', 'pre-chain', '0', 'phase-1'), { recursive: true })
      const { trials } = await runWorld(benchRoot, ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'], 'off')
      const [trial] = trials
      validateTrial(trial)
      assert.equal(trial.status, 'success')
      assert.deepEqual(trial.integrity, { violations: ['session-root-preexisting:sessions/pre-chain/0/phase-1'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('plants a prior session during setup without mistaking it for the trial log', async () => {
    const root = await tempDir('bench-runner-setup-plant-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'plant-prior',
        definition: { instruction: 'continue the prior work', setup: 'node setup.mjs' },
        setupSource: `import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const scratch = process.argv[2]
const sessionRoot = process.argv[3]
const dir = join(sessionRoot, '--planted--', 'bench-prior-plant')
await mkdir(dir, { recursive: true })
const header = JSON.stringify({
  type: 'session', version: 0, id: 'bench-prior-plant',
  cwd: scratch, delegationDepth: 0, createdAt: 99,
})
await writeFile(join(dir, 'session.jsonl'), header + '\\n{"type":"step/end","seq":0,"time":1,"data":{"turn":0,"step":0}}\\n')
`,
      }])
      const { code, trials } = await runWorld(
        benchRoot,
        ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'],
        'off',
      )
      assert.equal(code, 0)
      const [trial] = trials
      validateTrial(trial)
      assert.equal(trial.status, 'success')
      assert.match(trial.sessionFile, /workspace\/s1\/session\.jsonl$/)
      assert.ok(!('integrity' in trial), 'setup after the pre-exist check is not leakage')
      const prior = join(
        benchRoot, 'runs', 'e2e', 'off', 'sessions', 'plant-prior', '0',
        '--planted--', 'bench-prior-plant', 'session.jsonl',
      )
      const planted = JSON.parse((await readFile(prior, 'utf8')).split('\n', 1)[0])
      assert.equal(planted.id, 'bench-prior-plant')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records a failed setup as HARNESS_ERROR', async () => {
    const root = await tempDir('bench-runner-setup-err-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [{
        taskId: 'broken-setup',
        definition: { instruction: 'never spawned', setup: 'node setup.mjs' },
        setupSource: 'console.log("fail: cannot plant")\nprocess.exit(1)\n',
      }])
      const { code, trials } = await runWorld(
        benchRoot,
        ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off'],
        'off',
      )
      assert.equal(code, 1, 'every trial errored')
      const [trial] = trials
      validateTrial(trial)
      assert.equal(trial.status, 'error')
      assert.equal(trial.failureMode, 'HARNESS_ERROR')
      assert.match(trial.verifier.detail, /setup failed \(exit 1\): fail: cannot plant/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('runner pool', () => {
  it('concurrency 1 starts and finishes in list order', async () => {
    /** @type {number[]} */
    const started = []
    /** @type {number[]} */
    const finished = []
    await mapPool([1, 2, 3], 1, async n => {
      started.push(n)
      finished.push(n)
    })
    assert.deepEqual(started, [1, 2, 3])
    assert.deepEqual(finished, [1, 2, 3])
  })

  it('keeps at most n in flight and starts in list order', async () => {
    /** @type {string[]} */
    const events = []
    let current = 0
    let max = 0
    await mapPool(['a', 'b', 'c', 'd'], 3, async id => {
      current += 1
      max = Math.max(max, current)
      events.push(`s${id}`)
      await new Promise(resolve => setTimeout(resolve, 40))
      current -= 1
      events.push(`e${id}`)
    })
    assert.equal(max, 3)
    assert.deepEqual(events.slice(0, 3), ['sa', 'sb', 'sc'])
    assert.ok(events.includes('ed'))
  })

  it('stops launching after abort and waits for in-flight workers', async () => {
    const abort = new AbortController()
    /** @type {number[]} */
    const started = []
    let released = 0
    await mapPool([1, 2, 3, 4, 5], 2, async n => {
      started.push(n)
      if (n === 2) abort.abort()
      await new Promise(resolve => setTimeout(resolve, 20))
      released += 1
    }, { signal: abort.signal })
    assert.deepEqual(started, [1, 2])
    assert.equal(released, 2)
  })

  it('serializes overlapping writes into whole lines', async () => {
    const root = await tempDir('bench-runner-serial-')
    try {
      const path = join(root, 'out.jsonl')
      const queue = createSerialQueue()
      await Promise.all([0, 1, 2].map(index => queue.enqueue(async () => {
        await writeFile(path, `{${index}`, { flag: 'a' })
        await new Promise(resolve => setTimeout(resolve, 15))
        await writeFile(path, `}\n`, { flag: 'a' })
      })))
      const text = await readFile(path, 'utf8')
      assert.equal(text, '{0}\n{1}\n{2}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('run.main concurrency (fake harness)', () => {
  /**
   * @param {import('../schema/trial.js').Trial} trial
   */
  function trialKey(trial) {
    return {
      taskId: trial.taskId,
      trialIndex: trial.trialIndex,
      arm: trial.arm,
      status: trial.status,
      resolved: trial.resolved,
      sessionFile: trial.sessionFile,
      failureMode: trial.failureMode,
    }
  }

  it('concurrency 1 matches the default sequential run', async () => {
    const root = await tempDir('bench-runner-conc1-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [
        { taskId: 'plain-a', definition: { instruction: 'do a' } },
        { taskId: 'plain-b', definition: { instruction: 'do b' } },
      ])
      const flags = ['--repeats', '1', '--arms', 'off,on']
      const sequential = await runWorld(benchRoot, ['--experiment', 'seq', ...flags], 'off')
      const conc1 = await runWorld(benchRoot, ['--experiment', 'c1', ...flags, '--concurrency', '1'], 'off')
      assert.equal(sequential.code, 0)
      assert.equal(conc1.code, 0)
      assert.deepEqual(sequential.trials.map(trialKey), conc1.trials.map(trialKey))
      assert.deepEqual(
        (await readTrials(benchRoot, 'seq', 'on')).map(trialKey),
        (await readTrials(benchRoot, 'c1', 'on')).map(trialKey),
      )
      const strip = line => line.replace(/^\[(seq|c1)\] /, '')
      assert.deepEqual(sequential.lines.map(strip), conc1.lines.map(strip))
      const taskIds = [...new Set(sequential.trials.map(t => t.taskId))]
      assert.deepEqual(
        sequential.trials.map(t => ({ taskId: t.taskId, trialIndex: t.trialIndex, arm: t.arm })),
        buildPlan({ taskIds, arms: ['off'], repeats: 1 }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('concurrency 3 runs three trials at once and writes a complete trials.jsonl', async () => {
    const root = await tempDir('bench-runner-conc3-')
    try {
      const gateDir = join(root, 'gate')
      await mkdir(gateDir, { recursive: true })
      const { benchRoot } = await writeBenchWorld(root, [
        { taskId: 'gate-a', definition: { instruction: 'GATE a', timeoutMs: 15000 } },
        { taskId: 'gate-b', definition: { instruction: 'GATE b', timeoutMs: 15000 } },
        { taskId: 'gate-c', definition: { instruction: 'GATE c', timeoutMs: 15000 } },
      ])
      const { code, lines, trials } = await runWorld(
        benchRoot,
        ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off', '--concurrency', '3'],
        'off',
        { env: { BENCH_TEST_GATE_DIR: gateDir, BENCH_TEST_GATE_N: '3' } },
      )
      assert.equal(code, 0)
      assert.equal(trials.length, 3)
      for (const trial of trials) validateTrial(trial)
      const text = await readFile(join(benchRoot, 'runs', 'e2e', 'off', 'trials.jsonl'), 'utf8')
      assert.equal(text.endsWith('\n'), true)
      for (const line of text.trim().split('\n')) JSON.parse(line)
      const seen = (await readdir(gateDir))
        .filter(name => name.startsWith('seen-'))
        .map(name => Number(readFileSync(join(gateDir, name), 'utf8')))
      assert.equal(Math.max(...seen), 3)
      assert.ok(lines.every(line => /gate-[abc] #\d+ \[off\]/.test(line) || line.includes('done:')))
      assert.ok(lines.some(line => line.includes('running')))
      const onKeys = trials.map(t => `${t.taskId}:${t.trialIndex}`)
      const paired = pairOutcomes(trials, trials)
      assert.equal(paired.ties, 3)
      assert.equal(paired.pairs.length, 3)
      assert.deepEqual([...onKeys].sort(), ['gate-a:0', 'gate-b:0', 'gate-c:0'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('out-of-order trials.jsonl still pairs on taskId+trialIndex', async () => {
    const root = await tempDir('bench-runner-ooo-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [
        { taskId: 'pair-a', definition: { instruction: 'pair a' } },
        { taskId: 'pair-b', definition: { instruction: 'pair b' } },
        { taskId: 'pair-c', definition: { instruction: 'pair c' } },
      ])
      await runWorld(
        benchRoot,
        ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off,on', '--concurrency', '3'],
        'off',
      )
      const off = await readTrials(benchRoot, 'e2e', 'off')
      const on = await readTrials(benchRoot, 'e2e', 'on')
      const fileOrder = pairOutcomes(off, on)
      const sorted = pairOutcomes(
        [...off].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.trialIndex - b.trialIndex),
        [...on].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.trialIndex - b.trialIndex),
      )
      assert.equal(fileOrder.wins, sorted.wins)
      assert.equal(fileOrder.losses, sorted.losses)
      assert.equal(fileOrder.ties, sorted.ties)
      assert.equal(fileOrder.ties, 3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('abort drains in-flight trials and leaves trials.jsonl well-formed', async () => {
    const root = await tempDir('bench-runner-abort-')
    try {
      const { benchRoot } = await writeBenchWorld(root, [
        { taskId: 'hang-a', definition: { instruction: 'will HANG', timeoutMs: 30000 } },
        { taskId: 'hang-b', definition: { instruction: 'also HANG', timeoutMs: 30000 } },
      ])
      const abort = new AbortController()
      /** @type {string[]} */
      const lines = []
      /** @type {((value?: void) => void) | undefined} */
      let sawRunning
      const started = new Promise(resolve => { sawRunning = resolve })
      const running = main(
        ['--experiment', 'e2e', '--repeats', '1', '--arms', 'off', '--concurrency', '2'],
        {
          benchRoot,
          env: { DEEPSEEK_API_KEY: 'fake-key' },
          print: line => {
            lines.push(line)
            if (line.includes('running')) sawRunning?.()
          },
          signal: abort.signal,
        },
      )
      await Promise.race([
        started,
        new Promise((_, reject) => setTimeout(() => reject(new Error('no running progress line')), 8000)),
      ])
      abort.abort()
      const code = await running
      assert.equal(code, 130)
      const manifest = JSON.parse(await readFile(join(benchRoot, 'runs', 'e2e', 'off', 'run.json'), 'utf8'))
      assert.equal(manifest.endedAt, '')
      const trialsPath = join(benchRoot, 'runs', 'e2e', 'off', 'trials.jsonl')
      if (existsSync(trialsPath)) {
        const text = await readFile(trialsPath, 'utf8')
        for (const line of text.split('\n').filter(l => l.trim() !== '')) {
          validateTrial(JSON.parse(line))
        }
      }
      assert.ok(lines.some(line => line.includes('aborted:')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('run.main --base-url defaulting', () => {
  it('falls back to DEEPSEEK_BASE_URL only when apiKeyEnv is DEEPSEEK_API_KEY', async () => {
    const benchRoot = await tempDir('bench-runner-baseurl-')
    try {
      const dir = join(benchRoot, 'tasks', 'alpha')
      await mkdir(join(dir, 'fixture'), { recursive: true })
      await writeFile(join(dir, 'task.json'), JSON.stringify({
        taskId: 'alpha', stratum: 'short', description: 'a',
        instruction: 'do it', verify: 'node verify.mjs', timeoutMs: 1000,
      }))
      /** @type {string[]} */
      let lines = []

      // Default apiKeyEnv (DEEPSEEK_API_KEY): picks up DEEPSEEK_BASE_URL
      await main(
        ['--experiment', 'e1', '--arms', 'off', '--dry-run'],
        { benchRoot, env: { DEEPSEEK_BASE_URL: 'https://deepseek.example' }, print: line => lines.push(line) },
      )
      assert.ok(lines.some(l => l.includes('baseUrl: https://deepseek.example')))

      // Non-default apiKeyEnv: base URL defaults to null
      lines = []
      await main(
        ['--experiment', 'e2', '--arms', 'off', '--api-key-env', 'ZAI_API_KEY', '--dry-run'],
        { benchRoot, env: { DEEPSEEK_BASE_URL: 'https://deepseek.example' }, print: line => lines.push(line) },
      )
      assert.ok(lines.some(l => l.includes('baseUrl: (provider default)')))
    } finally {
      await rm(benchRoot, { recursive: true, force: true })
    }
  })
})
