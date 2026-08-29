# @shres-code/shres-code-wiki-embed-onnx

Optional embeddings Service Provider for `ctx.wiki`. It loads EmbeddingGemma-300M ONNX in-process through `@huggingface/transformers` (`feature-extraction`) and registers on `ctx.wiki.registerEmbeddings`. Search mixes cosine with BM25 while the provider is available; disposing it or leaving it unmounted leaves BM25-only ranking.

Weights cache under `shresHomePath('models', 'wiki')`. Tests inject a loader so CI never downloads.

## Plugin (namespace: `wiki-embed-onnx`)

```yaml
- id: wiki-embed-onnx
  name: '@shres-code/shres-code-wiki-embed-onnx'
  config:
    enabled: true
    allowDownload: true
```

| Field | Default | Meaning |
|---|---|---|
| `modelId` | `onnx-community/embeddinggemma-300m-ONNX` | Hugging Face model id. |
| `cacheDir` | `$SHRES_HOME/models/wiki/<model>` | Weight cache. |
| `allowDownload` | `true` | When false, a cold cache reports unavailable instead of fetching. |
| `enabled` | `true` | Master allow for this backend. |

## Model Experience

None, as this provider supplies vectors to `ctx.wiki.search`; the tool Consumer owns every model-visible byte.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **First embed may download weights** — unless `allowDownload` is false and the cache is already warm.
- **In-process only** — there is no remote embeddings provider in v1; a missing mount is BM25-only, not an error.
