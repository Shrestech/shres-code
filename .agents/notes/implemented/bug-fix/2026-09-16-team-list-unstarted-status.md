# Agent Note: `team_list` uses `unstarted` for reserved seats

Status: implemented

## Problem

`team_list` printed reserved template seats as `inactive`. That word reads as crashed, stopped, or failed, and it collides with `list_agents` service-layer `inactive` (storage-only, resumable). A Lead that has never addressed Aegis, Stride, or Ward therefore reports three "inactive" members while `list_agents` correctly returns `(no subagents)`. The seats never began; they are reserved names waiting for the first Lead `team_send` or named-seat call.

`inactive` was also the fallback when a started teammate's Agent was not loaded. One label covered two facts.

## Decision

Roster liveness is `running | idle | unstarted | inactive | provisioning | failed`.

- **`unstarted`** is a reserved template name with no session.
- **`inactive`** is a started member whose Agent is not loaded.
- **`idle`** is a loaded Agent between turns.
- **`running`** is a loaded Agent in a turn.

`team_list` states those distinctions and says `unstarted` is not crashed or stopped. It also says the snapshot is not a delivery promise; `team_send` remains the authoritative check. The durable `TeamMemberPhase` (`provisioning` / `active` / `failed`) is unchanged. [`list_agents` still maps storage-only children to `ready`](2026-08-06-list-agents-residency-vocabulary.md); this roster word is a different question.

## Alternatives considered

**Keep `inactive` and qualify it in the tool description.** Rejected: a description saying that `inactive` does not mean inactive loses to the rendered status on every read. The same reason retired `complete` on `list_agents`.

**Reuse `ready` for reserved seats.** Rejected: `list_agents` `ready` means a durable conversation exists and `send_message` can resume it. A reserved seat has no session.

**Map only the model-facing adapter and leave the service as `inactive`.** Rejected: the chat-header roster shows the same status to a person. Renaming the shared `TeamMemberStatus` keeps the two surfaces aligned.

## Consequences

`team_list` renders `aegis (unstarted)` before first provision. Package tests pin the template row, the rendered line, and the description clauses. The Team panel treats `unstarted` as non-navigable. The wire roster schema accepts `unstarted`.
