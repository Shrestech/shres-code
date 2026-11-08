# Agent Note: Bounded work and retention during long desktop chats

Status: implemented

## Problem

A long active chat combines growing text, repeated Step closures, historical projections, and transport backpressure. Coalescing browser publication does not bound the work inside each reducer or the producer queue behind a paused renderer. Keeping every previously opened event window also makes memory grow across session switches.

## Decision

Assistant reducers remember the first visible sequence and stop rescanning accumulated text once visibility is established. Their State does not derive from mutable Location metadata, so they declare `locationUpdates: 'project'`: live Step/Turn changes refresh Matches and rebuild Location data and view Nodes without replaying the accumulated chunks. Definitions that derive State from Location metadata retain replay; history prepends and predecessor changes replay both kinds. This extends the [Conversation assembler](2026-08-09-client-conversation-node-assembly.md) without changing its dependency semantics.

The [Trajectory builder](2026-08-11-trajectory-conversation-context-assembly.md) preserves completed event, request, and location collections when only the active Assistant partial changes. Request metadata changes remain observable; structural transitions use the full projection. Chat mounts a measured viewport of keyed rows while retaining its logical order. Session-scoped viewing stores preserve expanded reasoning, context, command, compaction, and Tool rows across virtual remounts; retry rows retain their first browser-observed deadline. The existing settings namespace carries validated row-window tunables from the Desktop Host composition to the client.

Only the staged Session retains a raw and assembled conversation window. Off-screen Session identities, scopes, drafts, interactions, queues, and projections survive. A released Session remembers its earliest loaded sequence and fetches back to that position on return, preserving expanded-history scroll anchors without retaining the events. Generation checks reject outstanding history reads after release or reconnect. Generation death clears transient waits and errors before fresh stream frames arrive; the following history refresh preserves replayed approvals and questions. Same-session reconnects re-arm semantic scroll restoration. A temporary missing selection keeps the staged frozen view.

The API producer queues complement the [desktop response-pipe bounds](2026-10-04-desktop-response-pipe.md). Each stream has validated frame and serialized-byte limits. Overflow ends that consumer, releases buffered frames and listeners, and lets the existing reconnect protocol rebuild from durable history and stream baselines. Frames are never silently discarded within a surviving stream. A single oversized envelope also terminates the stream with a diagnostic naming the byte setting.

Desktop lifecycle diagnostics retain one bounded current lifecycle record and the latest failure record for renderer hangs, recovery, renderer exits, and host failure, without conversation payloads. They provide evidence for native failures that browser stress tests cannot reproduce.

## Alternatives considered

- **Replay every Assistant chunk when a Step closes.** Location closure changes presentation but not accumulated Assistant content; replay makes work grow with every earlier chunk in the Turn.
- **Skip Location replay for every Definition.** A reducer may legitimately derive State from Location metadata. The explicit projection option applies only to Definitions that meet its precondition.
- **Keep a cache of all opened event windows.** This makes memory depend on browsing history. Retaining only sequence coordinates trades a history read on return for reclaimable inactive windows.
- **Drop queued events to keep a connection alive.** Missing events or approvals would make the client disagree with the Host. Ending the stream makes recovery explicit and reconstructable.
- **Mount the full Chat history.** Virtualized rows bound DOM work; logical node data remains available for ordering and pagination.

## Consequences

Ordinary streaming avoids repeated historical reduction and projection. Structural history changes and the selected Session's raw event window can still grow with the explicitly loaded conversation. Returning to an expanded inactive chat requires history reads before restoration. Queue limits are configurable because a single large event can exceed the byte budget; raising them increases maximum retained transport data. Focused lifecycle and reducer tests, the keyless reasoning-chunk stress lane, long-history continuation/soak benchmarks, and assembled browser scroll scenarios cover these decisions. Native crash elimination requires observing the packaged application; passing browser tests alone does not establish it.
