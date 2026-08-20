# @shres-code/shres-code-speech-whisper

A local [Whisper tiny.en](https://huggingface.co/Xenova/whisper-tiny.en) STT provider for the harness [speech capability seam](../speech/README.md) (`ctx.speech`). It runs `@huggingface/transformers` on the Node CPU. There is no speech API and no API key.

Weights download once into the harness model cache (`~/.shres/models/speech/whisper` unless `cacheDir` is set). Later transcribes are offline. Tests inject a fake engine so CI never downloads the ONNX file.

The provider accepts **PCM16 WAV** only. The Web client decodes `MediaRecorder` output with Web Audio and sends WAV on the Remote. `@huggingface/transformers` 3.8's Whisper pipeline takes a `Float32Array` at 16 kHz; a `{ raw, sampling_rate }` object is rejected. The provider resamples to 16 kHz, raises a quiet clip, pads to one second, and drops the model's `[BLANK_AUDIO]` no-speech token so it never reaches the composer.

## Config

| Key | Default | Meaning |
|---|---|---|
| `modelId` | `Xenova/whisper-tiny.en` | Hugging Face model id. |
| `cacheDir` | `$SHRES_HOME/models/speech/whisper` | Weight cache. |
| `allowDownload` | `true` | When false, `available()` requires a warm cache. |
| `enabled` | `true` | When false, the backend is omitted from the pool. |

## Model Experience

None, as this provider only converts audio to text; `session.prompt` and adapters own any model-visible transcript.

#### KV Cache effect

No direct invalidation; a transcript enters the next user message through the existing prompt path.

## Known Limitations and Deferred Work

- **English-only** — `whisper-tiny.en` is the shipped model; multilingual Whisper is a later provider swap.
- **WAV-only input** — WebM/Opus must be decoded in the browser. A host decoder is deferred.
- **First-run download** — about 75 MB from Hugging Face; not an API bill.
