# Speech I/O

The speech I/O seam — a [capability seam](../glossary.md#capability-seam) that spans **two operations** (synthesize and transcribe) on one `ctx.speech` service, split across packages: Service Definition ([shres-speech](../../packages/speech/speech), `ctx.speech` + the provider registries), Service Providers ([shres-speech-kokoro](../../packages/speech/speech-kokoro), [shres-speech-whisper](../../packages/speech/speech-whisper)), and Consumer ([shres-client-ui-speech](../../packages/client/ui-speech), Web mic and speaker). Speech is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). The model still sees and writes text; transcripts enter `session.prompt` as ordinary user messages.

Source: [`packages/speech/speech/src/types.ts`](../../packages/speech/speech/src/types.ts), [`packages/speech/speech/src/settings.ts`](../../packages/speech/speech/src/settings.ts)

## User settings

```ts type-equiv
/** Durable speech section shared by the Host schema and the browser scope. */
interface SpeechUserSettings {
  /** When true, the Web client synthesizes each live-closing assistant turn. */
  readAloud: boolean
  /** Provider voice id passed to synthesize. */
  voiceId: string
  /** When true, a finished transcription submits the draft immediately. */
  autoSubmitVoice: boolean
  /** Language tag forwarded to TTS and STT. */
  language: string
  /**
   * When true, the composer is replaced by the talk surface. Transcripts
   * require explicit confirm before they reach the coding agent.
   */
  talkMode: boolean
}
```

## Providers and in-process calls

```ts type-equiv
/** One catalogued TTS voice. */
interface SpeechVoice {
  readonly id: string
  readonly name: string
  readonly language?: string
}
```

```ts type-equiv
/** In-process synthesize request. */
interface SpeechSynthesizeRequest {
  readonly text: string
  readonly voiceId?: string
  readonly language?: string
}
```

```ts type-equiv
/** In-process synthesize result. */
interface SpeechSynthesizeResult {
  readonly audio: Uint8Array
  readonly mediaType: SpeechOutputMediaType
  readonly voiceId: string
}
```

```ts type-equiv
/** In-process transcribe request. */
interface SpeechTranscribeRequest {
  readonly audio: Uint8Array
  readonly mediaType: SpeechInputMediaType
  readonly language?: string
}
```

```ts type-equiv
/** In-process transcribe result. */
interface SpeechTranscribeResult {
  readonly text: string
}
```

```ts type-equiv
/** A TTS-capable backend. Registered with `ctx.speech.registerTtsProvider`. */
interface SpeechTtsProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Voices this backend will accept as `voiceId`. */
  listVoices(): Promise<readonly SpeechVoice[]>
  /** Turn speakable text into audio; honor `signal` for cancellation. */
  synthesize(
    request: SpeechSynthesizeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesizeResult>
}
```

```ts type-equiv
/** An STT-capable backend. Registered with `ctx.speech.registerSttProvider`. */
interface SpeechSttProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Turn recorded audio into text; honor `signal` for cancellation. */
  transcribe(
    request: SpeechTranscribeRequest,
    signal?: AbortSignal,
  ): Promise<SpeechTranscribeResult>
}
```

```ts type-equiv
/** Why one capability kind cannot run, or that it can. */
type SpeechCapabilityStatus =
  | { readonly kind: 'ready'; readonly providerId: string }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }
```

```ts type-equiv
/** Snapshot a client uses to enable or disable mic and speaker chrome. */
interface SpeechStatus {
  readonly tts: SpeechCapabilityStatus
  readonly stt: SpeechCapabilityStatus
  readonly voices: readonly SpeechVoice[]
}
```

## Remote wire payloads

```ts type-equiv
/** Wire request for Remote `synthesize`. */
interface SpeechSynthesizeWireRequest {
  readonly text: string
  readonly voiceId?: string
  readonly language?: string
}
```

```ts type-equiv
/** Successful audio payload for Remote `synthesize`. */
interface SpeechSynthesizeAudioValue {
  readonly kind: 'audio'
  readonly audioBase64: string
  readonly mediaType: SpeechOutputMediaType
  readonly voiceId: string
}
```

```ts type-equiv
/** Successful no-audio payload when the speakable script is empty. */
interface SpeechSynthesizeEmptyValue {
  readonly kind: 'empty'
}
```

```ts type-equiv
/** Wire failure for a Remote method. */
interface SpeechWireFailure {
  readonly code: string
  readonly message: string
}
```

```ts type-equiv
/** Remote `synthesize` result. */
type SpeechSynthesizeWireResult =
  | { readonly ok: true; readonly value: SpeechSynthesizeAudioValue | SpeechSynthesizeEmptyValue }
  | { readonly ok: false; readonly error: SpeechWireFailure }
```

```ts type-equiv
/** Wire request for Remote `transcribe`. */
interface SpeechTranscribeWireRequest {
  readonly audioBase64: string
  readonly mediaType: string
  readonly language?: string
}
```

```ts type-equiv
/** Remote `transcribe` result. */
type SpeechTranscribeWireResult =
  | { readonly ok: true; readonly value: SpeechTranscribeResult }
  | { readonly ok: false; readonly error: SpeechWireFailure }
```

The local Kokoro provider emits WAV. The Web client decodes MediaRecorder output to PCM16 WAV before `transcribe`. Unary Remotes carry canonical-base64 audio.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechruntime"></a>

### `ctx.speech` — `SpeechRuntime`

The speech I/O service. Registered as `ctx.speech` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A singular configured id that is registered and `available()` → that provider.
- A singular configured id not registered → `SPEECH_PROVIDER_CONFIGURED_MISSING`.
- A singular configured id registered but unavailable → `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`.
- An ordered fallback list → first listed id that is registered and usable.
- A fallback list whose members are all missing or unusable → `SPEECH_PROVIDER_UNAVAILABLE`.
- No pin, exactly one registered usable provider → that provider.
- No pin, multiple usable providers → `SPEECH_PROVIDER_AMBIGUOUS`.
- No pin, no usable provider → `SPEECH_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Current resolved user-settings section (read-aloud, voice, language).
 * @returns the live section, including schema defaults.
 */
settings(): SpeechUserSettings

/**
 * Register a TTS provider. Throws {@link SpeechError}
 * `SPEECH_DUPLICATE_PROVIDER` if its id is already registered for TTS.
 * Returns a disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerTtsProvider(provider: SpeechTtsProvider): () => void

/**
 * Register an STT provider. Throws {@link SpeechError}
 * `SPEECH_DUPLICATE_PROVIDER` if its id is already registered for STT.
 * Returns a disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerSttProvider(provider: SpeechSttProvider): () => void

/**
 * Convert markdown to a speakable script and synthesize it through the
 * selected TTS provider. An empty script returns zero-length audio with
 * the requested (or default) voice id; callers that must skip playback
 * inspect `audio.byteLength`.
 * @param request - markdown text plus optional voice and language.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns synthesized audio (WAV from the local Kokoro provider).
 */
async synthesize( request: SpeechSynthesizeRequest, signal?: AbortSignal, ): Promise<SpeechSynthesizeResult>

/**
 * Transcribe recorded audio through the selected STT provider.
 * @param request - bytes and a closed media type.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the transcript.
 */
async transcribe( request: SpeechTranscribeRequest, signal?: AbortSignal, ): Promise<SpeechTranscribeResult>

/**
 * Probe TTS and STT selection plus the TTS voice catalog, without running a
 * synthesis or transcription.
 * @returns capability status and voices (empty when TTS is unavailable).
 */
@Remote('status') async status(): Promise<SpeechStatus>

/**
 * Remote synthesize: markdown in, canonical-base64 MPEG out (or `empty`).
 * @param request - wire payload.
 * @returns a tagged business result; transport failures stay on the carrier.
 */
@Remote('synthesize') async synthesizeRemote(request: SpeechSynthesizeWireRequest): Promise<SpeechSynthesizeWireResult>

/**
 * Remote transcribe: canonical-base64 audio in, transcript out.
 * @param request - wire payload.
 * @returns a tagged business result; transport failures stay on the carrier.
 */
@Remote('transcribe') async transcribeRemote(request: SpeechTranscribeWireRequest): Promise<SpeechTranscribeWireResult>
```

Source: [`packages/speech/speech/src/index.ts:146`](../../packages/speech/speech/src/index.ts)
<!-- END GENERATED cordis-surface -->
