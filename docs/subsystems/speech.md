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
<!-- END GENERATED cordis-surface (gen-cordis-catalog.ts) -->
