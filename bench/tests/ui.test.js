/**
 * Tests for bench/ui: chart builders, view renderers, and the pure model
 * helpers under a DOM shim. Run from the worktree root:
 * node --test bench/tests/ui.test.js
 *
 * The shared helpers/dom-shim.js models only the SVG surface charts.js once
 * needed; the views additionally need className/append/listeners/dataset/
 * attribute toggles/querySelector, so this file layers a richer element on top
 * of the shim's base factory (the shim itself is shared and stays untouched).
 * Assertion helpers (walk/byTag/byClass/attr) keep working: the rich element
 * preserves the shim's { ns, tag, attrs, children, textContent } shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attr, byClass, byTag, walk } from './helpers/dom-shim.js'

const XHTML = 'http://www.w3.org/1999/xhtml'

/** Text node for append()ed strings. */
function textNode(text) {
  return { ns: null, tag: '#text', attrs: Object.create(null), children: [], textContent: text }
}

/** Single simple selector match: 'tag', '.class', or '#id'. */
function matches(node, sel) {
  if (sel.startsWith('.')) return (node.attrs.class ?? '').split(/\s+/).includes(sel.slice(1))
  if (sel.startsWith('#')) return node.attrs.id === sel.slice(1)
  return node.tag === sel
}

/** Descendant query supporting whitespace-separated simple selectors. */
function queryAll(node, sel) {
  const parts = sel.trim().split(/\s+/)
  if (parts.length > 1) {
    return walk(node)
      .filter(n => n !== node && matches(n, parts[0]))
      .flatMap(n => queryAll(n, parts.slice(1).join(' ')))
  }
  return walk(node).filter(n => n !== node && matches(n, parts[0]))
}

/**
 * Rich shim element: the shared shim's shape plus the surface views.js uses
 * (className, append/replaceChildren, addEventListener, dataset, value,
 * has/remove/toggleAttribute, querySelector/All).
 * @param {string} ns - namespace URI.
 * @param {string} tag - tag name.
 * @returns {any}
 */
function richElement(ns, tag) {
  const el = {
    ns,
    tag,
    attrs: Object.create(null),
    children: [],
    textContent: '',
    dataset: {},
    value: '',
    listeners: Object.create(null),
    setAttribute(name, value) { el.attrs[name] = String(value) },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    hasAttribute(name) { return name in el.attrs },
    removeAttribute(name) { delete el.attrs[name] },
    toggleAttribute(name, force) {
      const want = force === undefined ? !el.hasAttribute(name) : Boolean(force)
      if (want) el.attrs[name] = ''
      else delete el.attrs[name]
      return want
    },
    appendChild(child) { el.children.push(child); return child },
    append(...kids) {
      for (const k of kids.flat()) {
        if (k === null || k === undefined) continue
        el.children.push(typeof k === 'string' ? textNode(k) : k)
      }
    },
    replaceChildren(...kids) { el.children.length = 0; el.append(...kids) },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn) },
    querySelector(sel) { return queryAll(el, sel)[0] ?? null },
    querySelectorAll(sel) { return queryAll(el, sel) },
  }
  Object.defineProperty(el, 'className', {
    get: () => el.attrs.class ?? '',
    set: (v) => { el.attrs.class = String(v) },
  })
  return el
}

globalThis.document = {
  createElement: (tag) => richElement(XHTML, tag),
  createElementNS: (ns, tag) => richElement(ns, tag),
}

/** Dispatch a synthetic event to an element's recorded listeners. */
function fire(el, type, props = {}) {
  const event = { target: el, stopPropagation() {}, preventDefault() {}, ...props }
  for (const fn of el.listeners[type] ?? []) fn(event)
  return event
}

/** Concatenated text content of a shim subtree. */
function allText(root) {
  return walk(root).map(n => n.textContent).join(' ')
}

const { groupedBarChart, pairedScatter, radarChart, deltaChart, sparkline } = await import('../ui/charts.js')
const model = await import('../ui/model.js')
const views = await import('../ui/views.js')

/* ------------------------------------------------------------------ */
/* Extended fixture: five tasks (two chain), two arms, 20 trials       */
/* ------------------------------------------------------------------ */

/** One phase record for a chain trial. */
function ph(i, taskId, trialIndex, { input = 12000, out = 1500, ms = 120000, turns = 6, timedOut = false, exitCode = 0 } = {}) {
  return {
    phaseIndex: i,
    sessionFile: `sessions/${taskId}/t${trialIndex}/p${i}.jsonl`,
    resumedFrom: i === 0 ? null : `sessions/${taskId}/t${trialIndex}/p${i - 1}.jsonl`,
    exitCode,
    timedOut,
    metrics: { inputTokens: input, outputTokens: out, durationMs: ms, turns, toolCalls: turns * 2, identicalRetries: 0, checkpoints: 1, shipPasses: 0 },
    startedAt: '2026-08-17T12:00:00.000Z',
    endedAt: '2026-08-17T12:02:00.000Z',
  }
}

/**
 * Build the extended ReportData fixture. Tokens are unique per trial so
 * sorting assertions are exact.
 * @returns {any}
 */
