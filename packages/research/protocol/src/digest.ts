/**
 * Deterministic ship-digest render for one researcher cycle: card state,
 * ledger decisions, and budget snapshot in a stable plain-text block.
 * @module @shres-code/shres-code-research-protocol/digest
 */

/** Card state folded into the digest. */
export interface DigestCard {
  /** The card's Goal line. */
  readonly goal: string
  /** The card's Next line. */
  readonly next: string
  /** Number of Checked lines. */
  readonly checkedCount: number
}

/** One ledger decision folded into the digest. */
export interface DigestDecision {
  /** The hypothesis the decision addresses. */
  readonly hypothesis: string
  /** The decision reached. */
  readonly decision: string
  /** The entry id citing the evidence. */
  readonly entryId: string
}

/** Budget snapshot folded into the digest. */
export interface DigestBudget {
  /** Spent amount in the budget's own unit. */
  readonly spent: number
  /** Remaining amount in the budget's own unit. */
  readonly remaining: number
}

/** Everything {@link renderDigest} renders. */
export interface DigestInput {
  /** Card state; omitted when no card is open. */
  readonly card?: DigestCard
  /** Ledger decisions in display order. */
  readonly ledger?: readonly DigestDecision[]
  /** Budget snapshot; omitted when budget metering is not mounted. */
  readonly budget?: DigestBudget
}

/**
 * Render the deterministic plain-text digest. Pure: equal inputs produce
 * byte-identical output regardless of locale or clock, so a ship digest is
 * reproducible from the durable stores alone.
 * @param input - card, ledger, and budget state.
 * @returns the digest text.
 */
export function renderDigest(input: DigestInput): string {
  const lines: string[] = ['research digest']
  if (input.card !== undefined) {
    lines.push(
      `Goal: ${input.card.goal}`,
      `Next: ${input.card.next}`,
      `Checked: ${input.card.checkedCount}`,
    )
  } else {
    lines.push('Card: (none)')
  }
  if (input.ledger === undefined || input.ledger.length === 0) {
    lines.push('Ledger: (empty)')
  } else {
    lines.push(`Ledger: ${input.ledger.length}`)
    for (const entry of input.ledger) {
      lines.push(`  - ${entry.entryId} ${entry.decision} ${entry.hypothesis}`)
    }
  }
  if (input.budget !== undefined) {
    lines.push(`Budget: spent ${input.budget.spent}, remaining ${input.budget.remaining}`)
  } else {
    lines.push('Budget: (unmetered)')
  }
  return lines.join('\n')
}
