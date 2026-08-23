# @shres-code/shres-code-speech-kokoro

A local [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) TTS provider for the harness [speech capability seam](../speech/README.md) (`ctx.speech`). It runs `kokoro-js` on the Node CPU. There is no speech API and no API key.

Weights download once into the harness model cache (`~/.shres/models/speech/kokoro` unless `cacheDir` is set). The loader pins transformers `env.cacheDir` to that path for the load; with `allowDownload: false` it also pins `env.allowRemoteModels` off, so a cold cache fails at load instead of downloading. Later synthesizes are offline. Tests inject a fake engine so CI never downloads the ONNX file.

This is an **implementation** package: it registers `kokoro-tts` into `ctx.speech` and does not register a model-facing tool.

## Config

| Key | Default | Meaning |
|---|---|---|
| `modelId` | `onnx-community/Kokoro-82M-v1.0-ONNX` | Hugging Face model id. |
| `dtype` | `q8` | `fp32`, `fp16`, `q8`, `q4`, or `q4f16`. |
| `device` | `cpu` | ONNX device (`cpu` on Node). |
| `cacheDir` | `$SHRES_HOME/models/speech/kokoro` | Weight cache. |
| `allowDownload` | `true` | When false, refuse to download: `available()` requires a warm cache and the load stays offline. |
| `enabled` | `true` | When false, the backend is omitted from the pool. |

`listVoices()` returns the 28 English voices in the JS/ONNX pack (US and UK, male and female). The seam default voice is `af_heart`.

## Model Experience

None, as this provider only converts text to audio; `session.prompt` and adapters own any model-visible transcript.

#### KV Cache effect

No direct invalidation; playback is a presentation concern.

## Known Limitations and Deferred Work

- **English JS pack** — the Node `kokoro-js` model exposes 28 English voices; other Kokoro languages stay in the Python pack.
- **First-run download** — q8 weights are about 92 MB from Hugging Face; not an API bill.
- **Unary generate** — streaming `TextSplitterStream` is deferred with the seam's unary Remote.
