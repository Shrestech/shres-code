/**
 * The browserSkill Remote namespace: the gesture-gated control surface over
 * the managed BrowserSkill runtime (verified provisioning, the owned Chrome
 * stack, and its teardown). It never names a port, a path, or an artifact URL
 * on the wire, registers no tools, and writes no session events. Every
 * method is loopback-pinned through the client-connection PRIVILEGED_METHODS
 * set; the gesture gate lives HERE, in the operations that spend it, because
 * the verb+keepProfile binding needs the mutation semantics the carrier must
 * not learn.
 *
 * The tokens prove a begin-to-spend sequence scoped to one verb and
 * keepProfile choice, from a loopback peer, single use. They do not prove a
 * human gesture against any same-user process that can reach loopback,
 * including a model shell tool whose sandbox permits loopback network access,
 * page script in the same origin, same-user malware, or the existing
 * self-modification capability.
 *
 * Construction is direct: the composition entry builds the runtime (whose
 * owned root lives under the harness home; the gateway never learns it),
 * constructs this gateway over it, and owns the runtime's one awaited dispose
 * effect. There is no config field and no context service carrying the
 * runtime across the boundary.
 * @module @shres-code/shres-code-browserskill/gateway
 */

import type { Context } from '@shres-code/cordis'
import { GestureLedger } from '@shres-code/shres-code-host-remote-control/gesture'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
import type {
  BrowserSkillBeginRequest,
  BrowserSkillControl,
  BrowserSkillErrorCode,
  BrowserSkillFlowRequest,
  BrowserSkillGestureGrant,
  BrowserSkillGestureVerb,
  BrowserSkillStartOutcome,
  BrowserSkillStatus,
  BrowserSkillToken,
  BrowserSkillUninstallRequest,
} from './types.ts'

/**
 * Caller misuse of the browserSkill namespace: a missing, spent, wrong-verb,
 * wrong-keepProfile, or expired gesture; or a keepProfile choice on a verb
 * that takes none. A start the runtime cannot accept is an in-band refusal
 * verdict, not an error. Crosses the wire as the carrier's generic message
 * envelope; the code is for host-side branching and tests, not a wire field.
 */
export class BrowserSkillError extends Error {
  /** Why the call was refused. */
  readonly code: BrowserSkillErrorCode

  /**
   * @param code - why the call was refused.
   * @param message - human-readable refusal, rendered by the client as the wire error message.
   */
  constructor(code: BrowserSkillErrorCode, message: string) {
    super(message)
    this.name = 'BrowserSkillError'
    this.code = code
  }
}

/**
 * Serve the browserSkill namespace over the shared runtime. A spending
 * method spends its gesture, starts the runtime verb, and answers
 * synchronously with the verdict — the accepted operation id, or the
 * refusal. It never answers with the settled promise and never holds the
 * RPC until the work completes: completion is observed by polling status and
 * matching the operation id, never by reading the lifecycle state, so a
 * Ready reached before the operation started cannot be misread as the
 * operation's completion. Its wire vocabulary (requests, grants, verdicts,
 * and caller-misuse codes) is declared in the types-only ./types module.
 */
export class BrowserSkillGateway extends TypertRemoteService {
  static inject = []

  private readonly gestures = new GestureLedger<BrowserSkillGestureVerb>()
  private readonly runtime: BrowserSkillControl

  /**
   * Construct directly from the composition entry; kept class-visible for
   * the generated Typert host artifacts.
   * @param ctx - host context of the composition mounting the namespace.
   * @param runtime - the shared runtime this gateway drives.
   */
  constructor(ctx: Context, runtime: BrowserSkillControl) {
    super(ctx, 'browserSkill')
    this.runtime = runtime
  }

  /**
   * Read the lifecycle picture: state, consent facts, provisioned artifacts,
   * and the most recent operation with its id and phase.
   * @returns the current runtime snapshot.
   */
  @Remote('status')
  status(): BrowserSkillStatus {
    return this.runtime.status()
  }

