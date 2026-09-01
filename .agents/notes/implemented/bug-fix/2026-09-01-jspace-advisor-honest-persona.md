# Agent Note: jspace-advisor honest persona and consult channel

Status: implemented

## Problem

The standing reviewer persona always instructed the child to call `session_event_read`, and the consult prompt repeated that instruction. Shipped `reviewerTools` are wiki-only and no bundle mounts `tool-session-query`, so a literal child spent its one tool call on an unknown name. Consult children also received the standing persona, which demands `{"verdict","advice","redirect"}` JSON against consult's structured `{"advice","recommendation"}` schema. Trusted main-session copy told the frontier model to "act on a Redirect when it matches the user goal," which treated untrusted advice as an order.

## Decision

Persona and consult prompt mention `session_event_read` only when `parentEventReadAllowed(reviewerTools, mounted)` is true: the name is in `reviewerTools` and `ctx.tools.get('session_event_read')` is defined. Wiki-only default and an unmounted name both omit the tool. Consult starts with `buildConsultPersona` and never the standing verdict-JSON persona. `MAIN_SESSION_ADVISOR_RULES` calls a Redirect a suggestion to follow only if it still serves the user's messages.

## Alternatives considered

**Always advertise the parent read and rely on the tool filter.** The filter rejects unknown names at child start or at the call. The persona still trains the model to spend the turn on a tool it does not have.

**One shared persona with a consult outputSchema override.** Structured output usually wins, but the standing verdict-JSON sentences remain false on the consult path.

**Keep "act on a Redirect" and depend on the untrusted frame.** The trusted sentence is a frame bypass: the reviewer authors `redirect` and the harness tells the main model to execute it.

## Consequences

Deployments that mount `tool-session-query` and add `session_event_read` to `reviewerTools` still get the self-read warning and the one-event instruction. A custom `config.persona` still overrides the standing child only; consult stays on the consult persona. Redirects remain visible in the untrusted frame; the trusted block no longer orders them.

## Verification

Review specs pin `parentEventReadAllowed` and the two persona builders. Consult specs pin `buildConsultPrompt` with and without the parent read. The apply harness: default consult persona and prompt omit `session_event_read` and verdict JSON; a mounted filtered tool advertises it; a card-open assembly prints "A Redirect is a suggestion" and not "act on a Redirect".
