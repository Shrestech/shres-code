# @shres-code/shres-code-client-ui-speech

Web controls over `ctx.speech`: a composer microphone, an assistant read-aloud button, and General Settings rows for Kokoro voice and send-after-dictation.

The host converts audio locally (Kokoro TTS, Whisper tiny.en STT). This package records, decodes MediaRecorder output to PCM16 WAV, plays returned WAV, and writes the transcript through `inputActions.setDraft`.

`status()` drives disablement: the mic and speaker stay unavailable until the selected provider is usable, and the voice picker lists whatever catalog that probe returns. The probe runs at startup and again on every `connection/reset`, so a transport failure recovers when the connection does.

## Model Experience

None, as the browser records and plays audio; `session.prompt` owns any model-visible transcript.

#### KV Cache effect

No direct invalidation; a transcript enters the next user message through the existing prompt path.

## Known Limitations and Deferred Work

- **Auto-play of a live-closing turn** is not a shipped setting; the speaker button reads the current message.
- **Safari MediaRecorder** may need a different capture MIME; the host still requires WAV after Web Audio decode.
