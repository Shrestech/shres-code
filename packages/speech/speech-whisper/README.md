# @shres-code/shres-code-speech-whisper

A local Whisper STT provider for the harness [speech capability seam](../speech/README.md) (`ctx.speech`). English uses [tiny.en](https://huggingface.co/Xenova/whisper-tiny.en); any other `speech.language` tag uses [multilingual tiny](https://huggingface.co/Xenova/whisper-tiny). It runs `@huggingface/transformers` on the Node CPU. There is no speech API and no API key.

Weights download once into the harness model cache (`$SHRES_HOME/models/speech/whisper/<model id>` unless `cacheDir` is set). With `allowDownload: false` the load passes `local_files_only` to the transformers pipeline, so a cold cache fails at load instead of downloading. Later transcribes are offline. Tests inject a fake engine so CI never downloads the ONNX file.

The provider accepts **PCM16 WAV** only. The Web client decodes `MediaRecorder` output with Web Audio and sends WAV on the Remote. `@huggingface/transformers` 3.8's Whisper pipeline takes a `Float32Array` at 16 kHz; a `{ raw, sampling_rate }` object is rejected. The provider resamples to 16 kHz, raises a quiet clip, pads to one second, and drops the model's `[BLANK_AUDIO]` no-speech token so it never reaches the composer.

## Config

| Key | Default | Meaning |
|---|---|---|
| `modelId` | `Xenova/whisper-tiny.en` for English, else `Xenova/whisper-tiny` | Hugging Face model id. A pin wins over language routing. |
| `cacheDir` | `$SHRES_HOME/models/speech/whisper/<model id>` | Weight cache, one directory per checkpoint. |
| `allowDownload` | `true` | When false, refuse to download: `available()` requires a warm cache and the pipeline reads local files only. |
| `enabled` | `true` | When false, the backend is omitted from the pool. |

## Model Experience

None, as this provider only converts audio to text; `session.prompt` and adapters own any model-visible transcript.

#### KV Cache effect

No direct invalidation; a transcript enters the next user message through the existing prompt path.

## Known Limitations and Deferred Work

- **WAV-only input** — WebM/Opus must be decoded in the browser. A host decoder is deferred.
- **First-run download** — about 75 MB from Hugging Face; not an API bill.
