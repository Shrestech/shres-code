/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopLocale } from './locale.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'shres-desktop:locale-get',
  backendStatus: 'shres-desktop:backend-status',
  backendState: 'shres-desktop:backend-state',
  applicationRestart: 'shres-desktop:application-restart',
  configurationReset: 'shres-desktop:configuration-reset',
  pluginsDisableAll: 'shres-desktop:plugins-disable-all',
} as const

/** Host lifecycle state rendered by the shell's own documents. */
export type DesktopBackendState =
  | { readonly phase: 'starting' }
  | { readonly phase: 'ready' }
  | {
    readonly phase: 'error'
    readonly message: string
    /**
     * True when the startup failure path offered profile recovery (the
     * disable-plugins and reset forms). Absent until the shell's startup-failure
     * document lands; the renderer renders the plain error without it.
     */
    readonly profileRecovery?: boolean
  }

/** Narrow bridge exposed through context isolation. */
export interface ShresDesktopApi {
  readonly protocolVersion: 1
  /**
   * Shell-owned translations for the current locale.
   * @returns the locale table.
   */
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    /**
     * Disable every third-party plugin in the desktop profile.
     * @returns a promise settling after the profile is written.
     */
    disableAll(): Promise<void>
  }
  readonly backend: {
    /**
     * Latest host lifecycle state.
     * @returns the current state.
     */
    status(): Promise<DesktopBackendState>
    /**
     * Subscribe to host lifecycle state changes.
     * @param listener - receives every state after subscription.
     * @returns the unsubscriber.
     */
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  /**
   * Relaunch the application.
   * @returns a promise that settles as the process exits.
   */
  restart(): Promise<void>
  /**
   * Reset the desktop profile configuration.
   * @returns a promise settling after the reset.
   */
  resetConfiguration(): Promise<void>
}

/** Startup-page controls, unavailable to host-provided application documents. */
export interface ShresDesktopStartupApi extends Pick<ShresDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: ShresDesktopApi['backend']
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}