function fixture() {
  const tasks = [
    { taskId: 'rename', stratum: 'long', description: 'Rename module' },
    { taskId: 'offbyone', stratum: 'short', description: 'Fix off-by-one' },
    { taskId: 'inject', stratum: 'adversarial', description: 'Ignore planted injection' },
    { taskId: 'feat-chain', stratum: 'chain', description: 'Three-phase feature' },
    { taskId: 'bug-chain', stratum: 'chain', description: 'Two-phase bugfix' },
  ]
  const cell = (taskId, arm, resolved, trials, errors, ci95) => ({
    taskId, arm, trials, errors, resolved, passRate: resolved / trials, ci95,
    meanInputTokens: 1000, meanOutputTokens: 200, meanDurationMs: 60000, meanTurns: 5,
    meanToolCalls: 8, meanIdenticalRetries: 0, meanCheckpoints: 0,
  })
  const cells = [
    cell('rename', 'off', 0, 2, 0, [0, 0.65]),
    cell('rename', 'on', 2, 2, 0, [0.4, 1]),
    cell('offbyone', 'off', 1, 2, 0, [0.1, 0.9]),
    cell('offbyone', 'on', 1, 2, 0, [0.1, 0.9]),
    cell('inject', 'off', 2, 2, 0, [0.4, 1]),
    cell('inject', 'on', 1, 2, 0, [0.1, 0.9]),
    cell('feat-chain', 'off', 1, 2, 0, [0.1, 0.9]),
    cell('feat-chain', 'on', 1, 2, 0, [0.1, 0.9]),
    cell('bug-chain', 'off', 0, 1, 1, [0, 0.95]),
    cell('bug-chain', 'on', 2, 2, 0, [0.4, 1]),
  ]
  let tokenClock = 800
  const trial = (o) => ({
    taskId: o.taskId,
    trialIndex: o.trialIndex,
    arm: o.arm,
    status: o.status ?? 'success',
    resolved: o.resolved,
    failureMode: o.resolved ? null : (o.failureMode ?? 'VERIFY_FAILED'),
    verifier: { command: 'node verify.mjs', exitCode: o.resolved ? 0 : 1, ...(o.resolved ? {} : { detail: o.detail ?? 'verifier failed' }) },
    metrics: {
      inputTokens: (tokenClock += 137), outputTokens: 200, durationMs: o.durationMs ?? 60000,
      turns: o.turns ?? 5, toolCalls: 8, identicalRetries: 0, checkpoints: 0, shipPasses: 0,
    },
    sessionFile: o.sessionFile ?? null,
    startedAt: o.startedAt ?? `2026-08-17T09:${String(o.trialIndex).padStart(2, '0')}:00.000Z`,
    endedAt: '2026-08-17T10:00:00.000Z',
    ...(o.phases ? { phases: o.phases } : {}),
    ...(o.integrity ? { integrity: o.integrity } : {}),
  })
  const trials = [
    trial({ taskId: 'rename', trialIndex: 0, arm: 'off', resolved: false }),
    trial({ taskId: 'rename', trialIndex: 1, arm: 'off', resolved: false }),
    trial({ taskId: 'rename', trialIndex: 0, arm: 'on', resolved: true }),
    trial({ taskId: 'rename', trialIndex: 1, arm: 'on', resolved: true }),
    trial({ taskId: 'offbyone', trialIndex: 0, arm: 'off', resolved: true }),
    trial({ taskId: 'offbyone', trialIndex: 1, arm: 'off', resolved: false }),
    trial({ taskId: 'offbyone', trialIndex: 0, arm: 'on', resolved: false }),
    trial({ taskId: 'offbyone', trialIndex: 1, arm: 'on', resolved: true }),
    trial({ taskId: 'inject', trialIndex: 0, arm: 'off', resolved: true }),
    trial({ taskId: 'inject', trialIndex: 1, arm: 'off', resolved: true }),
    trial({ taskId: 'inject', trialIndex: 0, arm: 'on', resolved: true }),
    trial({ taskId: 'inject', trialIndex: 1, arm: 'on', resolved: false }),
    trial({ taskId: 'feat-chain', trialIndex: 0, arm: 'off', resolved: false, phases: [ph(0, 'feat-chain', 0), ph(1, 'feat-chain', 0), ph(2, 'feat-chain', 0)], sessionFile: 'sessions/feat-chain/t0/p2.jsonl' }),
    trial({ taskId: 'feat-chain', trialIndex: 1, arm: 'off', resolved: true, phases: [ph(0, 'feat-chain', 1), ph(1, 'feat-chain', 1), ph(2, 'feat-chain', 1)], sessionFile: 'sessions/feat-chain/t1/p2.jsonl' }),
    trial({ taskId: 'feat-chain', trialIndex: 0, arm: 'on', resolved: true, phases: [ph(0, 'feat-chain', 0), ph(1, 'feat-chain', 0), ph(2, 'feat-chain', 0)], sessionFile: 'sessions/feat-chain/t0/p2.jsonl' }),
    trial({
      taskId: 'feat-chain', trialIndex: 1, arm: 'on', resolved: false,
      phases: [ph(0, 'feat-chain', 1), ph(1, 'feat-chain', 1), ph(2, 'feat-chain', 1, { timedOut: true, exitCode: 1 })],
      sessionFile: 'sessions/feat-chain/t1/p2.jsonl',
      integrity: { violations: ['phase 2 resumedFrom does not match phase 1 sessionFile'] },
      detail: 'final phase never wired the route',
    }),
    trial({ taskId: 'bug-chain', trialIndex: 0, arm: 'off', resolved: false, phases: [ph(0, 'bug-chain', 0)], sessionFile: 'sessions/bug-chain/t0/p0.jsonl' }),
    trial({ taskId: 'bug-chain', trialIndex: 1, arm: 'off', status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR', phases: [ph(0, 'bug-chain', 1)], sessionFile: 'sessions/bug-chain/t1/p0.jsonl' }),
    trial({ taskId: 'bug-chain', trialIndex: 0, arm: 'on', resolved: true, phases: [ph(0, 'bug-chain', 0), ph(1, 'bug-chain', 0)], sessionFile: 'sessions/bug-chain/t0/p1.jsonl' }),
    trial({ taskId: 'bug-chain', trialIndex: 1, arm: 'on', resolved: true, phases: [ph(0, 'bug-chain', 1), ph(1, 'bug-chain', 1)], sessionFile: 'sessions/bug-chain/t1/p1.jsonl' }),
  ]
  const pairs = tasks.map((t, i) => ({
    taskId: t.taskId, treatment: 'on', delta: 0.5 - i * 0.2, deltaCi95: [-0.2, 0.9], mcnemarP: 0.5,
    wins: 1, losses: 0, ties: 1, winner: 'on',
  }))
  return {
    version: 1,
    demo: true,
    generatedAt: '2026-08-18T12:00:00.000Z',
    experiment: 'testexp',
    tasks,
    cells,
    arms: [
      { arm: 'off', accuracy: 0.5, stderr: 0.13, ci95: [0.28, 0.72], totalInputTokens: 30000, totalOutputTokens: 4000, totalDurationMs: 600000, meanTurns: 6, totalIdenticalRetries: 4, trials: 9 },
      { arm: 'on', accuracy: 0.75, stderr: 0.11, ci95: [0.53, 0.89], totalInputTokens: 33000, totalOutputTokens: 4200, totalDurationMs: 640000, meanTurns: 6.2, totalIdenticalRetries: 1, trials: 10 },
    ],
    comparisons: [{ treatment: 'on', grade: 'improvement', deltaAccuracy: 0.25, mcnemarP: 0.031, pairs }],
    trials,
  }
}

/** Recording router stub. */
function stubCtx(nav = []) {
  return { nav, navigate(hash, opts) { nav.push({ hash, opts }) } }
}

/* ------------------------------------------------------------------ */
/* charts.js                                                            */
/* ------------------------------------------------------------------ */

test('groupedBarChart: structure, whiskers, zero-anchored bars', () => {
  const svg = groupedBarChart({
    categories: ['a', 'b', 'c'],
    series: [
      { name: 'off', color: 'var(--arm-off)', values: [0.5, 0.75, 1], ci: [[0.2, 0.8], [0.4, 0.95], [0.6, 1]] },
      { name: 'on', color: 'var(--arm-on)', values: [0.75, 1, 1], ci: [[0.4, 0.95], [0.6, 1], [0.6, 1]] },
    ],
    yLabel: 'pass rate',
    yMax: 1,
    formatValue: v => `${Math.round(v * 100)}%`,
  })
  assert.equal(svg.tag, 'svg')
  assert.equal(attr(svg, 'role'), 'img')
  assert.ok(attr(svg, 'aria-label').length > 0)
  assert.ok(attr(svg, 'viewBox'))

  const bars = byClass(svg, 'bar')
  assert.equal(bars.length, 6)
  // yMax 1 and plot margins t=36, b=50 of H=360 → baseline at y=310.
  const axis = byClass(svg, 'axis')[0]
  assert.equal(Number(attr(axis, 'y1')), 310)
  for (const bar of bars) {
    assert.ok(Math.abs(Number(attr(bar, 'y')) + Number(attr(bar, 'height')) - 310) < 1e-9, 'bar is anchored at zero')
    const title = bar.children.find(c => c.tag === 'title')
    assert.ok(title, 'bar carries a tooltip title')
    assert.match(title.textContent, /95% CI/)
  }
  const whiskers = byClass(svg, 'ci')
  assert.equal(whiskers.length, 6)
  for (const w of whiskers) {
    assert.deepEqual(w.children.map(c => c.tag), ['line', 'line', 'line'], 'whisker = stem + 2 caps')
  }
  assert.equal(byClass(svg, 'legend-item').length, 2)
  assert.equal(byClass(svg, 'cat-label').length, 3)
  assert.ok(byClass(svg, 'grid').length >= 6)
  assert.ok(byClass(svg, 'axis-label').some(t => t.textContent === 'pass rate'))
})

test('groupedBarChart: no ci → no whiskers; NaN bars skipped', () => {
  const svg = groupedBarChart({
    categories: ['a', 'b', 'c'],
    series: [
      { name: 'off', color: 'c1', values: [0.5, Number.NaN, 1] },
      { name: 'on', color: 'c2', values: [1, 1, 1] },
    ],
  })
  assert.equal(byClass(svg, 'bar').length, 5)
  assert.equal(byClass(svg, 'ci').length, 0)
})

test('pairedScatter: tie line and sign-colored points', () => {
  const svg = pairedScatter({
    points: [
      { id: 't1', x: 0.5, y: 0.75 },
      { id: 't2', x: 0.6, y: 0.4 },
      { id: 't3', x: 0.8, y: 0.8 },
    ],
    xLabel: 'off pass rate',
    yLabel: 'on pass rate',
  })
  const tie = byClass(svg, 'tie-line')
  assert.equal(tie.length, 1, 'exactly one diagonal tie line')
  assert.ok(Number(attr(tie[0], 'x1')) < Number(attr(tie[0], 'x2')))
  assert.ok(Number(attr(tie[0], 'y1')) > Number(attr(tie[0], 'y2')), 'y axis points up')

  const points = byClass(svg, 'point')
  assert.equal(points.length, 3)
  assert.equal(attr(points[0], 'fill'), 'var(--heat-good)')
  assert.equal(attr(points[1], 'fill'), 'var(--heat-bad)')
  assert.equal(attr(points[2], 'fill'), 'var(--muted)')
  assert.match(points[0].children.find(c => c.tag === 'title').textContent, /t1/)
  assert.ok(byClass(svg, 'axis-label').some(t => t.textContent === 'off pass rate'))
  assert.ok(byClass(svg, 'axis-label').some(t => t.textContent === 'on pass rate'))
})

test('radarChart: rings, spokes, series polygons, max scaling', () => {
  const svg = radarChart({
    axes: ['long', 'short', 'adversarial', 'chain'],
    series: [
      { name: 'off', color: 'c1', values: [0.5, 1, 0, 0.5] },
      { name: 'on', color: 'c2', values: [1, 0.5, 1, 1] },
    ],
    max: 1,
  })
  assert.equal(byClass(svg, 'ring').length, 4)
  assert.equal(byClass(svg, 'spoke').length, 4)
  const polys = byClass(svg, 'series')
  assert.equal(polys.length, 2)
  for (const poly of polys) {
    assert.equal(attr(poly, 'points').trim().split(' ').length, 4, 'one vertex per axis')
    assert.ok(poly.children.some(c => c.tag === 'title'), 'series polygon has a tooltip')
  }
  // Center (200, 200), radius 128: a value at max lands exactly on the outer ring.
  const [vx, vy] = attr(polys[1], 'points').trim().split(' ')[0].split(',').map(Number)
  assert.ok(Math.abs(Math.hypot(vx - 200, vy - 200) - 128) < 0.2, 'vertex at max reaches the outer ring')
  assert.equal(byClass(svg, 'legend-item').length, 2)
  assert.equal(byClass(svg, 'axis-label').length, 4)
})

test('deltaChart: bars centered on zero, colored by sign, with whiskers', () => {
  const svg = deltaChart({
    items: [
      { id: 'a', delta: 0.25, ci: [0.05, 0.45] },
      { id: 'b', delta: -0.5, ci: [-0.8, -0.2] },
      { id: 'c', delta: 0, ci: [-0.1, 0.1] },
    ],
    xLabel: 'pass-rate delta',
  })
  const bars = byClass(svg, 'delta-bar')
  assert.equal(bars.length, 3)
  assert.equal(byClass(svg, 'ci').length, 3)
  const zero = byClass(svg, 'zero')
  assert.equal(zero.length, 1)
  const zx = Number(attr(zero[0], 'x1'))
  assert.equal(attr(bars[0], 'fill'), 'var(--heat-good)')
  assert.equal(attr(bars[1], 'fill'), 'var(--heat-bad)')
  assert.equal(attr(bars[2], 'fill'), 'var(--muted)')
  assert.ok(Math.abs(Number(attr(bars[0], 'x')) - zx) < 1e-9, 'positive bar starts at zero')
  const neg = bars[1]
  assert.ok(Math.abs(Number(attr(neg, 'x')) + Number(attr(neg, 'width')) - zx) < 1e-9, 'negative bar ends at zero')
  assert.equal(byClass(svg, 'item-label').length, 3)
  assert.equal(byClass(svg, 'value-label').length, 3)
  assert.match(bars[0].children.find(c => c.tag === 'title').textContent, /95% CI/)
})

test('sparkline: one polyline per series, shared domain, end dots, tooltips', () => {
  const svg = sparkline({
    series: [
      { name: 'off', color: 'c1', values: [0.2, 0.4, 0.6] },
      { name: 'on', color: 'c2', values: [0.3, 0.7, 0.9] },
    ],
    yMin: 0,
    yMax: 1,
    formatValue: v => `${Math.round(v * 100)}%`,
  })
  assert.equal(svg.tag, 'svg')
  assert.equal(attr(svg, 'role'), 'img')
  const lines = byClass(svg, 'spark-line')
  assert.equal(lines.length, 2)
  assert.equal(attr(lines[0], 'points').trim().split(' ').length, 3, 'one vertex per value')
  assert.match(lines[1].children.find(c => c.tag === 'title').textContent, /last 90%/)
  assert.equal(byClass(svg, 'spark-end').length, 2)
  // yMin 0 / yMax 1 pin the domain: first off point (0.2) sits above the floor.
  const [, floorY] = attr(lines[0], 'points').trim().split(' ')[0].split(',').map(Number)
  assert.ok(floorY < 34 - 3, 'value above the domain floor is inset from the bottom edge')
})

test('sparkline: empty series draw nothing but still render', () => {
  const svg = sparkline({ series: [{ name: 'off', color: 'c1', values: [] }] })
  assert.equal(svg.tag, 'svg')
  assert.equal(byClass(svg, 'spark-line').length, 0)
})

test('charts tolerate empty inputs', () => {
  for (const svg of [
    groupedBarChart({ categories: [], series: [] }),
    pairedScatter({ points: [], xLabel: 'x', yLabel: 'y' }),
    deltaChart({ items: [] }),
    sparkline({ series: [] }),
  ]) {
    assert.equal(svg.tag, 'svg')
    assert.ok(walk(svg).length > 0)
  }
})

/* ------------------------------------------------------------------ */
/* model.js                                                             */
/* ------------------------------------------------------------------ */

test('model.parseHash / buildHash round-trip with sort state', () => {
  assert.deepEqual(model.parseHash('').view, 'summary')
  assert.deepEqual(model.parseHash('#nope').view, 'summary')
  const { view, params } = model.parseHash('#trials?arm=on&task=x')
  assert.equal(view, 'trials')
  assert.equal(params.get('arm'), 'on')
  assert.equal(params.get('task'), 'x')
  assert.equal(model.buildHash('trials', { arm: 'on', task: '', outcome: 'failed' }), '#trials?arm=on&outcome=failed')
  assert.equal(model.buildHash('trials', { sort: 'tokens', dir: 'desc' }), '#trials?sort=tokens&dir=desc')
  const round = model.parseHash(model.buildHash('matrix', {}))
  assert.equal(round.view, 'matrix')
})

test('model.heatColor anchors and degenerate input', () => {
  assert.equal(model.heatColor(0), 'rgb(248 113 113)')
  assert.equal(model.heatColor(0.5), 'rgb(251 191 36)')
  assert.equal(model.heatColor(1), 'rgb(52 211 153)')
  assert.equal(model.heatColor(Number.NaN), null)
})

test('model.armColorMap pins off/on and cycles four extras', () => {
  const map = model.armColorMap({ arms: [{ arm: 'off' }, { arm: 'on' }, { arm: 'x' }, { arm: 'y' }, { arm: 'z' }, { arm: 'w' }, { arm: 'v' }] })
  assert.equal(map.get('off'), 'var(--arm-off)')
  assert.equal(map.get('on'), 'var(--arm-on)')
  assert.equal(map.get('x'), 'var(--arm-x1)')
  assert.equal(map.get('w'), 'var(--arm-x4)')
  assert.equal(map.get('v'), 'var(--arm-x1)', 'fifth extra wraps the cycle')
})

test('model.strataOf orders long, short, adversarial, chain, pressure, then extras', () => {
  const order = model.strataOf(fixture().tasks)
  assert.deepEqual(order, ['long', 'short', 'adversarial', 'chain'])
  assert.deepEqual(model.strataOf([{ stratum: 'pressure' }, { stratum: 'long' }]), ['long', 'pressure'])
  assert.deepEqual(model.strataOf([{ stratum: 'chain' }, { stratum: 'xtra' }, { stratum: 'short' }]), ['short', 'chain', 'xtra'])
})

test('model.filterTrials filters and default-sorts', () => {
  const { trials } = fixture()
  assert.equal(model.filterTrials(trials).length, 20)
  assert.deepEqual(model.filterTrials(trials, { arm: 'on' }).length, 10)
  assert.deepEqual(model.filterTrials(trials, { outcome: 'resolved' }).map(t => `${t.taskId}:${t.arm}`),
    ['bug-chain:on', 'bug-chain:on', 'feat-chain:on', 'feat-chain:off', 'inject:off', 'inject:on', 'inject:off', 'offbyone:off', 'offbyone:on', 'rename:on', 'rename:on'])
  assert.equal(model.filterTrials(trials, { outcome: 'error' }).length, 1)
  assert.deepEqual(model.filterTrials(trials, { task: 'feat-chain', outcome: 'failed' }).map(t => `${t.arm}:${t.trialIndex}`), ['off:0', 'on:1'])
})

test('model.filterTrials sorts by column, direction, with default-order tiebreak', () => {
  const { trials } = fixture()
  const byTokens = model.filterTrials(trials, { sort: 'tokens', dir: 'desc' })
  const totals = byTokens.map(t => t.metrics.inputTokens + t.metrics.outputTokens)
  assert.ok(totals.every((v, i) => i === 0 || totals[i - 1] >= v), 'descending by tokens')
  const asc = model.filterTrials(trials, { sort: 'tokens', dir: 'asc' }).map(t => t.metrics.inputTokens)
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b), 'ascending by tokens')
  const byOutcome = model.filterTrials(trials, { sort: 'outcome', dir: 'asc' })
  assert.equal(byOutcome[0].resolved, true, 'resolved sorts first')
  assert.equal(byOutcome.at(-1).status, 'error', 'error sorts last')
  // Unknown keys and missing dir fall back to the default order.
  assert.deepEqual(model.filterTrials(trials, { sort: 'nope' }), model.filterTrials(trials))
  const byTrial = model.filterTrials(trials, { sort: 'trial', dir: 'asc' })
  assert.deepEqual(byTrial.map(t => t.trialIndex), [...Array(10).fill(0), ...Array(10).fill(1)], 'primary key dominates')
  assert.deepEqual(byTrial.slice(0, 3).map(t => t.taskId), ['bug-chain', 'bug-chain', 'feat-chain'], 'ties keep the default order')
})

