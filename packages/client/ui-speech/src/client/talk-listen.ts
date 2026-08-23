/**
 * Hands-free instruction capture: end on trailing silence, or at a max
 * duration when the analyser cannot run.
 */

/** Longest instruction listen before auto-stop. */
export const TALK_INSTRUCTION_MAX_MS = 15_000

/** Quiet time after speech that ends the instruction listen. */
export const TALK_SILENCE_MS = 1_200

/** Minimum voiced time before silence can stop the listen. */
export const TALK_MIN_SPEECH_MS = 400

/** Time-domain RMS treated as voice. */
export const TALK_SPEECH_RMS = 0.025

const ANALYSER_FFT = 1_024
const ANALYSER_TICK_MS = 50

/**
 * Stop an in-progress instruction recording after silence or the max window.
 * @param stream - live microphone stream already handed to MediaRecorder.
 * @param onEnd - invoked once when the utterance should stop.
 * @returns a disposer that cancels the watch without invoking `onEnd`.
 */
export function watchUtteranceEnd(stream: MediaStream, onEnd: () => void): () => void {
  let stopped = false
  let interval: ReturnType<typeof setInterval> | undefined
  let context: AudioContext | undefined

  const finish = (): void => {
    if (stopped) return
    stopped = true
    if (interval !== undefined) clearInterval(interval)
    clearTimeout(maxTimer)
    if (context !== undefined) {
      void context.close().catch(() => {
        // AudioContext.close rejects after a failed decode; the instance is already dead.
      })
    }
    onEnd()
  }

  const maxTimer = setTimeout(finish, TALK_INSTRUCTION_MAX_MS)

  try {
    context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = ANALYSER_FFT
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let heardAt: number | undefined
    let silentFrom: number | undefined
    interval = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      const rms = Math.sqrt(sum / samples.length)
      const now = Date.now()
      if (rms >= TALK_SPEECH_RMS) {
        heardAt ??= now
        silentFrom = undefined
        return
      }
      if (heardAt === undefined || now - heardAt < TALK_MIN_SPEECH_MS) return
      silentFrom ??= now
      if (now - silentFrom >= TALK_SILENCE_MS) finish()
    }, ANALYSER_TICK_MS)
  } catch {
    // Analyser unavailable; the max timer still ends the utterance.
  }

  return () => {
    if (stopped) return
    stopped = true
    if (interval !== undefined) clearInterval(interval)
    clearTimeout(maxTimer)
    if (context !== undefined) {
      void context.close().catch(() => {
        // AudioContext.close rejects after a failed decode; the instance is already dead.
      })
    }
  }
}
