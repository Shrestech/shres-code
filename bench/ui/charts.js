/**
 * SVG chart builders for the bench report. Each builder is a pure function of
 * its arguments and returns a detached SVGElement sized by viewBox, so charts
 * scale with their container. Paint and ink are CSS custom-property references
 * from styles.css, keeping the palette single-homed.
 *
 * Builders touch only `document.createElementNS`, `setAttribute`,
 * `appendChild`, and `textContent`, which lets the plain-object shim in
 * bench/tests/helpers/dom-shim.js exercise them under `node --test`.
 *
 * @module bench/ui/charts
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Create one SVG element.
 * @param {string} tag - SVG tag name.
 * @param {Record<string, string | number>} [attrs] - attributes to set.
 * @param {string} [text] - text content.
 * @returns {SVGElement}
 */
function el(tag, attrs = {}, text) {
  const node = globalThis.document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Format a number with at most `digits` decimals and no trailing zeros.
 * @param {number} value - value to format.
 * @param {number} [digits] - maximum decimal places.
 * @returns {string}
 */
function num(value, digits = 2) {
  const rounded = Number(value.toFixed(digits))
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

/**
 * Round up to a 1/2/5 × 10^n step so axis ticks stay round.
 * @param {number} value - maximum data value; must be > 0.
 * @returns {number}
 */
function niceCeil(value) {
  const pow = 10 ** Math.floor(Math.log10(value))
  const unit = value / pow
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10
  return step * pow
}

/**
 * Largest finite entry of a possibly sparse list, or null.
 * @param {(number | undefined)[]} values - candidates.
 * @returns {number | null}
 */
function finiteMax(values) {
  let max = null
  for (const v of values) {
    if (Number.isFinite(v) && (max === null || /** @type {number} */ (v) > max)) max = /** @type {number} */ (v)
  }
  return max
}

/**
 * Format with an explicit sign for non-zero deltas.
 * @param {number} value - value to format.
 * @returns {string}
 */
function fmtSigned(value) {
  return (value > 0 ? '+' : '') + num(value)
}

/**
 * Create the chart root: viewBox sizing, img role, accessible name.
 * @param {number} width - viewBox width.
 * @param {number} height - viewBox height.
 * @param {string} label - accessible name.
 * @param {string} kind - chart kind, recorded as data-chart.
 * @returns {SVGElement}
 */
function svgRoot(width, height, label, kind) {
  return el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': label,
    'data-chart': kind,
    preserveAspectRatio: 'xMidYMid meet',
  })
}

/**
 * Legend row (or column) of color swatches with series names.
 * @param {{ name: string, color: string }[]} series - entries to show.
 * @param {number} x - origin x.
 * @param {number} y - origin y.
 * @param {boolean} [vertical] - stack entries instead of flowing right.
 * @returns {SVGElement}
 */
function legendG(series, x, y, vertical = false) {
  const g = el('g', { class: 'legend' })
  let ox = 0
  series.forEach((s, i) => {
    const item = el('g', { class: 'legend-item', transform: vertical ? `translate(${x} ${y + i * 18})` : `translate(${x + ox} ${y})` })
    item.appendChild(el('rect', { class: 'swatch', x: 0, y: 0, width: 10, height: 10, rx: 2, fill: s.color }))
    item.appendChild(el('text', { x: 15, y: 9, fill: 'var(--muted)' }, s.name))
    g.appendChild(item)
    ox += s.name.length * 6.4 + 28
  })
  return g
}

/**
 * Sparkline: tiny axis-less line chart for stat cards. One polyline per series
 * plus a dot at the last point; values share one y domain across series.
 * @param {object} spec
 * @param {{ name: string, color: string, values: number[] }[]} spec.series - lines to draw; non-finite values break nothing (skipped per-point only at the ends is not supported — filter upstream).
 * @param {number} [spec.width] - viewBox width.
 * @param {number} [spec.height] - viewBox height.
 * @param {number} [spec.yMin] - fixed domain bottom; defaults to the data min.
 * @param {number} [spec.yMax] - fixed domain top; defaults to the data max.
 * @param {(value: number) => string} [spec.formatValue] - tooltip formatter.
 * @returns {SVGElement}
 */
