/**
 * TypeScript client SDK for the Roos Code runtime: spawn the
 * `roos-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `DeepSeekHarness` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete harness configured by its own `cordis.yml`.
 *
 * @module @roos-code/roos-code-sdk-client
 */

export { DeepSeekHarness, HarnessSession } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@roos-code/roos-code-sdk-protocol'
export type {
  ContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