test('model.matrixRows pools per-stratum subtotals', () => {
  const groups = model.matrixRows(fixture())
  assert.deepEqual(groups.map(g => g.stratum), ['long', 'short', 'adversarial', 'chain'])
  const chain = groups.find(g => g.stratum === 'chain')
  assert.equal(chain.rows.length, 2)
  const [off, on] = chain.subtotal
  assert.equal(off.arm, 'off')
  assert.deepEqual([off.resolved, off.trials], [1, 3], 'off pool: feat-chain 1/2 + bug-chain 0/1')
  assert.deepEqual([on.resolved, on.trials], [3, 4])
  assert.ok(off.ci95[0] <= off.passRate && off.passRate <= off.ci95[1])
  const long = groups.find(g => g.stratum === 'long')
  assert.equal(long.rows[0].best, 'on', 'rename: on interval excludes off point estimate')
})

test('model.summaryRows derives totals and delta vs off', () => {
  const rows = model.summaryRows(fixture())
  assert.equal(rows[0].totalTokens, 34000)
  assert.equal(rows[0].deltaVsOff, null)
  assert.ok(Math.abs(rows[1].deltaVsOff - 0.25) < 1e-12)
})

test('model.heroStats recomputes the delta CI from trials and the token ratio from arms', () => {
  const hero = model.heroStats(fixture())
  assert.equal(hero.treatment, 'on')
  assert.equal(hero.grade, 'improvement')
  assert.equal(hero.deltaAccuracy, 0.25)
  assert.equal(hero.mcnemarP, 0.031)
  assert.ok(Array.isArray(hero.deltaCi95) && hero.deltaCi95.every(Number.isFinite), 'bootstrap CI present')
  assert.ok(hero.deltaCi95[0] <= hero.deltaCi95[1])
  assert.ok(hero.wins > 0 && hero.losses >= 0 && hero.ties > 0)
  assert.ok(Math.abs(hero.tokenOverheadRatio - 37200 / 34000) < 1e-12)
})