export function sparkline({ series, width = 260, height = 34, yMin, yMax, formatValue = (v) => num(v) }) {
  const pad = 3
  const all = series.flatMap(s => s.values).filter(Number.isFinite)
  const lo = yMin ?? (all.length > 0 ? Math.min(...all) : 0)
  const hi = yMax ?? (all.length > 0 ? Math.max(...all) : 1)
  const span = hi - lo || 1
  const x = (i, n) => pad + (width - 2 * pad) * (n <= 1 ? 1 : i / (n - 1))
  const y = (v) => pad + (height - 2 * pad) * (1 - (v - lo) / span)

  const svg = svgRoot(width, height, `Sparkline of ${series.map(s => s.name).join(', ')}`, 'sparkline')
  for (const s of series) {
    if (s.values.length === 0) continue
    const pts = s.values.map((v, i) => [x(i, s.values.length), y(v)])
    const line = el('polyline', {
      class: 'spark-line',
      points: pts.map(p => p.map(n => num(n, 1)).join(',')).join(' '),
      fill: 'none', stroke: s.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    })
    line.appendChild(el('title', {}, `${s.name}: ${s.values.length} points, last ${formatValue(s.values.at(-1))}`))
    svg.appendChild(line)
    const [lx, ly] = pts.at(-1)
    svg.appendChild(el('circle', { class: 'spark-end', cx: num(lx, 1), cy: num(ly, 1), r: 2.6, fill: s.color }))
  }
  return svg
}

/**
 * Grouped bars with optional CI whiskers: one group per category, one bar per
 * series. Bars missing from the data (non-finite value) are skipped; a series
 * with a `ci` array aligned to categories draws a whisker per present bar.
 * @param {object} spec
 * @param {string[]} spec.categories - x-axis groups.
 * @param {{ name: string, color: string, values: number[], ci?: [number, number][] }}[] spec.series - bar series.
 * @param {string} [spec.yLabel] - y-axis label.
 * @param {number} [spec.yMax] - fixed domain top; defaults to a rounded data max.
 * @param {(value: number) => string} [spec.formatValue] - tick/tooltip formatter.
 * @returns {SVGElement}
 */
