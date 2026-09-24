# shres-laya-gateway

A loopback HTTP gateway that serves local [Laya](https://github.com/NandhaKishorM/laya) typed judgments over the Shield judgment wire owned by [`@shres-code/shres-code-judgment-shield`](../../packages/llm/judgment-shield/README.md). Inference runs through [laya-mlx](https://github.com/mizorewww/laya-mlx) on Apple silicon; no conversation text leaves the machine. The Node provider [`@shres-code/shres-code-judgment-laya`](../../packages/llm/judgment-laya/README.md) installs this package into a uv-managed virtual environment and supervises one gateway process; nothing else starts it.

## Commands

`python -m laya_gateway serve --manifest M --model-dir D --dtype float16|float32 --batch-size N --max-request-bytes B [--port 0]` verifies every file in `D` against the manifest's SHA-256 digests, loads the checkpoint, requires its `max_len` to equal the manifest's `checkpointContext`, binds `127.0.0.1`, and prints exactly one readiness line to stdout:

```json
{"ready":true,"port":53117,"model":"convaiinnovations/laya-typed-decisions@f9ab0b22…","manifestSha256":"028fa5c4…","limits":{"maxSequenceTokens":1024,"maxHeadTokens":256,"maxBatchTokens":16384,"manifestSha256":"028fa5c4…"}}
```

`python -m laya_gateway install --manifest M --dest D` downloads exactly the manifest's files at its pinned revision into `D`, verifies every digest, and deletes `D` when any file differs. It is the only command that touches the network; the supervisor runs `serve` with `HF_HUB_OFFLINE=1`.

Exit codes are 0 for success, 2 for usage, 3 for a malformed manifest or a checkpoint that differs from it, and 4 for a model load failure. Diagnostics go to stderr; stdout carries only the readiness line or the install result.

## Wire

| Route | Behavior |
|---|---|
| `GET /healthz` | `{ok, model, manifestSha256}`. |
| `POST /v1/judgments` | Answers every question about one state. A state longer than the checkpoint window is truncated exactly as upstream Laya truncates it. |
| `POST /v1/judgments/fitted` | Judges the first state whose every question sequence and padded batch fit without truncation, and reports the token counts. A question head or option Laya would truncate refuses the ask with `head` or `option`; no fitting state refuses it with `state` or `batch`. A refusal runs no inference. |

Every response carries `engine: "shield"` and the exact model id `repo@revision`; a request naming another model receives HTTP 409. Choice and score probabilities are renormalized to six decimals, and a score is the expectation of its level distribution. `maxBatchTokens` is `max_len × batch_size`.

Requests must be `application/json` with a `content-length` no larger than `--max-request-bytes` and a `Host` header naming the gateway's own loopback address; this refuses simple cross-origin browser requests and DNS-rebinding hosts. Inference is serialized behind one lock. The gateway never logs requests or request bodies.

## Manifests

`manifests/<revision>.json` pins one checkpoint revision: the repository, the 40-character revision, the checkpoint context, and each file's byte size and SHA-256 digest. The Node provider's `model.manifestSha256` is the SHA-256 of the exact manifest bytes, so a manifest edit requires a matching configuration change.

## Development

Keep the virtual environment outside `python/` and run the suite; it uses a stub backend and needs no MLX:

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/laya-gateway-venv"
uv run --project python/laya-gateway --python 3.11 --group test pytest
```

On Apple silicon, point `LAYA_GATEWAY_MODEL_DIR` at an installed checkpoint to run the `integration` tests against real laya-mlx.
