/** Startup controls for shell documents; application documents receive only the carrier marker. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DesktopBackendState, type ShresDesktopStartupApi } from './ipc.ts'
import type { DesktopLocale } from './locale.ts'

const startup: ShresDesktopStartupApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as Promise<DesktopLocale>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as Promise<DesktopBackendState>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

contextBridge.exposeInMainWorld('shresDesktop', location.protocol === 'shres-app:' && location.hostname === 'shell'
  ? startup : { protocolVersion: 1 })
