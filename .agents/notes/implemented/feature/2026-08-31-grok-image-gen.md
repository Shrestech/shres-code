# Agent Note: Default-off image_gen tool over the Grok subscription

Status: implemented

## Problem

The Grok subscription credential was extracted into the shared `ctx.grokCredential` service so that route-adjacent capabilities could use the same session JWT and single-flight refresh instead of each owning its own credential machinery — with image generation named as the future consumer on day one. That capability did not exist yet, so the subscription's Imagine image generation remained unreachable from the harness. It had to reuse the exact same session token (no `XAI_API_KEY`, no CLI spawn) and mirror the wire the Grok Build CLI actually sends, not a guessed shape.

## Decision

A new package `packages/llm/tool-image-gen` (`@shres-code/shres-code-tool-image-gen`) ships a default-off, model-facing `image_gen` tool. It is placed beside the credential engine (`llm/grok-credential`) and its first consumer (`llm/llm-grok-session`), following the repo's `tool-*` naming for model-facing tool packages. When `enabled` is absent or false the tool registers nothing and the model never sees it; a deployment opts in via cordis.yml.

The credential service is a hard inject (`['tools', 'systemPrompt', 'grokCredential']`): without it the plugin fiber is INACTIVE and `apply` never runs, so there is deliberately no local-manager fallback that could race the shared service's single-flight refresh with a possibly single-use refresh token. Each call resolves `ctx.grokCredential.managerFor({ authPath, refreshLeewayMs }).accessToken()`, posts to the Grok Build Imagine API, and saves the generated image to the attachments service (`ctx.attachments.saveImage`) and to a deterministic workspace file.

### Wire contract

The wire mirrors the open-source CLI's `image_gen` implementation (xai-grok-tools):

- **Endpoint:** `POST {baseURL}/images/generations`; base defaults to `https://api.x.ai/v1`.
- **Authorization:** `Authorization: Bearer <session access token>` — the same subscription JWT grok-session serves.
- **Request body:** `{ model, prompt, n: 1, aspect_ratio, resolution: "1k", response_format: "b64_json" }`; model defaults to `grok-imagine-image-quality`.
- **Response:** `{ "data": [{ "b64_json": "<base64>" }] }`; the first element's bytes are decoded and saved.

Error handling adds named `LlmError` codes over the CLI's behavior: HTTP 401 → `IMAGE_GEN_AUTH_FAILED` naming `grok login`; other non-2xx → `IMAGE_GEN_HTTP` with the status; empty, strictly-invalid-base64, or unparseable payloads → `IMAGE_GEN_BAD_RESPONSE`; network failure → `IMAGE_GEN_NETWORK`. Tokens and full response payloads never reach diagnostics or the tool result.

### Config and persistence

Every deployment-varying choice is a validated Config field with defaults mirroring the CLI: `model`, `baseURL`, `authPath`, `refreshLeewayMs`, `outputDirectory`, and `timeoutMs`. A blank model, base URL, auth path, or output directory fails loud at load. The output file is published crash-safely (temp + fsync + atomic rename) as `image-N.jpg` by the current directory contents, only after the attachment (when mounted) commits. The attachment store is read via `ctx.get('attachments')` and is optional: a composition without attachment storage still writes the workspace file. Render intent is the generic card; the tool result reports the saved file path and attachment id.

## Alternatives considered

### Why not call the endpoint with a bespoke credential reader?

That was the pre-extraction design and is exactly what `ctx.grokCredential` exists to stop: a second copy of auth.json parsing and refresh would refresh the same document concurrently with chat, racing a single-use refresh token. Sharing the single-flight service is the point.

### Why not use `XAI_API_KEY` / spawn the CLI?

Both were forbidden by the effort. The key is not read anywhere in the harness, and a CLI spawn would reintroduce the process/credential surface the shared service removed.

### Why place it under `packages/llm` rather than a media/group?

The package exists solely to consume the Grok credential and has no other dependency; its siblings are the credential engine and grok-session. Co-location next to them is where a future maintainer looks for route-adjacent Grok capabilities.

### Why make attachments optional?

The tool's core deliverable is the deterministic workspace file; attachment storage is a durable-session nicety that requires the attachment service mounted. Making it a hard inject would refuse to boot a headless composition that still wants generation. Attachment is committed before the file so an attachment failure leaves no on-disk image a failed call would contradict.

### Why no static sessionId config field?

The CLI sends a per-session owner id on Imagine requests. A deployment-wide static string would mis-attribute every session's generations server-side, so the tool does not accept one; per-session attribution is deferred to deriving the header from the active session if a consumer needs it.

## Consequences

Adding the package extends the module graph and config catalog (regenerated), and the tsconfig host graph. The README Model Experience gate, config catalog, module graph, doc graphs, and cordis catalog all pass with the regenerated docs. The README model-experience gate still reports a single pre-existing failure in `packages/host/remote-control/README.md` that predates and is outside this change (that package is out of the permitted worktree scope).

The model gains a way to request images with the user's actual subscription, at the cost of a new model-visible tool surface and out-of-band image files that are the deployment's to retain or prune. Deterministic naming is per-directory, not a global counter, so two output directories can reuse `image-1.jpg`.

## Testing

Unit specs cover the wire client (request body, the bearer header, strict base64, and every documented failure mode — 401, other non-2xx, network rejection, non-JSON body, empty data — via an injected fetch), deterministic crash-safe persistence (numbered files, pre-existing entries, attachment-before-file, and no file on attachment failure), config resolution (default-off, explicit fields, loud validation), argument/presentation helpers, and the tool end-to-end (absent when disabled, enabled happy path resolving the shared credential and writing the file, and an auth failure surfaced without exposing the token).
