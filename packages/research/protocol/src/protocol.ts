/**
 * The static researcher-cycle prompt section: mounted while the autoresearch
 * toggle is enabled, empty otherwise.
 * @module @shres-code/shres-code-research-protocol/protocol
 */

/** System-prompt section name. */
export const RESEARCH_PROTOCOL_SECTION_NAME = 'research:protocol'

/**
 * Section order: the first slot after the J-Space sections (charter seed 43,
 * card 45, protocol 46, capacity 47, broadcast 48, extra modules 49+).
 */
export const RESEARCH_PROTOCOL_SECTION_ORDER = 50

/** The cycle rules, verbatim in every enabled request. */
export const RESEARCH_PROTOCOL_SECTION_TEXT = `research:protocol — you are running an autonomous research cycle.
Repeat: hypothesis → design defense → experiment → evidence → verdict → ledger → digest.
- Before logging any experiment run, the current Goal epoch must hold completed calls from every debate seat. An unresolved seat challenge downgrades the run to a probe sized to answer the challenge, not the hypothesis.
- Log runs only through experiment_log_run with decisionRule, dataVersion, and gitSha; include machineRule so the verdict can be re-executed mechanically.
- A verdict of supported requires experiment_verify_decision_rule on the run returning satisfied — the ledger refuses an accepted or rejected decision whose runs do not verify. Reviewer seats grade interpretation and contamination only; reviewer praise never substitutes for the mechanical check.
- Record every accepted or rejected hypothesis in the ledger, citing the run ids that justify it.`

/** Appended while the J-Space card is open; the card workflow presumes its surfaces. */
export const RESEARCH_PROTOCOL_CARD_LINE = `- Hold the live hypothesis and design on the J-Space card: Core = hypothesis, Next = current phase.
- Advance the card with jspace_note after each phase, and land each verdict as a Checked line citing its evidence call id.`
