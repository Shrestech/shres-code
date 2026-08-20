# Agent Note: Whisper transcribe must pass a Float32Array

Status: implemented

## Problem

Dictate reached Transcribing then failed. `@huggingface/transformers` 3.8's Whisper pipeline (`prepareAudios`) only special-cases a URL or `Float64Array`; a `{ raw, sampling_rate }` object is forwarded unchanged. `WhisperFeatureExtractor` then throws: it expects a `Float32Array`. The Web client was sending PCM16 WAV at the AudioContext rate (typically 48 kHz). Transformers does not resample a raw array, so even a correct typed array at 48 kHz would be treated as 16 kHz.

## Decision

`WhisperSttProvider.transcribe` decodes the WAV, linearly resamples to 16 kHz (`WHISPER_SAMPLE_RATE`), and calls the pipeline with that `Float32Array`. Tests inject a fake engine and assert they receive an array, not an object.

## Alternatives considered

**Pass `{ raw, sampling_rate }` and wait for transformers to resample.** Rejected: 3.8's `prepareAudios` ignores that object and the feature extractor throws.

**Resample in the browser before the Remote.** Rejected: every STT client would have to match Whisper's rate; the provider already owns WAV decode.

## Consequences

First Dictate after this fix still downloads weights if the cache is cold, then transcribes. A process that already loaded the broken engine must be restarted so `ensureEngine` rebuilds against the new call.
