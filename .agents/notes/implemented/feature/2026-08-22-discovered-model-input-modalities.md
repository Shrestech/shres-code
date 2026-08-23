# Agent Note: Discovered input modalities surface in the models UI, and undeclared still means undeclared

Status: implemented

## Problem

A hand-declared pi-ai route serving a vision model reported `inputModalities: ['text']` until someone wrote `input: [text, image]` into `settings.yaml` by hand — the remedy [the route-default note](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md) shipped. That remedy assumes a file a web-only user has no reason to open: the models page could fetch a provider's model list and adopt entries from it, yet even when the endpoint's own listing declares modalities (OpenRouter's `architecture.input_modalities`), discovery dropped the fact and the settings form had no key to write it into. The visible symptom: `read_image` refusing `model "kimi-k3:cloud" does not declare image input` on a model whose registry entry declares vision, and every image affordance on the web client gated the same way.

## Decision

**Discovery carries declared modalities; absence stays absence.** `LlmDiscoveredModel.input` is optional and means "the endpoint or the installed catalog stated this" — never `[]`, never a guess. The pi-ai adapter fills it from both of its discovery paths: a catalog route maps the catalog entry's `input`, and a draft-provider listing parses OpenRouter's `architecture.input_modalities`, keeping only the modalities pi-ai knows and answering absent for a missing, malformed, or wholly unknown list. The discovery contract is otherwise unchanged: no endpoint is probed beyond the listing it already serves, and a row that cannot be read is still skipped, never fatal.

**The wire field is `inputModalities`, named exactly like the llm service field.** `ModelCatalogModel` gains it optional, `DiscoveredModelView` gains `input`; both project absence as an absent key, so the client reads the same tri-state the host's own admission reads — declared-with-image, declared-without, unknown. Renaming at the boundary would invent a second vocabulary for one fact.

**The models page shows, adopts, and writes the declaration.** Fetch candidates carry a `vision` chip (or their raw declared list) beside the id; adopting a candidate persists its `input` with the row. Each row's advanced fold gains an Input select: `auto` is the absent key (inherit the catalog entry or the route `defaultInput`), the two spellable declarations write `['text']` and `['text', 'image']`, and a stored list the control cannot spell — a future modality, a hand-written combination — shows as a custom choice that applying does not rewrite. This retires the "no configuration surface edits `input`" stance of the route-default note: the conservative default stays, and the remedy is a form field rather than a settings-file edit.

**The picker and the composer read the same fact.** Model rows tag any declared modality beyond `text` (`vision`, or the raw value for one the UI predates); the popup's detail suffix names the vision capability. For the composer, ui-model-selection pushes a per-session tri-state through the new `ctx.conversation.imageInput` registry — the same one-way push as the composer blocks, since the dependency still runs ui-model-selection → ui-conversation, never back. The bar's `addImages` refuses on a definite `false` with the existing `image.modelUnsupported` copy, before any file is read; `undefined` stays admissible, mirroring the leniency of host admission, which remains the enforcement.

## Alternatives considered

- **Probe the endpoint at request time (`resolveModelInfo`)** — rejected: the request path stays a pure resolution over recorded declarations; interrogation lives in the discovery surface, which already exists for exactly this purpose. Most OpenAI-compatible listings report no modalities at all, so a request-time probe would mostly buy latency for the same absence.
- **A host projection for the composer hint** (the `imageLimits` pattern) — rejected: model selection is process-local proxy state with no session event, so a projection has no change frames to push on switch and would serve a stale refusal; the client directory is already the fact source for the current model and updates on select.
- **A full composer block for image-less models** — rejected: text input still works on such a model, and a block makes the whole composer inert. The refusal belongs to image intake alone.
- **Reactive disable of the attach affordances** — rejected as surface out of proportion: every intake path (paste, drop, command) funnels through the one `addImages` refusal, which announces the exact obstacle; gating the drop overlay's invitation copy reactively would need a new slot-inject channel for a hint the refusal already delivers.
- **Per-model Ollama probing** (`/api/show`) — rejected: ollama.com listings carry no modality data, so the probe buys nothing for the routes that motivated the fallback; the manual override and the route `defaultInput` cover them.
- **An optimistic `[text, image]` default** — remains rejected under the route-default note: detection narrows the gap to endpoints that declare nothing, it does not change what being wrong costs.

## Consequences

A vision model behind an OpenRouter-declaring gateway is claimed as one by fetching and adopting it — no settings file, and the picker, settings page, and composer all read the same declaration. The kimi-k3:cloud case that motivated this change is fixed by declaring `input: [text, image]` once on the entry, now possible from the models page.

Detection shifts where a wrong claim can come from, not what one costs: an adopted declaration is the endpoint's claim about itself, still not a verification of it, and a model claiming images its endpoint refuses produces the same poisoned-session failure the route-default note records. What detection removes is the common case of *under*-claiming against an endpoint that could have answered.

Routes whose listings say nothing (ollama.com today) gain no badge and no adopted key, and their `defaultInput` floor is intact — which makes the floor's `['text']` itself a stated list: the composer refuses image intake on those routes where the refusal previously arrived at send, with the same copy. The admissible-unknown reading is reserved for what states nothing: delegated CLI routes report no modalities and keep the host's leniency, as do a directory that has not loaded and a current model absent from the advertised groups.

## Testing

`llm-pi-ai`'s discovery spec covers both paths (catalog-route mapping; OpenRouter listing parsing, including malformed and unknown-only lists) and the service-level detach preserving the field. The apiproxy specs pin the wire projection: catalog present/absent plus a delegated route's absent keys in the models spec, discovery present/absent in the config spec, and the never-empty refusal in the schema spec. The settings-page spec covers the candidate chip, adoption persisting `input`, the select writing and clearing the key, the custom choice surviving an unrelated edit, and a stored empty list reading as inherit. The picker spec tags declared modalities only, and the popup's ` · vision` detail suffix is asserted. The composer gate is pinned at the apply-inject level (definite `false` refuses with the model copy before format checks and without reading a file; unknown and `true` admit) and the push at the ui-model-selection plugin level (load, select, unrouted current, scope teardown), keeping the same tri-state assertions on both ends of the push. The connection fixture's catalog declares its GPT-5 vision-capable and its fixture discovery projects the declaration; no recorded web snapshot renders the model popup, so the golden lane is untouched.

## Related

- [A pi-ai model declares its own input modalities, and undeclared means text](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md) — the resolution chain this change feeds and the conservative floor it keeps.
- [Minimal read_image tool](../feature/2026-08-10-minimal-read-image-tool.md) — the strict gate whose refusal named the motivating symptom.
- [Web multimodal image input and durable attachments](../feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md) — the intake and admission paths the composer hint fronts.