test('model.heroStats falls back to pairs sums without embedded trials', () => {
  const data = fixture()
  delete data.trials
  const hero = model.heroStats(data)
  assert.equal(hero.deltaCi95, null)
  assert.deepEqual([hero.wins, hero.losses, hero.ties], [5, 0, 5], 'summed from pairs')
  assert.ok(Math.abs(hero.tokenOverheadRatio - 37200 / 34000) < 1e-12)
})

test('model.sparkSeries orders by start time and accumulates accuracy', () => {
  const { accuracy, tokens } = model.sparkSeries(fixture())
  assert.deepEqual(accuracy.map(s => s.name), ['off', 'on'])
  assert.equal(accuracy[0].values.length, 9, 'error-status trial excluded')
  assert.ok(accuracy[0].values.every(v => v >= 0 && v <= 1))
  assert.equal(tokens[1].values.length, 10)
})

test('model.phasesOf / integrityViolations tolerate absent and malformed fields', () => {
  const { trials } = fixture()
  const plain = trials.find(t => t.taskId === 'rename')
  assert.equal(model.phasesOf(plain), null)
  assert.deepEqual(model.integrityViolations(plain), [])
  const chained = trials.find(t => t.taskId === 'feat-chain' && t.arm === 'off')
  assert.equal(model.phasesOf(chained).length, 3)
  const flagged = trials.find(t => t.integrity)
  assert.deepEqual(model.integrityViolations(flagged), ['phase 2 resumedFrom does not match phase 1 sessionFile'])
  assert.equal(model.phasesOf({ ...chained, phases: [{ nope: true }] }), null, 'malformed phases read as absent')
})

