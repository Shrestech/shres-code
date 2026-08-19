/**
 * The speech Remote calls this plugin needs. The generated face wraps every
 * business result in RemoteResult.
 * @module @shres-code/shres-code-client-ui-speech/client/remote
 */

import type { RemoteResult } from '@shres-code/shres-code-typert-protocol'
import type {
  SpeechStatus,
  SpeechSynthesizeWireRequest,
  SpeechSynthesizeWireResult,
  SpeechTranscribeWireRequest,
  SpeechTranscribeWireResult,
} from '@shres-code/shres-code-speech/types'

/** Host speech methods used by the Web controls. */
export interface SpeechRemote {
  status: () => Promise<RemoteResult<SpeechStatus>>
  synthesize: (request: SpeechSynthesizeWireRequest) => Promise<RemoteResult<SpeechSynthesizeWireResult>>
  transcribe: (request: SpeechTranscribeWireRequest) => Promise<RemoteResult<SpeechTranscribeWireResult>>
}
