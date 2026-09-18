# @shres-code/shres-code-client-ui-model-routing

Model-routing status chip, a pure browser surface plugin. The browser half occupies the conversation-declared `conversation.input.modelRouting` single seat in the composer tool row, immediately left of the model-select seat; the node half is an empty apply (the roster row). Routing itself — the `/route` command, the two log-only routing events, the sticky fold, and the `modelRouting` projection — is owned by [`@shres-code/shres-code-model-router`](../../llm/model-router/README.md), composed independently on the host roster.

The chip reads the host-computed `modelRouting` projection through the framework `useProjection` seat and holds no routing state of its own. It is a toggle, so both modes render: while the projection's `active` is false the button is the `Auto` affordance that executes `/route on` through `command.execute`; while it is on the button reads `auto → <model> (<confidence>)` from the last logged decision, with the held streak's elapsed turns (`turn 3`) and the `consider-stronger` hint line beside it, and executes `/route off`. Admission failures (`matched: false`, business errors, transport faults) surface as an inline error line while the chip stays until the projection confirms the change, and a flip in flight disables the button and reports `aria-busy`.

Absence is the one mode the seat draws nothing for: a host composing no router registers no `modelRouting` projection, so the seat renders nothing at all and an unoccupied seat costs no layout. Addressed subagent sessions render nothing either, through the same `sessions.subagentAddress` guard the model seat uses, because the Agent-bound command channel would activate persisted child history outside the direct-parent continuation path.

A flip requests the mode through the command line a user could equally type, and the host commits it as a logged mode event — between turns at once, during an open turn at the next accepted pre-step. The chip's own in-flight state covers that wait; the projection's `pending` field is not mirrored, because the requested mode is already visible as the gesture's own feedback and a second client-side read of it would be a copy of host state.

The `/client` exports are the plugin body (`apply`/`inject`) and the seat's injected face type.

## Model Experience

Indirectly, through the `/route on` and `/route off` command lines the chip dispatches: `@shres-code/shres-code-model-router` owns the logged mode, the sticky fold, and the route the consult selects for the next turn, while this package only renders the projection and sends what a user could equally type.

#### KV Cache effect

Ending or starting a downgraded streak is what puts the next turn on another route, and that transition is the re-prefill the streak bounds; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

- **The chip shows the elapsed streak, not its amortization horizon** — the projection's sticky view carries `turnsElapsed` and the held route, while `minTurnsDowngraded` is host configuration the projection does not publish, so the chip renders `turn 3` rather than `turn 3 of ≥5`.
- **The mode is the only routing control here** — the candidate allowlist, the gate thresholds, and the judgment engine are host composition plus the `model-router` settings namespace; the chip neither reads nor writes them.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as an approval or question takeover replaces the InputBar and its chip.