test('model.phaseSpec averages per-phase metrics per arm; missing phases are NaN', () => {
  const data = fixture()
  const feat = model.phaseSpec(data, 'feat-chain', 'inputTokens')
  assert.deepEqual(feat.categories, ['phase 1', 'phase 2', 'phase 3'])
  assert.deepEqual(feat.series.map(s => s.name), ['off', 'on'])
  assert.ok(feat.series.every(s => s.values.every(Number.isFinite)), 'every phase reached in both arms')
  assert.equal(feat.series[0].values[0], 12000, 'identical phase inputs average to themselves')
  const bug = model.phaseSpec(data, 'bug-chain', 'inputTokens')
  assert.deepEqual(bug.categories, ['phase 1', 'phase 2'])
  assert.ok(Number.isFinite(bug.series[1].values[1]), 'on arm reached phase 2')
  assert.ok(Number.isNaN(bug.series[0].values[1]), 'no off trial reached phase 2')
})

test('model.chainTasks lists chain-stratum tasks', () => {
  assert.deepEqual(model.chainTasks(fixture()).map(t => t.taskId), ['feat-chain', 'bug-chain'])
})

test('model formatting helpers', () => {
  assert.equal(model.formatPct(Number.NaN), '—')
  assert.equal(model.formatPct(5 / 6), '83.3%')
  assert.equal(model.formatSignedPct(0.25), '+25.0%')
  assert.equal(model.formatSignedPct(null), '—')
  assert.equal(model.formatP(null), 'p n/a')
  assert.equal(model.formatP(0.0004), 'p < 0.001')
  assert.equal(model.formatP(0.375), 'p = 0.375')
  assert.equal(model.formatTokens(12345), '12.3k')
  assert.equal(model.formatMs(423000), '7m 3s')
  assert.equal(model.formatMs(179700), '3m 0s')
  assert.equal(model.formatInt(1234567), '1,234,567')
  assert.equal(model.formatRatio(37200 / 34000), '1.09×')
  assert.equal(model.formatRatio(null), '—')
})

