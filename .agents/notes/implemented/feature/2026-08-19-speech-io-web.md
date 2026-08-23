# Agent Note: Speech I/O on the Web client

Status: implemented

## Problem

The Web GUI is a typed composer plus an assistant transcript. Users who want to talk instead of type, or hear a finished answer, have no product path. Browser `speechSynthesis` is robotic. Sending raw audio to the model would be a new content block, a session-format change, and an ACP `promptCapabilities.audio` flip the rest of the stack does not implement. MCP already discards audio tool results as `[audio: …, content discarded]`.

## Decision

Speech is a host capability seam (`ctx.speech`) with TTS and STT behind one provider-selection policy, plus a Web client that records and plays. The model still sees and writes text.

**Seam, not loop.** `synthesize` and `transcribe` resolve providers with the same pin / ordered-fallback / single-usable auto-select rules as `ctx.web`. Duplicate ids throw `SPEECH_DUPLICATE_PROVIDER`. Caps `maxAudioBytes` and `maxTextChars` are required Config. Markdown is converted to a speakable script on the host before TTS so code fences become `Code block.` and tables become `Table omitted.` instead of being read token-by-token.

**Text in, text out.** Dictate lands in the existing composer draft (`inputActions.setDraft`). Talk mode is a composer takeover that still sends ordinary prompt text, but only after a spoken yes/no confirm — see [Talk mode](2026-08-20-talk-mode-voice-confirm.md). Read-aloud consumes the same visible assistant text the copy action already concatenates. No `audio` content block, no `SESSION_FORMAT_VERSION` bump, no ACP audio capability, no prompt section that tells the model the user is listening.

**Local neural engines, no billed API.** TTS is Kokoro-82M via `kokoro-js` on the Node CPU (28 English voices, default `af_heart`). STT is Whisper tiny.en via `@huggingface/transformers`. Weights cache under the harness home. Unary Typert Remotes carry canonical-base64 WAV. `status()` lets the client disable mic and speaker when a cache is cold and downloads are forbidden.

**After the turn, not realtime.** Read-aloud is a speaker control on a settled assistant message. Auto-play of a live-closing turn is not shipped. Speech-to-speech realtime is a different product and is not this seam.

## Alternatives considered

**Browser `speechSynthesis` for TTS.** Rejected: it is the robotic path the product requirement forbids, and quality varies by OS voice pack.

**A billed Voice API (xAI, OpenAI, ElevenLabs).** Rejected: per-character or per-minute pricing. Local Kokoro and Whisper tiny.en download once and run offline.

**Piper as the default TTS.** Rejected: it is widely described as robotic, which fails the product requirement.

**Web Speech API for STT.** Rejected as the default: Chrome sends audio to Google. Local Whisper tiny.en stays on the machine.

**Audio content blocks and durable audio attachments.** Rejected: that would make audio model-visible, force every adapter, compaction, and snapshot to learn a new block, and contradict ACP's current `audio: false`. Talk-to-type does not need it.

**Fold speech into `ctx.llm` or `ctx.web`.** Rejected: Voice HTTP is not a chat completion and not search/fetch. A third capability on those seams would mix selection policy and error taxonomies.

**Speech-to-speech / Grok Realtime as v1.** Rejected: barge-in voice agents bypass the composer, the approval strip, and after-turn playback. The requested product is mic-as-typing plus read-aloud-when-done.

**HTTP routes instead of Typert Remotes.** Rejected: the Web client already talks to host business methods through generated Remotes; images already proved canonical base64 over JSON. A dedicated `/api/speech` surface would be a second binary channel for one unary call.

## Consequences

`shres --profile web` can record a microphone and play Kokoro TTS with no speech API key. First run downloads ONNX weights into `~/.shres/models/speech/`. Tests mock the engines so CI never downloads them. `onnxruntime-node` install scripts are allowed; `sharp` is denied.

The Web consumer requires `remote.speech`. Playback is a single shared element with owner notifications so a finished or replaced play clears the speaker. Mic and speaker stay disabled until `status()` reports the matching capability ready. The voice catalog lives on that same snapshot so General Settings does not freeze an empty list. The unused `readAloud` settings field stays on the host section for a later auto-play consumer.

Headless and ACP load the host packages and do not grow a UI. Read-aloud defaults off.

Safari capture of `audio/webm` is a known client limitation of the recorder, not of the seam's input MIME list.

Streaming TTS playback, custom voice clone, CLI speakers, and audio-to-model remain deferred.
