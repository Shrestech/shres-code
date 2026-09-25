/**
 * The `laya` Remote: status, install, and restart of the supervised local
 * gateway for configuration surfaces — the same operations `/laya` runs.
 */

import type { Context } from '@shres-code/cordis'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { LayaGatewayView, LayaInstallResult } from './types.ts'

/** The engine operations the Remote exposes. */
export interface LayaGatewayControl {
  /**
   * Read the gateway's current view.
   * @returns the state, pin, and last exit.
   */
  view(): LayaGatewayView
  /**
   * Install the environment and pinned checkpoint, then restart the gateway.
   * @returns the verified checkpoint directory and digests.
   */
  install(): Promise<LayaInstallResult>
  /** Stop the gateway, reset its restart budget, and launch it again. */
  restart(): Promise<void>
}

/** Remote-only service over one Laya engine, wire namespace `laya`. */
export class LayaGatewayRemote extends TypertRemoteService {
  /**
   * @param ctx - the engine's context; the service leaves with its fiber.
   * @param control - the engine's gateway operations.
   */
  constructor(ctx: Context, private readonly control: LayaGatewayControl) {
    super(ctx, 'layaGatewayRemote', { namespace: 'laya' })
  }

  /**
   * Read the gateway state, pin, and last exit.
   * @returns a JSON view; status changes also announce `judgment/engines-updated`.
   */
  @Remote('status')
  status(): LayaGatewayView {
    return this.control.view()
  }

  /**
   * Install (or reinstall) the pinned environment and checkpoint; the only
   * download path. Concurrent calls share one install, which runs under the
   * engine's lifetime rather than the caller's connection.
   * @returns the verified checkpoint directory and digests.
   * @throws Error naming the failed step; the gateway restarts either way.
   */
  @Remote('install')
  async install(): Promise<LayaInstallResult> {
    return this.control.install()
  }

  /**
   * Restart the gateway with a fresh restart budget.
   * @returns the view after the restart began.
   */
  @Remote('restart')
  async restart(): Promise<LayaGatewayView> {
    await this.control.restart()
    return this.control.view()
  }
}