/* ------------------------------------------------------------------ */
/* views.js                                                             */
/* ------------------------------------------------------------------ */

test('renderSummary: hero banner, sparklines, CI bars, arms table', () => {
  const root = richElement(XHTML, 'main')
  views.renderSummary(root, fixture())
  assert.equal(byClass(root, 'hero').length, 1)
  const chip = byClass(root, 'chip')[0]
  assert.ok(attr(chip, 'class').includes('grade-improvement'))
  assert.equal(chip.textContent, 'improvement')
  const text = allText(root)
  assert.ok(text.includes('+25.0%'), 'delta accuracy headline')
  assert.ok(text.includes('95% CI'), 'bootstrap CI subline')
  assert.ok(text.includes('p = 0.031'), 'McNemar p')
  assert.ok(text.includes('1.09×'), 'token overhead ratio')
  assert.ok(text.includes('wins'), 'discordance counts')
  assert.equal(byClass(root, 'spark-line').length, 4, 'two sparkline cards × two arms')
  assert.equal(byClass(root, 'ci-track').length, 2, 'one inline CI bar per arm')
  assert.equal(attr(byClass(root, 'ci-track')[0], 'role'), 'img')
  assert.equal(byTag(root, 'table').length, 1)
  assert.ok(text.includes('Dangling'), 'forensics column')
  assert.ok(text.includes('Compactions'), 'compaction column')
  assert.ok(text.includes('Pressure'), 'pressure-fired column')
})

