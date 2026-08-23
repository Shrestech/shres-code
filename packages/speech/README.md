# speech/ — speech I/O capability family

This family provides provider-neutral text-to-speech and speech-to-text plus the Web client that records a microphone and plays assistant audio.

| Package | Role | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | Defines speech provider registration, selection, speakable-script conversion, and shared errors | `ctx.speech` |
| [`speech-kokoro/`](speech-kokoro/README.md) | Provides local Kokoro-82M TTS (28 English voices) | registers on `ctx.speech` |
| [`speech-whisper/`](speech-whisper/README.md) | Provides local Whisper STT (tiny.en or multilingual tiny) | registers on `ctx.speech` |

The Web consumer lives in [`client/ui-speech`](../client/ui-speech/README.md). Transcripts enter the model as ordinary `session.prompt` text. Playback consumes ordinary assistant text. The family does not add audio content blocks and does not call a paid speech API.

The [speech I/O Agent Note](../../.agents/notes/implemented/feature/2026-08-19-speech-io-web.md) records why TTS and STT share one seam, why audio is not a model content type, and why the shipped engines are local Kokoro and Whisper rather than a billed Voice API or browser `speechSynthesis`.
