/** `speech` namespace dictionaries. */

/** English dictionary, the key-set source of truth. */
export const en = {
  'mic.idle': 'Dictate',
  'mic.recording': 'Stop recording',
  'mic.transcribing': 'Transcribing',
  'mic.unavailable': 'Speech-to-text is unavailable',
  'mic.permission': 'Microphone permission denied',
  'mic.failed': 'Could not transcribe this recording',
  'speak.play': 'Read aloud',
  'speak.stop': 'Stop reading',
  'speak.loading': 'Preparing audio',
  'speak.unavailable': 'Read-aloud is unavailable',
  'speak.failed': 'Could not prepare audio',
  'settings.voice.title': 'Read-aloud voice',
  'settings.voice.description': 'Kokoro voice used for read-aloud. Twenty-eight US and UK voices.',
  'settings.autoSubmit.title': 'Send after dictation',
  'settings.autoSubmit.description': 'Submit the transcribed draft immediately instead of leaving it in the composer.',
  'settings.autoSubmit.on': 'On',
  'settings.autoSubmit.off': 'Off',
} satisfies Record<string, string>

/** The SpeechKey union. */
export type SpeechKey = keyof typeof en
