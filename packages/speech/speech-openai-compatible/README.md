# @shres-code/shres-code-speech-openai-compatible

OpenAI-compatible cloud speech provider for the speech capability seam (`ctx.speech`): STT and TTS over one configurable endpoint, OpenRouter by default. See the speech I/O Agent Note for why the provider is registered but never auto-selected.

## Providers

| id | capability | wire modes |
|---|---|---|
| `openai-compatible-stt` | speech-to-text | `transcriptions` — `POST /audio/transcriptions` multipart (OpenRouter and OpenAI-style servers; the default); `chat-audio` — `POST /chat/completions` with an `input_audio` part (audio-input chat models) |
| `openai-compatible-tts` | text-to-speech | `chat-audio` — streaming `modalities: ["text","audio"]` completion, audio deltas collected from the SSE stream (OpenRouter); `speech` — `POST /audio/speech` (OpenAI-style) |

All requests carry the resolved bearer key; when no key resolves, the request goes out unauthenticated, which is how a keyless LAN endpoint is served.

## Selection

The base composition's fallback lists do not include these ids, so a call runs on them only when the speech settings section pins `sttProvider` / `ttsProvider` to `openai-compatible-stt` / `openai-compatible-tts` (the Models page's Audio card writes that pin). A pinned provider that is disabled fails loud with `SPEECH_PROVIDER_UNAVAILABLE`.

## Configuration

Composition config (cordis.yml): `baseURL` (default `https://openrouter.ai/api/v1`), `apiKeyEnv` (default `OPENROUTER_API_KEY` — the key an OpenRouter LLM-route configuration already stores), `sttModel` (default `microsoft/mai-transcribe-2`), `sttMode` (default `transcriptions`), `ttsModel` (default `openai/gpt-4o-audio-preview`), `ttsMode`, `ttsVoice` (default `alloy`), `enabled`.

Every field has a runtime-editable counterpart in the speech settings section's `cloud` object, re-read on each call; a non-empty section field wins, an empty one inherits. The credential reference is resolved through `ctx.credentials` once per operation. A section value that no schema should have stored (a bad wire mode or reference) fails loud with `SPEECH_PROVIDER_CONFIG`.

The TTS catalog is exactly the configured `ttsVoice`: cloud models name their own voices, and a request carrying another engine's voice id (the local default `af_heart`) falls back to the profile voice instead of reaching the endpoint.

## Model Experience

None, as this provider only converts recorded audio to transcript text and text to audio; the speech seam keeps transcripts outside every model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No streaming synthesis into playback** — `chat-audio` TTS accumulates the whole stream before returning; playback starts after the reply completes.
- **Per-voice catalogs are not listed** — the endpoint is not asked which voices a TTS model accepts; the configured voice is the catalog.
- **`/audio/transcriptions` language hints** — the request forwards the section language only in `transcriptions` mode; `chat-audio` transcription relies on the model's own detection.
