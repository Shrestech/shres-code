# @shres-code/shres-code-speech

The **`SpeechRuntime`** (`ctx.speech`) defines WHAT speech I/O the harness has — synthesize text to audio, transcribe recorded audio — over multiple providers, without binding the Web client or a model contract to one vendor's API.

This package owns the Service Definition role of the speech capability, plus the Host Remote face the Web client calls. TTS and STT share no request schema and no business logic, but they are deliberately one seam: `ctx.speech` is a single speech-access middle layer with one provider-selection policy owner, one abort/error vocabulary, one speakable-script conversion, and one product-facing "how this harness speaks" config surface.

| Package | Role |
|---|---|
| `@shres-code/shres-code-speech` (this) | Service Definition: the service, provider registries, selection policy, speakable-script conversion, request/result vocabulary, the `SpeechError` taxonomy, and the `speech` Remote |
| `@shres-code/shres-code-speech-kokoro` | TTS provider: local Kokoro-82M (`kokoro-js`, CPU) |
| `@shres-code/shres-code-speech-whisper` | STT provider: local Whisper tiny.en (English) or multilingual tiny |
| `@shres-code/shres-code-client-ui-speech` | Consumer: Web mic, speaker, Talk mode, and General Settings rows over the Remote |

Providers register **capabilities**, not tools. This seam does not register a model-facing tool and does not add audio content blocks to the session log. A transcription becomes ordinary composer text; playback consumes ordinary assistant text.

## Service API (`ctx.speech`)

| Member | Semantics |
|---|---|
| `registerTtsProvider(provider)` / `registerSttProvider(provider)` | Register a backend. Throws `SpeechError` `SPEECH_DUPLICATE_PROVIDER` on a duplicate id within that capability kind. Returns a disposer. Disposed with the calling fiber. |
| `synthesize(request, signal?)` | Convert markdown to a speakable script, resolve the TTS provider, and run one synthesis. An empty script returns zero-length audio without calling the provider. Throws `SpeechError` when the capability cannot run. |
| `transcribe(request, signal?)` | Resolve the STT provider and run one transcription. Enforces `maxAudioBytes`. Throws `SpeechError` when the capability cannot run or the payload is empty, oversized, or the wrong media type. |
| `status()` | Probe selection without I/O (aside from `listVoices` when TTS is ready). |
| `settings()` | Current `speech` user-settings section (`readAloud`, `voiceId`, `autoSubmitVoice`, `language`, `talkMode`). |

Remote methods `status`, `synthesize`, and `transcribe` carry JSON: audio is canonical base64, matching the image-upload check. Business failures return `{ ok: false, error: { code, message } }` rather than throwing across the wire.

## Selection

Selection never depends on registration, config, or HMR order. A singular pin (`ttsProvider`/`sttProvider`, or env `$SHRES_SPEECH_TTS_PROVIDER`/`$SHRES_SPEECH_STT_PROVIDER`) is exclusive. An ordered list (`ttsProviders`/`sttProviders`, or `$SHRES_SPEECH_*_PROVIDERS`) is first-usable-wins and is ignored when the singular pin is set. With neither, the seam auto-selects when exactly one usable provider is registered.

| Situation | Execution |
|---|---|
| singular pin registered and `available()` | runs that provider |
| singular pin not registered | `SPEECH_PROVIDER_CONFIGURED_MISSING` |
| singular pin registered but unavailable | `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE` |
| ordered list | first listed id that is registered and usable |
| ordered list with no usable member | `SPEECH_PROVIDER_UNAVAILABLE` |
| no pin, exactly one registered usable provider | runs it |
| no pin, no usable provider | `SPEECH_PROVIDER_UNAVAILABLE` |
| no pin, multiple usable providers | `SPEECH_PROVIDER_AMBIGUOUS` |

A provider's `available()` is a cheap local check (credential presence, parseable config) that **must not make network calls**.

## Config

`maxAudioBytes` and `maxTextChars` are required positive safe integers and fail at load. Provider pins are optional.

The `speech` user-settings namespace (`readAloud` default false, `voiceId` default `af_heart`, `autoSubmitVoice` default false, `language` default `en`, `talkMode` default false) is live: a changed section reaches the next synthesize or transcribe. `talkMode` is consumed by the Web Talk composer (spoken yes/no before `session.prompt`). `readAloud` is reserved for auto-play of a live-closing turn, which is not shipped. Shipped providers are local ONNX (Kokoro TTS, Whisper tiny.en or multilingual tiny STT); they do not call a paid speech API.

## Speakable script

`toSpeechScript` runs on the host before TTS: fenced code becomes `Code block.`, tables become `Table omitted.`, links keep the label, emphasis unwraps. A script longer than `maxTextChars` is cut with ` The rest was omitted.`

## Model Experience

None, as the seam converts audio to text and text to audio; `session.prompt` and adapters own any model-visible text.

#### KV Cache effect

No direct invalidation; a transcript enters the next user message through the existing prompt path.

## Known Limitations and Deferred Work

- **Unary Remotes** — synthesize and transcribe return a whole payload; streaming TTS playback and streaming STT partials are deferred.
- **No audio content blocks** — the LLM vocabulary stays text/image/tool; ACP `promptCapabilities.audio` stays false.
- **No speech-to-speech** — Grok Realtime (`/v1/realtime`) is a different product from talk-to-type plus read-aloud.
- **No observation event** — availability is observed through `status()` or by executing synthesize/transcribe and routing `SpeechError` codes.
