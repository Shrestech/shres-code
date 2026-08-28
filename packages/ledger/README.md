# ledger/ — Decision ledger

Durable record of research decisions. `ctx.ledger` stores one entry per accepted, rejected, or deferred hypothesis with the evidence that justifies it; every cited run id must resolve through the mounted tracker, and every record lands as the ignorable `ledger/decision` session event.

| Package | Role |
|---|---|
| [`ledger/`](ledger/README.md) | Service Definition + JSONL store (`ctx.ledger`) | `ctx.ledger` |
| [`tool-ledger/`](tool-ledger/README.md) | `ledger_record_decision` and `ledger_query` tools | — |

Types and semantics: [the decision-ledger subsystem page](../../docs/subsystems/ledger.md).
