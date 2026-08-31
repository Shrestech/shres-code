# @shres-code/shres-code-tool-image-gen

A default-off, model-facing `image_gen` tool that generates an image through the Grok Build Imagine API (`api.x.ai/v1/images/generations`) and saves the result to the attachments service and a workspace file. It uses the same Grok subscription session credential as `grok-session` — resolved through the shared `ctx.grokCredential` service (single-flight refresh) — so no `XAI_API_KEY` and no CLI spawn are involved.

## Enablement

The tool is **disabled by default**. An absent or `false` `enabled` value registers no tool, so the model never sees `image_gen` until a deployment opts in:

```yaml
- name: '@shres-code/shres-code-grok-credential'
- name: '@shres-code/shres-code-tool-image-gen'
  config:
    enabled: true
    outputDirectory: ./images
```

The tool requires the credential service mounted (its shared engine), so a composition that opts in must also mount `@shres-code/shres-code-grok-credential`; without it the plugin fiber is INACTIVE and the tool is never registered.

Like the CLI it mirrors, every deployment-varying choice is a validated Config field: `model`, `baseURL`, `authPath`, `refreshLeewayMs`, `outputDirectory`, and `timeoutMs`. A blank model, base URL, auth path, or output directory fails loud at load rather than producing a surprising request.

## Wire contract

The tool calls exactly the endpoint the open-source Grok CLI's `image_gen` uses:

- **Endpoint:** `POST {baseURL}/images/generations` (default `https://api.x.ai/v1`)
- **Authorization:** `Authorization: Bearer <session access token>` — the same subscription JWT `grok-session` serves
- **Request body:** `{ model, prompt, n: 1, aspect_ratio, resolution: "1k", response_format: "b64_json" }`
- **Response:** `{ "data": [{ "b64_json": "<base64>" }] }`; the first element's bytes are saved

Error handling adds named harness codes over the CLI's behavior: HTTP 401 surfaces as an auth failure naming `grok login`, other non-2xx statuses surface with the status, and an empty, strictly-invalid-base64, or unparseable body surfaces as a bad-response failure. Tokens and full response payloads never reach diagnostics or the tool result.

## Model Experience

### Image generation tool

#### What the model sees

The `image_gen` tool definition and its description, the two parameters (`prompt` required, `aspect_ratio` optional), and one `tool:image_gen` system-prompt section. The tool result names the saved file path (and attachment id when a store is mounted); the image bytes and the session token never reach the model.

#### Token effect

One model-facing tool call per generation: the submitted `prompt` and the returned path text. The image bytes are persisted out of band and are not tokenized.

#### KV Cache effect

Registering the tool extends the fixed prompt prefix once; generation adds no per-call request-prefix mutation.

## Known Limitations and Deferred Work

- **Unofficial wire** — the Imagine endpoint and body are the Grok Build CLI's implementation details, not a published contract; a CLI update can change them, and this package mirrors the CLI version it was built against.
- **Attachments degrade to file-only** — the tool persists to `ctx.attachments` when that service is mounted and always writes the workspace file, so a composition without attachment storage still delivers the image.
- **Deterministic naming is per-directory** — files are `image-N.jpg` by the current directory contents, not a global counter, so two output directories can reuse names.
- **No per-session header** — the CLI sends a per-session owner id on Imagine requests; this tool does not, so a deployment wanting server-side per-session attribution would add it from the active session rather than a static string.
