# Agent Note: Talk mode with spoken confirm-to-send

Status: implemented

## Problem

Dictate fills the composer from a microphone, then the user still types or clicks Send. That is the wrong path for a full voice session: a coding agent must not run on a mis-heard utterance, and Talk must not require a mouse or keyboard to speak or to approve the transcript. In-car Grok voice (hands-free listen, confirm consequential actions, keep a dedicated voice surface) is the product analog; Shres Code's consequential action is `session.prompt`.

## Decision

Talk mode is a durable `speech.talkMode` flag (default false). There is no Talk switch in the chrome. Clicking the composer mic opens a dialog that explains hands-free Talk (speak an instruction, then say yes to send or no to discard) and offers Enable Talk mode, Dictate this once, or Not now. Enable writes `speech.talkMode`. ConversationRoot reads that document and puts `talkMode` on the composer-chain owner. `ui-speech` elects a Talk composer at priority 2 so question and approval takeovers still win; the selector also declines while any interaction is pending. TalkDeck's Type instead control writes `talkMode` false.

While Talk mode is on, the typing composer is hidden, the Dictate control unmounts, and send-after-dictation does not apply. The deck starts listening immediately. Trailing silence or `TALK_INSTRUCTION_MAX_MS` ends the instruction capture. After STT, the deck shows the transcript as read-only status and listens for a yes/no utterance (`TALK_CONFIRM_LISTEN_MS`, two retries). English Kokoro speaks the confirm prompt first, then the yes/no listen starts so the loudspeaker is not captured. A classified confirm calls `inputActions.setDraft` then `submit` and listens for the next instruction. Deny, permission failure, or two unknown answers discard; deny and unknown then listen again. There is no hold, confirm click, or confirm keyboard control.

Spoken language is a `speech.language` picker (twelve BCP-47 tags). English STT uses `Xenova/whisper-tiny.en`; every other tag uses `Xenova/whisper-tiny` with the Whisper language name. Confirm TTS stays English-only because Kokoro's JS pack is English; yes/no classification still uses the selected language's phrase list. Audio never becomes a model content block.

## Alternatives considered

**Auto-submit the instruction the way Dictate does.** Rejected: a coding agent is a consequential action. Tesla/Grok confirms those; a raw transcript must not call `session.prompt`.

**Click Confirm / Discard, or edit the transcript in a textarea.** Rejected for Talk mode: the request is a click-less, keyboard-less confirm. Dictate remains the typed-composer path. A mis-heard instruction is discarded by saying no and spoken again.

**Always-on wake word ("Hey Shres").** Rejected: the session must not listen until the user enables Talk. Enable Talk is the consent gesture; listening then runs only while the Talk deck is mounted, bounded by silence and a max window.

**Speech-to-speech / Grok Realtime as Talk mode.** Rejected: that bypasses the composer, approval strip, and text session log. Talk mode is still text in, text out, with a voice confirm in front of `session.prompt`. See [Speech I/O on the Web client](2026-08-19-speech-io-web.md).

**Web Speech API for confirm listen.** Rejected as the default: Chrome sends audio to Google. Confirm uses the same local Whisper Remote as Dictate.

**Put `talkMode` only in React state.** Rejected: the switch would reset on reload, and ConversationRoot cannot read another plugin's component state. The `speech` settings section is the durable document; the chain owner carries a boolean so the Talk selector stays pure.

**A dedicated Talk toggle in the sidebar or composer chrome.** Rejected: it crowded the wordmark and sat away from the mic. The mic is the Talk entry; the dialog explains hands-free mode before it replaces typing.

## Consequences

`shres --profile web` starts Talk from the composer mic dialog. Enable replaces the typing composer with a hands-free listen. The coding engine runs only after a spoken yes. Type instead returns to the typed composer. Non-English Talk uses multilingual Whisper tiny and a native-script yes/no list; confirm speech is English-only. First-run downloads a second Whisper checkpoint when the language is not English.

## Testing

`packages/client/ui-speech/tests/talk-mode.client.spec.tsx` pins the mic dialog Enable path, spoken yes (send), spoken no (discard), two unknowns (fail closed), Type instead, and selector decline while an approval is pending. `packages/speech/speech/tests/languages.spec.ts` and `packages/speech/speech-whisper/tests/provider.spec.ts` pin checkpoint routing. `speech` is on the API proxy product settings allowlist so the browser can persist `talkMode`. `apps/web/tests/speech-io.e2e.ts` clicks Enable Talk in the assembled app and waits for the Talk deck.
