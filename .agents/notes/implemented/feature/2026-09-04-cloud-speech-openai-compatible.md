# Agent Note: Cloud speech providers, opt-in through the Models page

Status: implemented

See [Speech I/O on the Web client](2026-08-19-speech-io-web.md) for the seam this extends.

## Problem

The speech seam shipped local-only: Kokoro for TTS, Whisper tiny.en for STT. Two gaps followed. Whisper tiny.en is the lowest-quality tier of its own family, so transcription quality has a hard ceiling. And the Models settings page — which already tells the user which LLM models and providers exist, including OpenRouter's catalog — said nothing about which models or providers can serve audio, so a user with an OpenRouter key had no product path to `microsoft/mai-transcribe-2` even though their subscription covers it.

## Decision

**Cloud speech is an opt-in user-layer pin, never a composition default.** The new `speech-openai-compatible` package registers `openai-compatible-stt` / `openai-compatible-tts` on `ctx.speech`, but the base composition keeps the fallback lists `[whisper-tiny-en]` / `[kokoro-tts]`, so auto-resolution and the ordered fallbacks never reach the cloud provider. It runs only when the speech settings section pins it (`sttProvider` / `ttsProvider`), which is what the Models page's Audio card writes. This is how the original note's "billed Voice API — rejected" survives: the rejection removed cloud as the shipped path and default, and did not forbid a user from pointing their own key at one.

**One endpoint, two wire modes per direction.** OpenRouter serves transcription through `chat/completions` with an `input_audio` content part and speaking through streaming `modalities: ["text", "audio"]` completions — it has no `/audio/*` routes. OpenAI-shaped servers (OpenAI, Groq, LAN Whisper servers) are the opposite: `/audio/transcriptions` and `/audio/speech`. The provider carries both modes behind validated config (`sttMode`, `ttsMode`), defaulting to the OpenRouter shapes because OpenRouter is the default base URL; pointing the card at an OpenAI-style server is a mode select away, not a second package.

**Settings-section profile, not plugin config, carries the endpoint.** The `cloud` object in the speech section (base URL, models, voice, wire modes, key reference) is runtime-editable from the browser; the provider re-reads it on every call. Empty fields inherit composition, so the section only ever stores what a user actually set.

**Audio capability is display metadata, not a chat modality.** `llm.discoverModels` gains `audioInput` / `audioOutput` flags read from OpenRouter's `architecture` block. Audio deliberately does NOT join the chat modality vocabulary (`MODALITIES` stays `text`/`image`): the conversation never constructs audio parts, and claiming it would promise adapter behavior that does not exist.

**Cross-engine voice leakage is contained in the provider.** The section's `voiceId` defaults to Kokoro vocabulary (`af_heart`). Rather than teaching the runtime per-provider voice namespaces, the cloud provider serves exactly its configured `ttsVoice` and falls back to it for any foreign request id; its `listVoices()` is that one voice, so the settings voice picker converges on it once cloud TTS is the resolved provider.

## Alternatives considered

**Making cloud STT/TTS a composition fallback (`sttProviders: [whisper, cloud]`).** Rejected: the local provider is always `available()`, so the cloud tier would be unreachable, and when it was reachable a silent per-call engine choice would spend the user's money without a decision.

**A separate OpenRouter-only provider package.** Rejected: the transport difference is one request shape, and the custom-provider requirement is exactly "any OpenAI-compatible endpoint" — OpenRouter is a configuration of that, not a special case.

**Audio badges via the chat `input` field (`input: ['audio']`).** Rejected above: wrong vocabulary, false adapter promise.

**Client-direct calls from the browser to OpenRouter.** Rejected: the key would live in the browser and every request would carry a second CORS/auth surface; the harness already owns one egress path per capability.

## Consequences

`shres --profile web` behavior is unchanged until a user pins a cloud engine on the Models page. A pin naming the cloud provider without a stored key fails at request time with the endpoint's own refusal surfaced through `SPEECH_PROVIDER_ERROR`; the card shows the key's configured state so the missing key is visible before that. The provider's `available()` reports composition enabled only — key presence is per-operation, so no credential cache can go stale.

Model-visible surface is unchanged: transcripts still enter as ordinary `session.prompt` text and read-aloud still consumes settled assistant text.