export function groupedBarChart({ categories, series, yLabel, yMax, formatValue = (v) => num(v) }) {
  const W = 720
  const H = 360
  const m = { t: 36, r: 16, b: 50, l: 58 }
  const plotW = W - m.l - m.r
  const plotH = H - m.t - m.b
  const dataMax = finiteMax([
    ...series.flatMap(s => s.values),
    ...series.flatMap(s => (s.ci ?? []).filter(Boolean).flatMap(([lo, hi]) => [lo, hi])),
  ])
  const domain = yMax ?? niceCeil(dataMax ?? 1)
  const y = (v) => m.t + plotH * (1 - v / domain)

  const svg = svgRoot(W, H, `Grouped bar chart${yLabel ? ` of ${yLabel}` : ''}`, 'grouped-bar')
  svg.appendChild(legendG(series, m.l, 6))
  for (let i = 0; i <= 5; i++) {
    const v = (domain * i) / 5
    const yy = y(v)
    svg.appendChild(el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: 'var(--grid)' }))
    svg.appendChild(el('text', { class: 'tick-label', x: m.l - 7, y: yy + 3.5, 'text-anchor': 'end', fill: 'var(--muted)' }, formatValue(v)))
  }
  svg.appendChild(el('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: 'var(--border)' }))
  if (yLabel) {
    svg.appendChild(el('text', { class: 'axis-label', x: 14, y: m.t + plotH / 2, 'text-anchor': 'middle', fill: 'var(--muted)', transform: `rotate(-90 14 ${m.t + plotH / 2})` }, yLabel))
  }

  const band = plotW / Math.max(1, categories.length)
  const slot = (band * 0.8) / Math.max(1, series.length)
  const barW = Math.max(2, slot * 0.78)
  const rotate = categories.length > 5
  categories.forEach((cat, catIdx) => {
    const bandX = m.l + catIdx * band
    series.forEach((s, si) => {
      const v = s.values[catIdx]
      if (!Number.isFinite(v)) return
      const cx = bandX + band * 0.1 + si * slot + slot / 2
      const interval = s.ci?.[catIdx]
      const rect = el('rect', {
        class: 'bar', x: cx - barW / 2, y: y(v), width: barW, height: Math.max(0, plotH * (v / domain)), fill: s.color, rx: 2,
      })
      rect.appendChild(el('title', {}, `${s.name} · ${cat}: ${formatValue(v)}${interval ? ` (95% CI ${formatValue(interval[0])}–${formatValue(interval[1])})` : ''}`))
      svg.appendChild(rect)
      if (interval) {
        const lo = Math.max(0, Math.min(interval[0], interval[1]))
        const hi = Math.min(domain, Math.max(interval[0], interval[1]))
        const g = el('g', { class: 'ci', stroke: 'var(--text)', 'stroke-width': 1.4 })
        g.appendChild(el('line', { x1: cx, x2: cx, y1: y(hi), y2: y(lo) }))
        g.appendChild(el('line', { x1: cx - 3.5, x2: cx + 3.5, y1: y(hi), y2: y(hi) }))
        g.appendChild(el('line', { x1: cx - 3.5, x2: cx + 3.5, y1: y(lo), y2: y(lo) }))
        svg.appendChild(g)
      }
    })
    const lx = bandX + band / 2
    const ly = y(0) + (rotate ? 10 : 16)
    svg.appendChild(el('text', rotate
      ? { class: 'cat-label', x: lx, y: ly, 'text-anchor': 'end', fill: 'var(--text)', transform: `rotate(-22 ${lx} ${ly})` }
      : { class: 'cat-label', x: lx, y: ly, 'text-anchor': 'middle', fill: 'var(--text)' }, cat))
  })
  return svg
}

/**
 * Paired scatter: one point per task, x = off value, y = on value, with a
 * dashed diagonal tie line. Points are colored by which side of the line they
 * fall on; non-finite points are skipped.
 * @param {object} spec
 * @param {{ id: string, x: number, y: number }[]} spec.points - paired points.
 * @param {string} spec.xLabel - x-axis label.
 * @param {string} spec.yLabel - y-axis label.
 * @returns {SVGElement}
 */
export function pairedScatter({ points, xLabel, yLabel }) {
  const W = 520
  const H = 380
  const m = { t: 24, r: 24, b: 52, l: 58 }
  const plotW = W - m.l - m.r
  const plotH = H - m.t - m.b
  const max = niceCeil(finiteMax(points.flatMap(p => [p.x, p.y])) ?? 1)
  const x = (v) => m.l + plotW * (v / max)
  const y = (v) => m.t + plotH * (1 - v / max)

  const svg = svgRoot(W, H, `Paired scatter of ${yLabel} against ${xLabel}`, 'paired-scatter')
  svg.appendChild(legendG([
    { name: 'on better', color: 'var(--heat-good)' },
    { name: 'off better', color: 'var(--heat-bad)' },
    { name: 'tie', color: 'var(--muted)' },
  ], m.l, 4))
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5
    svg.appendChild(el('line', { class: 'grid', x1: x(v), x2: x(v), y1: m.t, y2: m.t + plotH, stroke: 'var(--grid)' }))
    svg.appendChild(el('line', { class: 'grid', x1: m.l, x2: m.l + plotW, y1: y(v), y2: y(v), stroke: 'var(--grid)' }))
    svg.appendChild(el('text', { class: 'tick-label', x: x(v), y: m.t + plotH + 15, 'text-anchor': 'middle', fill: 'var(--muted)' }, num(v)))
    svg.appendChild(el('text', { class: 'tick-label', x: m.l - 7, y: y(v) + 3.5, 'text-anchor': 'end', fill: 'var(--muted)' }, num(v)))
  }
  svg.appendChild(el('line', {
    class: 'tie-line', x1: x(0), y1: y(0), x2: x(max), y2: y(max), stroke: 'var(--muted)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4',
  }))
  svg.appendChild(el('text', { class: 'axis-label', x: m.l + plotW / 2, y: H - 8, 'text-anchor': 'middle', fill: 'var(--muted)' }, xLabel))
  svg.appendChild(el('text', { class: 'axis-label', x: 14, y: m.t + plotH / 2, 'text-anchor': 'middle', fill: 'var(--muted)', transform: `rotate(-90 14 ${m.t + plotH / 2})` }, yLabel))
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const color = p.y > p.x ? 'var(--heat-good)' : p.y < p.x ? 'var(--heat-bad)' : 'var(--muted)'
    const dot = el('circle', {
      class: 'point', cx: num(x(p.x), 1), cy: num(y(p.y), 1), r: 5.5, fill: color, 'fill-opacity': 0.9, stroke: 'var(--bg)', 'stroke-width': 1,
    })
    dot.appendChild(el('title', {}, `${p.id}: ${xLabel} ${num(p.x)}, ${yLabel} ${num(p.y)}`))
    svg.appendChild(dot)
  }
  return svg
}