  /**
   * Mint one one-shot gesture grant bound to the (verb, keepProfile) mutation.
   * @param request - the gesture to authorize.
   * @returns the token and its deadline.
   */
  @Remote('begin')
  begin(request: BrowserSkillBeginRequest): BrowserSkillGestureGrant {
    const alias = gestureAlias(request.verb, request.keepProfile ?? false)
    const minted = this.gestures.mint(request.verb, alias, Date.now())
    // The mint point is where the raw nonce becomes the branded wire token.
    return { token: minted.token as BrowserSkillToken, expiresAt: new Date(minted.expiresAt).toISOString() }
  }

  /**
   * Start the disclosed provision flow: verified downloads, the extension in
   * the owned profile, the owned browser launch, and the observed connection
   * — one consent, no hidden second step.
   * @param request - the granted provision.
   * @returns the accepted operation id, or the refusal.
   */
  @Remote('provision')
  provision(request: BrowserSkillFlowRequest): BrowserSkillStartOutcome {
    return this.accept('provision', request.token)
  }

  /**
   * Open the provisioned stack again.
   * @param request - the granted open.
   * @returns the accepted operation id, or the refusal.
   */
  @Remote('open')
  open(request: BrowserSkillFlowRequest): BrowserSkillStartOutcome {
    return this.accept('open', request.token)
  }

  /**
   * Ordered shutdown: browser sessions, browser, daemon, then the lease.
   * @param request - the granted close.
   * @returns the accepted operation id, or the refusal.
   */
  @Remote('close')
  close(request: BrowserSkillFlowRequest): BrowserSkillStartOutcome {
    return this.accept('close', request.token)
  }

  /**
   * Delete the owned profile and its sign-ins, close if running, and pick a
   * fresh daemon port on the next start. The UI must have shown the explicit
   * destructive warning before minting this token.
   * @param request - the granted reset.
   * @returns the accepted operation id, or the refusal.
   */
  @Remote('reset')
  reset(request: BrowserSkillFlowRequest): BrowserSkillStartOutcome {
    return this.accept('reset', request.token)
  }

  /**
   * Remove the provisioned artifacts; the owned profile and its sign-ins
   * survive only when keepProfile is true.
   * @param request - the granted uninstall with its keepProfile choice.
   * @returns the accepted operation id, or the refusal.
   */
  @Remote('uninstall')
  uninstall(request: BrowserSkillUninstallRequest): BrowserSkillStartOutcome {
    return this.accept('uninstall', request.token, request.keepProfile)
  }

  /**
   * Spend one gesture and start one runtime verb. The token is consumed
   * whatever the verdict, so a refused attempt cannot leave a reusable
   * authorization behind, and the verdict crosses the wire as-is: the
   * runtime refuses a start in-band, so no operation-in-progress or disposed
   * condition is an error here.
   */
  private accept(verb: BrowserSkillGestureVerb, token: BrowserSkillToken, keepProfile?: boolean): BrowserSkillStartOutcome {
    const choice = keepProfile === true
    const alias = gestureAlias(verb, choice)
    if (!this.gestures.consume(token, verb, alias, Date.now())) {
      throw new BrowserSkillError(
        'gesture-refused',
        'no unspent gesture token for ' + verb + ' (keepProfile ' + String(choice) + '); call browserSkill/begin first',
      )
    }
    const verdict = verb === 'uninstall'
      ? this.runtime.start('uninstall', { keepProfile: choice })
      : this.runtime.start(verb)
    // Only the verdict serializes: the settled promise stays in-process, and
    // this method answers before the operation finishes.
    return verdict.accepted
      ? { accepted: true, operationId: verdict.operationId }
      : { accepted: false, refusal: verdict.refusal }
  }
}

/** The ledger alias encoding one verb's keepProfile choice: the full mutation identity a token is bound to. */
function gestureAlias(verb: BrowserSkillGestureVerb, keepProfile: boolean): string {
  if (verb !== 'uninstall' && keepProfile) {
    // Reset deletes unconditionally, and the flow verbs take no choice at all.
    throw new BrowserSkillError('invalid-verb-profile', 'verb "' + verb + '" takes no keepProfile choice')
  }
  if (verb === 'uninstall') return keepProfile ? 'keep' : 'delete'
  return verb === 'reset' ? 'delete' : 'flow'
}

export default BrowserSkillGateway
