/**
 * Classify how much J-Space protocol this turn earns.
 * Pure function of the last human text, whether a card is open, and seat mode.
 * Reconstructable from the session log; no extra event.
 */

/** How much protocol to mount for this assembly. */
export type JspacePass = 'fast' | 'full' | 'loop'

/** Inputs the gate may read. All are log- or config-derived. */
export interface JspacePassInput {
  /** Latest human user text, or empty when none exists. */
  readonly text: string
  /** True when a native card is already open. */
  readonly cardOpen: boolean
  /** True when Settings `mode` is `always-open`. */
  readonly alwaysOpen: boolean
}

// Term lists are English-only by repo convention (no non-ASCII needles in
// source); a request the lists do not cover classifies by length only, which
// under-mounts protocol rather than over-mounting it. The lists are
// heuristics with no measured basis yet — W0 pass-distribution telemetry is
// the instrument that calibrates them.
const LOOP_TERMS =
  /\b(across|multi-?file|persist|resume|refactor|throughout|every file|long-?horizon|multi-?stage|multi-?turn)\b/iu
const FULL_TERMS =
  /\b(implement|verify|debug|plan|compare|investigate|fix all|step by step|and then)\b/iu

/**
 * Choose the pass for this turn.
 * @param input - last human text and card/mode flags.
 * @returns `loop` when state must persist, `full` for a bounded multi-step job, else `fast`.
 */
export function classifyJspacePass(input: JspacePassInput): JspacePass {
  if (input.cardOpen || input.alwaysOpen) return 'loop'
  const text = input.text.trim()
  if (text.length === 0) return 'fast'
  if (LOOP_TERMS.test(text) || text.length > 400) return 'loop'
  if (FULL_TERMS.test(text) || text.length > 140) return 'full'
  return 'fast'
}