/**
 * Radar over strata or metric groups: concentric polygon rings at 25% steps of
 * `max`, one spoke and label per axis, one filled polygon per series.
 * @param {object} spec
 * @param {string[]} spec.axes - axis names around the wheel.
 * @param {{ name: string, color: string, values: number[] }[]} spec.series - value per axis, clamped to [0, max].
 * @param {number} [spec.max] - ring ceiling; defaults to a rounded data max.
 * @returns {SVGElement}
 */
export function radarChart({ axes, series, max }) {
  const W = 480
  const H = 380
  const cx = 200
  const cy = 200
  const R = 128
  const cap = max ?? niceCeil(finiteMax(series.flatMap(s => s.values)) ?? 1)
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length
  const point = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))]

  const svg = svgRoot(W, H, `Radar chart over ${axes.join(', ')}`, 'radar')
  for (const f of [0.25, 0.5, 0.75, 1]) {
    svg.appendChild(el('polygon', {
      class: 'ring', points: axes.map((_, i) => point(i, R * f).map(n => num(n, 1)).join(',')).join(' '), fill: 'none', stroke: 'var(--grid)',
    }))
  }
  axes.forEach((axis, i) => {
    const [ex, ey] = point(i, R)
    svg.appendChild(el('line', { class: 'spoke', x1: cx, y1: cy, x2: num(ex, 1), y2: num(ey, 1), stroke: 'var(--grid)' }))
    const [lx, ly] = point(i, R + 16)
    const cos = Math.cos(angle(i))
    const anchor = cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle'
    svg.appendChild(el('text', { class: 'axis-label', x: num(lx, 1), y: num(ly + 3, 1), 'text-anchor': anchor, fill: 'var(--text)' }, axis))
  })
  for (const s of series) {
    const pts = axes.map((_, i) => point(i, (R * Math.min(Math.max(s.values[i] ?? 0, 0), cap)) / cap))
    const poly = el('polygon', {
      class: 'series', points: pts.map(p => p.map(n => num(n, 1)).join(',')).join(' '), fill: s.color, 'fill-opacity': 0.22, stroke: s.color, 'stroke-width': 2,
    })
    poly.appendChild(el('title', {}, `${s.name}: ${axes.map((a, i) => `${a} ${num(s.values[i] ?? 0)}`).join(', ')}`))
    svg.appendChild(poly)
    for (const [px, py] of pts) svg.appendChild(el('circle', { class: 'vertex', cx: num(px, 1), cy: num(py, 1), r: 3, fill: s.color }))
  }
  svg.appendChild(legendG(series, 362, 24, true))
  return svg
}

