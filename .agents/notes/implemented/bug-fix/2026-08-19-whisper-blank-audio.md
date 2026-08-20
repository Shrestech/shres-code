# Agent Note: Whisper `[BLANK_AUDIO]` must not reach the composer

Status: implemented

## Problem

After the Float32Array pipeline fix, Dictate still wrote `[BLANK_AUDIO]` into the draft. That string is Whisper tiny.en's no-speech token. Mic captures are usually 44.1/48 kHz and quiet; a short, low-peak clip at the wrong loudness is classified as silence. The composer then showed the token as if it were the transcript.

## Decision

`prepareWhisperSamples` resamples to 16 kHz, skips inference when the peak is below a silence floor, raises remaining clips to a 0.8 peak, and pads to one second. `stripWhisperTranscript` turns `[BLANK_AUDIO]` (and the same family of no-speech labels) into empty text. The mic control does not call `setDraft` on empty text; the tooltip is "No speech detected…". The browser `AudioContext` is created at 16 kHz so decode already matches Whisper's rate when the engine supports it.

## Alternatives considered

**Lower Whisper `no_speech_threshold` so silence still decodes as words.** Rejected: that transcribes noise. Fix the clip, then refuse a blank token.

**Leave `[BLANK_AUDIO]` in the draft so the user sees the model output.** Rejected: it is not user speech.

## Consequences

A true silent tap no longer pollutes the composer. A quiet but real utterance is gained before inference. Speak for about a second; hover the mic if the blank tooltip appears.
