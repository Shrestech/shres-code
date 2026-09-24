# @shres-code/shres-code-client-ui-model-routing

Model-routing status chip, a pure browser surface plugin. The browser half occupies the conversation-declared `conversation.input.modelRouting` single seat in the composer tool row, immediately left of the model-select seat; the node half is an empty apply (the roster row). Routing itself — the `/route` command, the two log-only routing events, the sticky fold, and the `modelRouting` projection — is owned by [`@shres-code/shres-code-model-router`](../../llm/model-router/README.md), composed independently on the host roster.

The chip reads the host-computed `modelRouting` projection through the framework `useProjection` seat and holds no routing state of its own. It states the routing mode alone: while the projection's `active` is false the button is the `Auto` affordance that executes `/route on`, and while it is true the button reads `auto` and executes `/route off`. The chip names no routed model, no confidence, no streak position, and no model hint: those render in the trajectory and the full session log, where inspection is deliberate. An ambient routed route on the chat surface invites the manual pick of it, which dead-ends routing — the session's own selection becomes a pool candidate, so every later decision resolves `base-unlisted` (routing does not start from a pool model) or, when that model is also listed in `routeFrom`, `candidate-equals-base`, and nothing can downgrade. Each of the two reasons has its own idle warning.

A session in that state renders the routing-idle warning beside the chip, plus a one-click `Restore strong model` control. The restore submits the projection's retained `lastStrong` route — the route the last downgraded streak was entered on, kept after that streak broke — through the session's model-selection directory (`ctx.modelDirectories`, the same `ModelDirectory.select` the composer picker and the `/model` popup submit through), so the session's own selection changes and no second selection mechanism exists. That service is optional: a deployment composing no model-selection surface keeps the chip, and the restore reports the absence in its own inline failure line. The restore's copy states what the selection change costs: one prefix re-prefill on the next request.

Admission failures (`matched: false`, business errors, transport faults) surface as an inline error line while the chip stays until the projection confirms the change, and a gesture in flight disables both controls and reports `aria-busy`. Each gesture keeps its own English failure label, because a refused selection is not a refused mode switch.

Absence is the one mode the seat draws nothing for: a host composing no router registers no `modelRouting` projection, so the seat renders nothing at all and an unoccupied seat costs no layout. Addressed subagent sessions render nothing either, through the same `sessions.subagentAddress` guard the model seat uses, because the Agent-bound command channel would activate persisted child history outside the direct-parent continuation path.

A flip requests the mode through the command line a user could equally type, and the host commits it as a logged mode event — between turns at once, during an open turn at the next accepted pre-step. The chip's own in-flight state covers that wait; the projection's `pending` field is not mirrored, because the requested mode is already visible as the gesture's own feedback and a second client-side read of it would be a copy of host state.

The `/client` exports are the plugin body (`apply`/`inject`) and the seat's injected face type.

## Model Experience

Indirectly, through the `/route on` and `/route off` command lines the chip dispatches and the model selection the restore submits: `@shres-code/shres-code-model-router` owns the logged mode, the sticky fold, and the route the consult selects for the next turn, while this package only renders the projection, sends what a user could equally type, and submits a selection through the selection surface's own path.

#### KV Cache effect

Ending or starting a downgraded streak is what puts the next turn on another route, and that transition is the re-prefill the streak bounds; the chip itself adds no prompt content. The restore is the one deliberate selection change this package can cause, and it pays the same cost once: the next request re-prefills its prefix, which is why the control states that cost and is offered only while routing is idle, where no held streak is amortizing anything.

## Known Limitations and Deferred Work

- **A session that never entered a downgraded streak has no route to restore** — the idle warning renders alone, because the projection carries no entry base to point the selection back at.
- **The mode and the restore are the only routing controls here** — the candidate allowlist, the gate thresholds, and the judgment engine are host composition plus the `model-router` settings namespace; the chip neither reads nor writes them.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as an approval or question takeover replaces the InputBar and its chip.