/**
 * Horizontal delta chart: one bar per category centered on a zero line,
 * colored by sign, with a horizontal CI whisker and the signed value at the
 * whisker's outer end.
 * @param {object} spec
 * @param {{ id: string, delta: number, ci: [number, number] }[]} spec.items - one row per category.
 * @param {string} [spec.xLabel] - x-axis label.
 * @returns {SVGElement}
 */
export function deltaChart({ items, xLabel }) {
  const W = 720
  const rowH = 34
  const m = { t: 26, r: 96, b: 32, l: 184 }
  const H = m.t + Math.max(1, items.length) * rowH + m.b
  const plotW = W - m.l - m.r
  const absMax = finiteMax(items.flatMap(it => [Math.abs(it.delta), ...it.ci.map(Math.abs)]))
  const half = niceCeil(absMax ?? 1)
  const x = (v) => m.l + (plotW * (v + half)) / (2 * half)

  const svg = svgRoot(W, H, `Delta chart${xLabel ? ` of ${xLabel}` : ''}`, 'delta')
  svg.appendChild(legendG([
    { name: 'on better', color: 'var(--heat-good)' },
    { name: 'off better', color: 'var(--heat-bad)' },
  ], m.l, 2))
  for (const v of [-half, 0, half]) {
    const zero = v === 0
    svg.appendChild(el('line', {
      class: zero ? 'zero' : 'grid', x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, stroke: zero ? 'var(--muted)' : 'var(--grid)', 'stroke-width': zero ? 1.4 : 1,
    }))
    svg.appendChild(el('text', { class: 'tick-label', x: x(v), y: H - m.b + 14, 'text-anchor': 'middle', fill: 'var(--muted)' }, fmtSigned(v)))
  }
  if (xLabel) {
    svg.appendChild(el('text', { class: 'axis-label', x: m.l + plotW / 2, y: H - 2, 'text-anchor': 'middle', fill: 'var(--muted)' }, xLabel))
  }
  items.forEach((it, i) => {
    const cy = m.t + i * rowH + rowH / 2
    svg.appendChild(el('text', { class: 'item-label', x: m.l - 8, y: cy + 3.5, 'text-anchor': 'end', fill: 'var(--text)' }, it.id))
    const d = it.delta
    const color = d > 0 ? 'var(--heat-good)' : d < 0 ? 'var(--heat-bad)' : 'var(--muted)'
    const x0 = x(Math.min(0, d))
    const x1 = x(Math.max(0, d))
    const rect = el('rect', {
      class: 'delta-bar', x: x0, y: cy - 8, width: Math.max(1, x1 - x0), height: 16, fill: color, rx: 2,
    })
    rect.appendChild(el('title', {}, `${it.id}: ${fmtSigned(d)} (95% CI ${fmtSigned(it.ci[0])} … ${fmtSigned(it.ci[1])})`))
    svg.appendChild(rect)
    const lo = Math.min(it.ci[0], it.ci[1])
    const hi = Math.max(it.ci[0], it.ci[1])
    const g = el('g', { class: 'ci', stroke: 'var(--text)', 'stroke-width': 1.4 })
    g.appendChild(el('line', { x1: x(lo), x2: x(hi), y1: cy, y2: cy }))
    g.appendChild(el('line', { x1: x(lo), x2: x(lo), y1: cy - 5, y2: cy + 5 }))
    g.appendChild(el('line', { x1: x(hi), x2: x(hi), y1: cy - 5, y2: cy + 5 }))
    svg.appendChild(g)
    const right = d >= 0
    svg.appendChild(el('text', {
      class: 'value-label', x: right ? x(hi) + 6 : x(lo) - 6, y: cy + 3.5, 'text-anchor': right ? 'start' : 'end', fill: 'var(--muted)',
    }, fmtSigned(d)))
  })
  return svg
}
