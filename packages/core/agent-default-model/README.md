# @shres-code/shres-code-agent-default-model

The deployment default used when an entry point creates an Agent that has no session-local model selection. `AgentDefaultModelConfig` provides `ctx.agentDefaultModel`; direct entry points such as `shres --profile headless` and Host-backed entry points such as ApiProxy read the same service instead of owning parallel provider/model defaults.

The plugin config requires `{ provider, model }`. That composition entry is the base of the `agent-default-model` Settings section; a mounted settings provider layers the user's choice over it and changes are visible on the next `currentSelection()` read. `reasoningEffort` belongs to the Settings section but deliberately not to plugin config: a complete saved selection can clear an effort when the next selected model has none, while a composition value would be inherited again.

- `ctx.agentDefaultModel.currentSelection()` returns a detached `{ provider, model, reasoningEffort? }` selection for a newly created Agent.
- `ctx.agentDefaultModel.saveSelection(selection, { purpose? })` saves the conversation default, or a `compaction` / `session-title` override under `purposes`. Without a settings provider it is a no-op and the composition entry remains current.
- `ctx.agentDefaultModel.selectionFor(agent)` installs the session-local `ModelSelection` on that Agent's `agent/request` waterfall. `/model` writes this same ref, so a mid-session switch takes effect on the next assembled turn.
- `ctx.agentDefaultModel.selectionForPurpose(purpose)` reads a stored purpose override when one exists.

When a command registry is composed, the service registers `/model [<provider> <model>] [--effort <level>]`. A bare invocation prints the current selection plus advertised models, their efforts, and a `web search` marker when `resolveModelInfo` reports `hostedTools` containing `web_search`. An argued invocation validates the effort against adapter metadata (`LlmReasoningEffortInfo`), writes the session selection, and `saveSelection()`s that pair as the process-wide default. An omitted effort is not persisted even when the adapter materializes `defaultEffort`. `/model` is refused on a subagent session. `commands.execute` records `command/run` with `source: { kind: 'user' }`; the command plane is not a model tool.

The service does not validate catalog membership. A provider route may serve an unadvertised model, and the consumer that actually opens a model request owns availability diagnostics.

## Model Experience

Indirectly, through the provider/model selection supplied to an entry point; request assembly and adapters own the model-visible request.

#### KV Cache effect

Changing the default affects only Agents that subsequently resolve from it. An existing session whose request log already names a selection keeps that selection, so this service does not invalidate its established prefix.

## Known Limitations and Deferred Work

- Compaction and session-title calls go through `ctx.llm.stream()` with `purpose` set; they do not enter `agent/request`, so a stored purpose override is not applied until those consumers read `selectionForPurpose`.
- Without a settings provider, `saveSelection()` cannot retain a selection for a later Agent.
