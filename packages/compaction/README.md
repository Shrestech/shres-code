# compaction/ — compaction capability family

A compaction capability family (see capability seams): a Service Definition, a summarizing provider, a model-free tool-result pruning companion, and a human command Consumer. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`compaction/`](compaction/README.md) | Compaction seam and event vocabulary | `ctx.compaction` |
| [`compaction-basic/`](compaction-basic/README.md) | Token-pressure and summarization backend | registers `ctx.compaction` |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.md) | Optional model-free tool-result pruning | `ctx.toolResultPruner` |
| [`command-compact/`](command-compact/README.md) | Human compaction command | registers on `ctx.commands` |

The backend, optional pruner, and human command compose through the seam; token measurement remains a separate LLM-family service.

The subsystem reference — the `compaction/*` events, `CompactionResult`, the service, pruning outcomes — is [docs/subsystems/compaction.md](../../docs/subsystems/compaction.md). The seam deliberately depends on `shres-session` and `shres-llm`.
