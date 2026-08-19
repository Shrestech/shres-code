/**
 * One HTMLAudioElement for the page: a new play replaces the current one
 * and every speaker button observes the current owner.
 * @module @shres-code/shres-code-client-ui-speech/client/playback
 */

/** Identity of the SpeakButton that currently owns the shared element. */
export type SpeechPlaybackOwner = symbol

/** Shared playback so only one assistant message speaks at a time. */
export interface SpeechPlayback {
  /**
   * Stop the current element and clear ownership.
   */
  stop(): void
  /**
   * Replace the current element and mark `owner` as playing.
   * @param owner - the SpeakButton that started this play.
   * @param bytes - decoded audio body.
   * @param mediaType - WAV or MPEG.
   */
  play(owner: SpeechPlaybackOwner, bytes: Uint8Array, mediaType: string): Promise<void>
  /**
   * Subscribe to owner changes (start, natural end, takeover, error, stop).
   * @param listener - called with the current owner, or `null` when idle.
   * @returns disposer.
   */
  subscribe(listener: (owner: SpeechPlaybackOwner | null) => void): () => void
  /**
   * @returns the SpeakButton that currently owns the element, if any.
   */
  currentOwner(): SpeechPlaybackOwner | null
}

/**
 * Create a browser playback handle.
 * @returns shared playback plus a dispose that stops the current element.
 */
export function createSpeechPlayback(): SpeechPlayback & { dispose(): void } {
  let current: HTMLAudioElement | null = null
  let url: string | null = null
  let owner: SpeechPlaybackOwner | null = null
  const listeners = new Set<(next: SpeechPlaybackOwner | null) => void>()

  const notify = (): void => {
    for (const listener of listeners) listener(owner)
  }

  const stop = (): void => {
    if (current !== null) {
      current.onended = null
      current.onerror = null
      current.pause()
      current.removeAttribute('src')
      current = null
    }
    if (url !== null) {
      URL.revokeObjectURL(url)
      url = null
    }
    if (owner !== null) {
      owner = null
      notify()
    }
  }

  return {
    stop,
    async play(nextOwner, bytes, mediaType) {
      stop()
      const blob = new Blob([bytes], { type: mediaType })
      url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      current = audio
      owner = nextOwner
      notify()
      audio.onended = () => { stop() }
      audio.onerror = () => { stop() }
      try {
        await audio.play()
      } catch {
        stop()
        throw new Error('speech playback was rejected')
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    currentOwner: () => owner,
    dispose: stop,
  }
}
