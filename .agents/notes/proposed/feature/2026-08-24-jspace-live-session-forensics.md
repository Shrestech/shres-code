# Agent Note: J-Space live-session forensics after the control loop

Status: proposed

## Problem

The first recorded J-Space dogfood is one session ([session-963a4ee8 in the Claude review](2026-08-18-jspace-deployment-review-and-uplift-claude.md#dogfood-evidence-session-963a4ee8-2026-08-18)): a receipt card, `todo_write` as working memory, and `jspace_ship` never called. The [control loop](../../implemented/feature/2026-08-18-jspace-control-loop.md) then shipped (open-on-open updates Goal/Next, driver lines on every pass, repeat-refusal, todo strip hidden). Live use after that landing is not in the tree. Without a second corpus the next change either re-scrapes `$SHRES_HOME/sessions` or treats the 08-18 reading as the whole picture.

This record is that corpus. It is not W0 ([benchmark suite](../../implemented/testing/2026-08-18-jspace-w0-benchmark-suite.md)): the logs are one machine, mixed models, mixed workspaces, some sessions still live at snapshot. It is the evidence that the [uplift roadmap](2026-08-18-jspace-deployment-review-and-uplift-claude.md) is still the right owner, plus failure modes that note does not already name.

## Proposal

Keep a single J-Space product roadmap — do not open a parallel F-list. Record the 2026-08-23/24 live logs as the second dogfood set, map each finding onto an existing uplift item or a named gap, and treat W0 as the instrument that still settles default-on.

Logs live under `$SHRES_HOME/sessions/` (here `~/.shres/sessions/`). They are not in the repository. Settings at snapshot: `jspace.enabled: true`, `requireCoverage: true`, default model `deepseek-v4-pro:cloud` (ollama-cloud), with seats using zai `glm-5.3`, kimi-cli `kimi-code/k3`, grok-cli `grok-4.6`, and openrouter `ox-alpha`. Workspaces: `shres-code-develop`, `shres-shield`, and one `shres-fearless` session. Seq numbers below are from those JSONL files.

## Corpus

Tool pairing held: `tool/call` matched `tool/result` (about 770 pairs on the first full pass). Unmatched `turn/start` / `step/start` were live in-flight sessions, not torn logs. `jspace_ship` succeeded 12/12 times it was called. `jspace/closed` appears only when the user ran `/j-space off` (develop parent twice, shield parent once).

| Session | Workspace | Role | Tools | Ship | `jspace/closed` | Close-task reading |
|---|---|---|---|---|---|---|
| `session-2ec6708c-…2810` | develop | parent: paper + harness + J-Space → researcher plan | 98/98 | 4 | 2 (user `/j-space off`) | Turns completed; last `todo/write` still `in_progress`; Open question survived a ship |
| `bd8e77f8-…63926` | develop | Stride: tracker seam, 197 steps, one turn | 205/205 | 1 | 0 | Claimed Stage 1 done; Next already Stage 2 |
| `b07a805e-…52771`, `c49e1dbd-…297e9` | develop | Aegis plan / harness review | paired | 1 each | 0 | Stale Next after ship |
| `9b31e1ca-…51f28` | develop | J-Space implementation review | 10/10, zero `jspace_*` | 0 | 0 | Stock card left as `J-Space is on` |
| `session-75857f85-…58881` | develop | grok-cli “review the repo” | 0 logged Shres tools | 0 | 0 | Turns completed; grok tools never hit `tool/call` |
| `session-5c37557b-…85bd7` | shield | parent: G1 then D1 (**live** at snapshot) | 275+ paired | 1 (G1) | 1 (user `/j-space off`) | G1 shipped; D1 reopen inherited G1 Core + 10 checks |
| `ab34da11`, `ef0447b1`, `fd376e9d`, `0e2571b7`, `dc7ad5ff` | shield | Aegis children | paired | 1 each | 0 | note → checkpoint → ship → `report` |
| `93ee95bb-…bcd09` | shield | Aegis accuracy plan | 12/12 | 0 | 0 | `turn/end` TIMEOUT (zai 120s idle) |
| `d7c4aa80-…29850`, `0590d519-…c810b` | shield | Ward kimi-cli k3 | **0 tools** | 0 | 0 | Claimed reads/recomputes in one assistant message |
| `bae9fb46`, `ac19d305`, `1b3a89d2` | shield | Isolated corpus authors (**live**) | in flight | 0 | 0 | Stock or barely-noted cards |
| `session-05bf2e5b-…ff84e2` | fearless | “what’s been done” | 24/24, zero `jspace_*` after `/j-space on` | 0 | 0 | Stock card for four completed turns |

## Findings that confirm the 08-18 reading

**Ship is not close.** `jspace_ship` is a register check (`Ship check passed.`) and leaves the card live. Only `/j-space off` wrote `jspace/closed`. Children that finished shipped or claimed done and left the card open. This is the same close-task split as session-963a4ee8, except ship now happens.

**Stale Next.** After checkpoint or ship, Next often still named the first action (develop Aegis “Write the plan and report it to the parent.”; shield G1 last card still “Collect Rehearsal B…” after checks 8–10). Direct evidence for F1-4 in the Claude review.

**Empty Core on children.** Capacity (≤2 live items) was used on the develop parent (two Core lines on card 19) and on shield G1 (ONE-SHOT rule + protected hashes). Most children left Core `[]`.

**Protocol friction, then the repeat-refusal.** `jspace_checkpoint` was the noisiest tool (~31% error): `by` missing a verifier-and-coverage claim (develop parent seq 23436; shield parent seq 10562, 10723, 10837, 32554), and `evidence` that was not a call id (`"bash-1"`, `"bash-2"`, `"read packages/bench/..."`). `jspace_note` refused a Core swap without `departing` (develop seq 27817). After a failed `edit`, the identical retry hit the control-loop guard: `jspace refuses repeating a tool call with the same arguments within a turn while a card is open` (develop seq 54275 / 57650; Stride seq 24816; shield seq 23416, 31507). The guard is doing its job; the model often fights it instead of writing a diagnosis.

**G1 was a maintained card.** Shield parent `session-5c37557b`: `jspace_open` (seq 2329) → notes moving Next → 10 accumulating checkpoints → `jspace_ship` (seq 39381) → `update_goal complete`. That falsifies “ship never happens” from 08-18 for glm-5.3 / DeepSeek when the agent actually drives the loop. Open stayed empty the whole time; Checked carried the receipt.

## Findings the 08-18 notes do not already name

**Reopen inherits the previous Goal’s Core and Checked.** After G1 shipped, the user asked for a new goal. `create_goal` `goal-108ceffa` (seq 51465) then `jspace_open` (seq 51468) returned `Updated J-Space.` Card 19 had the new D1 Goal text, G1 Core (`ONE-SHOT rule…`, `Protected hashes…`), and all 10 G1 checks. The user then `/j-space off` (seq 51476–51478). Later `jspace_checkpoint` / `jspace_note` (seq 55479–55481) returned `jspace card is not open`; the agent kept implementing D1 and spawned authoring children. `jspace_open` on an open card is the control-loop update path; it is the wrong primitive for a new Goal epoch. F1-3 (bind checkpoints to goal identity) would have refused a ship on inherited checks; it would not have reset Core.

**`/j-space off` does not unmount the tools.** Settings `enabled` stays true, so `jspace_*` remain in the catalog and the closed-card driver still invites `jspace_open`. The shield parent called checkpoint/note instead of open. That is model error on a closed card, not a missing remount.

**Stock fork / always-open cards that nobody owns.** Copy-on-fork and assemble auto-open seed `Goal: J-Space is on` / `Next: State the first action`. Sessions that never replaced those lines: develop J-Space reviewer `9b31e1ca`, both Ward sessions, fearless `05bf2e5b` (user ran `/j-space on`, then bash/read only), and live authors `ac19d305` / `bae9fb46`. F1-8 (derive the initial Goal from the first user message) is the matching uplift item; it is still unbuilt, and fork copies make it worse because children inherit the stock lines rather than a blank card.

**kimi-cli Ward completes a turn with zero tools.** `d7c4aa80` is 23 events, 0 `tool/call`, 1 step, `turn/end {kind: completed}`. Final text starts `All verification passes complete.` `0590d519` claims `I read docs/blind-g1-results.md` the same way. The parent inbox accepted both. Aegis `dc7ad5ff` on the same handover used 23 tools and recomputed McNemar. This is a provider/subagent skip, not a J-Space register bug; it makes the card a lie (stock Goal, no checkpoint, claimed done).

**grok-cli tools never appear as `tool/call`.** Develop `session-75857f85` completed two turns, narrated greps and an architect ping inside assistant text, and logged zero Shres `tool/call` events. The model-visible ⟺ logged rule does not hold for that CLI-bridge path. Out of J-Space scope; it poisons any log-derived claim about tool use on grok-cli sessions.

**Provider storms ended turns.** Shield parent: 32 `llm/retry` events, 30× OpenRouter `429 stealth/ox-alpha` (`limit_source: upstream_provider_shared_pool`), two `EMPTY_RESPONSE` (`model "ox-alpha" returned a completed response with no content`). Turn 5 died `RATE_LIMIT` (seq 36309); the user continued on `deepseek-v4-pro:cloud`. Turn 22 was a user abort. zai `glm-5.3`: `pi-ai stream idle timeout after 120000ms` with `maxRetries: 1`. Architect `93ee95bb` exhausted that and `turn/end` TIMEOUT (seq 2633) with an empty last assistant; the parent retried the seat as `ef0447b1`, which shipped. These are not tool-pipeline leaks.

**Develop parent todos lagged the card.** Last `todo/write` seq 55608 still has Stride `in_progress` after Stride finished, the card checkpointed that work, and `jspace_ship` passed. The control loop hides the todo strip while a native card is open; it does not stop `todo_write`. Stride’s own todos were 9/9 completed. First bash in `bd8e77f8` printed `/Users/parthmondal/git/shres-code-develop` after the prompt required worktree `/Users/parthmondal/git/shres-code-researcher`; later writes targeted the worktree.

## What to do (owned by existing notes unless named)

1. **Do not add a second roadmap.** Feed [Claude’s uplift note](2026-08-18-jspace-deployment-review-and-uplift-claude.md). [Kimi’s review](2026-08-18-jspace-deployment-review-and-uplift-kimi.md) stays the independent second opinion.
2. **F1-3 + reopen reset.** Ship already requires a checkpoint after `goalOpenedSeq`. Also reset Core and Checked when Goal identity changes (a second `jspace_open` / `create_goal` epoch must not keep the previous Goal’s checks). The D1 card is the fixture.
3. **F1-4 stale Next** — still visible on shipped children. Surface age or refuse ship while Next still describes a completed first action.
4. **F1-8 stock Goal** — still the child-session default. Derive Goal/Next from the first user message (or refuse copy-on-fork of a stock card).
5. **Completion nudge** (already in the 08-18 dogfood) — still needed: several children claimed done without ship; several shipped without close. `jspace_ship` must not be treated as close in any prompt copy.
6. **Checkpoint `by` / `evidence` copy** — the refusals are correct. The error text already shows a passing `by` example; models still send job names. A cheaper fix than new events: accept nothing, keep the refusal, add one driver line that `evidence` is a `call_*` id from this session.
7. **kimi-cli zero-tool Ward and grok-cli off-log tools** — file under the CLI-bridge / subagent owners, not under `packages/jspace/`. Until those logs carry `tool/call`, do not use those providers as J-Space dogfood.
8. **W0 remains the default-on gate.** This corpus is mixed-task live use. It cannot replace the paired ON/OFF instrument.

The develop parent is also the live thread behind the [researcher-harness proposal](../architecture/2026-08-24-researcher-harness-long-horizon-autonomous-research.md). That note owns the long-horizon product; this note owns only what the J-Space card did in those sessions.

## Alternatives considered

**Append this corpus to the 08-18 Claude review instead of a new file.** Rejected: that note owns the comparison to the paper and upstream plus the F1–F4 roadmap. Mixing a second machine-local corpus would bury both. A pointer from its dogfood section is enough.

**Put the record in `implemented/`.** Rejected: nothing shipped. These are observations that constrain unbuilt work.

**Export the JSONL into the repo.** Rejected: the logs contain user prompts, tool arguments, and workspace paths. Agent Notes quote seqs and error strings; they do not vendor the sessions.

**Treat this as W0 and skip the bench.** Rejected: one machine, no OFF arm, no pairing key, live sessions, mixed models. [W0](../../implemented/testing/2026-08-18-jspace-w0-benchmark-suite.md) is the instrument that can change the Settings default.

**Unmount `jspace_*` on `/j-space off`.** Rejected: `/j-space off` is session-local card close ([command-jspace](../../../../packages/jspace/command-jspace/README.md)); Settings `enabled` is the remount switch. Unmounting on close would hide `jspace_open` and prevent a later card in the same session. The closed-card driver is the intended invitation; the D1 failure was calling checkpoint/note instead of open.

**Reset the card on every `jspace_open`.** Rejected: the control loop made open-on-open an in-place Goal/Next update so auto-open would not trap the model. A full reset would undo that. Reset Core/Checked only when Goal identity changes (item 2).

## Acceptance criteria

- This file is the home for the 2026-08-23/24 corpus; the 08-18 Claude dogfood section links here.
- Reopen-inheritance (D1 card 19 keeping G1 Core + 10 checks) is named as work on the uplift note or as a child of F1-3, with a regression that a second Goal epoch does not keep the previous Checked list.
- Stock child cards, stale Next, and ship-without-close stay owned by F1-8, F1-4, and the 08-18 completion-nudge item; this note does not duplicate them as a new F-list.
- kimi-cli zero-tool completion and grok-cli missing `tool/call` are named as out-of-jspace coverage gaps, not as J-Space register bugs.
- W0 is still unrun; this corpus is not cited as a default-on measurement.

## Risks

- **Machine-local evidence ages.** `$SHRES_HOME/sessions` is not in git and will rotate. The seq quotes in this file are the durable copy; they cannot be replayed in CI.
- **Live sessions at snapshot.** The shield parent and three authoring children were still writing. Later events do not invalidate the G1 ship, the D1 reopen, the Ward zero-tool turns, or the pairing counts from completed children.
- **Small n, mixed models.** glm-5.3 maintained G1; kimi-cli k3 skipped tools; grok-cli left the log. Do not average them into a J-Space quality score.
- **More register rules, more gaming.** Checkpoint `by` padding already appeared after refusals. Goal-bound reopen-reset and a completion nudge can be satisfied ritually. W0 truthfulness sampling is the counter, as the Claude review already says.