test('renderMatrix: stratum headers, subtotal rows, chain badges, best-arm cells, navigation', () => {
  const root = richElement(XHTML, 'main')
  const ctx = stubCtx()
  views.renderMatrix(root, fixture(), ctx)
  const headers = byClass(root, 'stratum')
  assert.equal(headers.length, 4)
  assert.equal(byClass(root, 'subtotal').length, 4)
  const chainSub = byClass(root, 'subtotal')[3]
  assert.ok(allText(chainSub).includes('chain subtotal'))
  assert.ok(allText(chainSub).includes('1/3') && allText(chainSub).includes('3/4'), 'pooled counts per arm')
  assert.equal(byClass(root, 'badge-chain').length, 2, 'one badge per chain task')
  assert.equal(byClass(root, 'best').length, 2, 'rename and bug-chain have a decisive best arm')
  const cell = byClass(root, 'cell').find(c => c.tag === 'button')
  fire(cell, 'click')
  assert.equal(ctx.nav.length, 1)
  assert.match(ctx.nav[0].hash, /^#trials\?task=\w+/)
})

test('renderCharts: all sections plus the chain-phase picker and charts', () => {
  const root = richElement(XHTML, 'main')
  const ctx = stubCtx()
  views.renderCharts(root, fixture(), ctx, new URLSearchParams(''))
  assert.equal(byClass(root, 'chart').length, 6, 'pass rate, two scatters, radar, delta, phases')
  assert.equal(byClass(root, 'phase-grid').length, 1)
  const picker = byTag(root, 'select')[0]
  assert.equal(picker.children.length, 2, 'one option per chain task')
  assert.equal(attr(picker.children[0], 'selected'), '', 'first chain task selected by default')
  assert.equal(attr(picker, 'name'), 'phaseTask')
  picker.value = 'bug-chain'
  fire(picker, 'change')
  assert.equal(ctx.nav.at(-1).hash, '#charts?phaseTask=bug-chain')
  assert.equal(ctx.nav.at(-1).opts.replace, true)

  const root2 = richElement(XHTML, 'main')
  views.renderCharts(root2, fixture(), stubCtx(), new URLSearchParams('phaseTask=bug-chain'))
  const picker2 = byTag(root2, 'select')[0]
  assert.equal(attr(picker2.children[1], 'selected'), '', 'hash selection drives the picker')
  // bug-chain: off reached only phase 1 → 3 bars per chart (1 off + 2 on).
  const phaseBars = byClass(root2, 'bar').length - byClass(root, 'bar').length + 12
  assert.ok(phaseBars >= 6)
})

test('renderCharts without chain tasks omits the phase section', () => {
  const data = fixture()
  data.tasks = data.tasks.filter(t => t.stratum !== 'chain')
  const root = richElement(XHTML, 'main')
  views.renderCharts(root, data, stubCtx(), new URLSearchParams(''))
  assert.equal(byClass(root, 'phase-grid').length, 0)
  assert.equal(byClass(root, 'chart').length, 5)
})

test('renderTrials: rows, violation badge, sortable headers, filter bar', () => {
  const root = richElement(XHTML, 'main')
  const ctx = stubCtx()
  views.renderTrials(root, fixture(), ctx, new URLSearchParams(''))
  assert.equal(byClass(root, 'clickable').length, 20, 'one row per trial')
  const badges = byClass(root, 'badge-warn')
  assert.equal(badges.length, 1, 'one integrity-flagged trial')
  assert.match(attr(badges[0], 'title'), /resumedFrom/)
  assert.equal(byClass(root, 'flagged').length, 1, 'flagged row is highlighted')
  const sortable = byClass(root, 'sortable')
  assert.equal(sortable.length, 8)
  assert.ok(sortable.every(th => attr(th, 'aria-sort') === 'none'))
  assert.ok(allText(root).includes('20 of 20 trials'))
  // Sorting the tokens column cycles asc → desc → none through the hash.
  const tokensTh = sortable.find(th => allText(th).includes('Tokens'))
  fire(byClass(tokensTh, 'sort')[0], 'click')
  assert.equal(ctx.nav.at(-1).hash, '#trials?sort=tokens&dir=asc')
  assert.equal(ctx.nav.at(-1).opts.replace, true)
})

test('renderTrials: sort state drives order and aria-sort; third click clears', () => {
  const data = fixture()
  const ctx = stubCtx()
  const rootDesc = richElement(XHTML, 'main')
  views.renderTrials(rootDesc, data, ctx, new URLSearchParams('sort=tokens&dir=desc'))
  const th = byClass(rootDesc, 'sortable').find(x => allText(x).includes('Tokens'))
  assert.equal(attr(th, 'aria-sort'), 'descending')
  const body = byTag(rootDesc, 'tbody')[0]
  const rows = body.children.filter(c => (c.attrs.class ?? '').includes('clickable'))
  const firstTotals = rows.slice(0, 3).map(r => r.children[6].textContent)
  const want = model.filterTrials(data.trials, { sort: 'tokens', dir: 'desc' }).slice(0, 3)
    .map(t => model.formatTokens(t.metrics.inputTokens + t.metrics.outputTokens))
  assert.deepEqual(firstTotals, want, 'row order follows the model sort')
  // Third click clears the sort.
  fire(byClass(th, 'sort')[0], 'click')
  assert.equal(ctx.nav.at(-1).hash, '#trials', 'cleared sort drops sort/dir from the hash')
})

test('renderTrials: filters compose with sort in the hash', () => {
  const root = richElement(XHTML, 'main')
  const ctx = stubCtx()
  views.renderTrials(root, fixture(), ctx, new URLSearchParams('arm=on&sort=turns&dir=asc'))
  const armSelect = byTag(root, 'select')[0]
  armSelect.value = 'off'
  fire(armSelect, 'change')
  assert.equal(ctx.nav.at(-1).hash, '#trials?arm=off&sort=turns&dir=asc', 'sort survives filter changes')
  assert.equal(byClass(root, 'clickable').length, 10, 'arm filter applied')
})

test('renderTrials: expander shows verifier block and per-phase table', () => {
  const root = richElement(XHTML, 'main')
  views.renderTrials(root, fixture(), stubCtx(), new URLSearchParams('task=feat-chain&arm=on&outcome=failed'))
  assert.equal(byClass(root, 'clickable').length, 1, 'only the flagged chain trial')
  const caret = byClass(root, 'caret')[0]
  assert.equal(attr(caret, 'aria-expanded'), 'false')
  const detail = byClass(root, 'detail')[0]
  assert.ok(detail.hasAttribute('hidden'), 'detail collapsed initially')
  fire(caret, 'click')
  assert.ok(!detail.hasAttribute('hidden'), 'click expands the detail row')
  assert.equal(attr(caret, 'aria-expanded'), 'true')
  assert.equal(caret.textContent, '▾')
  const table = byClass(detail, 'phase-table')[0]
  assert.ok(table, 'phase table rendered')
  assert.equal(byTag(table, 'tr').length, 4, 'header + 3 phases')
  const text = allText(detail)
  assert.ok(text.includes('cold'), 'phase 0 resumedFrom renders as cold')
  assert.ok(text.includes('yes'), 'timed-out phase marked')
  assert.ok(text.includes('⚠ phase 2 resumedFrom'), 'violation listed in the expander')
  assert.ok(text.includes('node verify.mjs'), 'verifier command kept')
  assert.equal(byClass(detail, 'tokenbar').length, 3, 'one token bar per phase')
  fire(caret, 'click')
  assert.ok(detail.hasAttribute('hidden'), 'second click collapses')
})

test('renderTrials: trials without phases render no phase table', () => {
  const root = richElement(XHTML, 'main')
  views.renderTrials(root, fixture(), stubCtx(), new URLSearchParams('task=rename'))
  const detail = byClass(root, 'detail')[0]
  assert.equal(byClass(detail, 'phase-table').length, 0)
  assert.ok(allText(detail).includes('session file'))
})

test('renderTrials: payload without trials renders the explanatory note', () => {
  const data = fixture()
  delete data.trials
  const root = richElement(XHTML, 'main')
  views.renderTrials(root, data, stubCtx(), new URLSearchParams(''))
  assert.ok(allText(root).includes('no trial-level records'))
  assert.equal(byTag(root, 'table').length, 0)
})

test('renderEmptyState lists the generation commands', () => {
  const root = richElement(XHTML, 'main')
  views.renderEmptyState(root)
  const text = allText(root)
  assert.ok(text.includes('No report data'))
  assert.ok(text.includes('node bench/demo/generate.js && node bench/report/build.js'))
  assert.ok(text.includes('bench/report/serve.js'))
})

test('app boots: topbar meta, demo banner, routed view', async () => {
  const registry = new Map()
  const main = richElement(XHTML, 'main')
  const banner = richElement(XHTML, 'div')
  banner.hidden = true
  const meta = richElement(XHTML, 'div')
  meta.hidden = true
  const nav = richElement(XHTML, 'nav')
  nav.attrs.id = 'nav'
  const anchors = ['summary', 'matrix', 'charts', 'trials'].map((v) => {
    const a = richElement(XHTML, 'a')
    a.dataset.view = v
    nav.append(a)
    return a
  })
  registry.set('view', main)
  registry.set('demo-banner', banner)
  registry.set('experiment-meta', meta)
  document.getElementById = (id) => registry.get(id) ?? null
  document.querySelectorAll = (sel) => queryAll(nav, sel.replace(/^#nav\s+/, ''))
  globalThis.window = { addEventListener() {} }
  globalThis.location = { hash: '' }
  globalThis.history = { replaceState() {} }
  globalThis.BENCH_REPORT = fixture()

  await import('../ui/app.js')
  assert.equal(banner.hidden, false, 'demo banner visible for demo payload')
  assert.equal(meta.hidden, false)
  assert.ok(allText(meta).includes('testexp'), 'experiment name in the top bar')
  assert.ok(allText(meta).includes('generated 2026-08-18'), 'generated-at in the top bar')
  assert.ok(byClass(meta, 'badge-demo').length === 1, 'demo badge in the top bar')
  assert.ok(byClass(meta, 'grade-improvement').length === 1, 'grade chip in the top bar')
  assert.equal(attr(anchors[0], 'aria-current'), 'page')
  assert.equal(document.title, 'summary — testexp bench report')
  assert.equal(byClass(main, 'hero').length, 1, 'summary rendered by default route')
})
