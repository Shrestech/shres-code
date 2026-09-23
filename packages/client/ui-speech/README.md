# @shres-code/shres-code-client-ui-speech

Web controls over `ctx.speech`: a composer microphone (opens a hands-free Talk dialog, or dictates once), an assistant read-aloud button, and Voice & audio preference rows (`settings.audio.item`) for Kokoro voice, send-after-dictation, and spoken language.

The host converts audio locally (Kokoro TTS, Whisper tiny.en for English, multilingual Whisper tiny otherwise). This package records, decodes MediaRecorder output to PCM16 WAV, and plays returned WAV.

Dictate writes the transcript through `inputActions.setDraft` (and submits when send-after-dictation is on). Talk mode does not: Enable Talk starts listening for an instruction (silence or a max window ends the capture), then it speaks a confirm prompt in English, listens for a spoken yes/no in the selected language, and only then calls `setDraft` plus `submit`. A spoken no, or two unrecognized answers, discards and listens again. Confirm has no click or key path. Type instead leaves Talk.

`status()` drives disablement: the speaker and Talk listen pad stay unavailable until the selected provider is usable, and the voice picker lists whatever catalog that probe returns. The composer mic stays clickable so the Talk offer can open when STT is down; Dictate this once is then disabled. The probe runs at startup and again on every `connection/reset`, so a transport failure recovers when the connection does.

## Model Experience

None, as the browser records and plays audio; `session.prompt` owns any model-visible transcript.

#### KV Cache effect

No direct invalidation; a transcript enters the next user message through the existing prompt path.

## Known Limitations and Deferred Work

- **Auto-play of a live-closing turn** is not a shipped setting; the speaker button reads the current message.
- **Confirm TTS is English-only** because Kokoro's JS pack is English; yes/no listen still runs in the selected language.
- **Safari MediaRecorder** may need a different capture MIME; the host still requires WAV after Web Audio decode.
