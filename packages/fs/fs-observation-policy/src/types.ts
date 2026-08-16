/**
 * Vocabulary for the fs-observation-policy plugin: the minimal execution-context
 * fields used to derive an observed-state owner by narrowing the opaque `object`
 * actor the `fs/*` events carry.
 *
 * The provider vocabulary (`FsTarget`, `FsVersion`, write/edit request types) is
 * re-used from `@roos-code/roos-code-fs`; this package owns only the observed-state
 * owner structure on top of it.
 *
 * @module @roos-code/roos-code-fs-observation-policy/types
 */

/**
 * Minimal structural view of a tool execution the policy plugin needs to derive
 * an observed-state owner. `@roos-code/roos-code-tools`' `ToolExecution` contains
 * these fields, so the tool passes its `exec` straight through as the opaque
 * `object` actor on the `fs/*` events; this plugin narrows that actor to
 * `FsObservationActor` without importing `roos-tools`, `roos-agent`, or `roos-session`.
 *
 * The owner is `agent.session` when present. It is treated as an opaque object
 * identity (a `WeakMap` key); this package never reads any of its fields.
 */
export interface FsObservationActor {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}
