/** Context-isolated renderer bridge for desktop package and host operations. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DesktopBackendState, type ShresDesktopApi } from './ipc.ts'
import type { DesktopLocale } from './locale.ts'

const api: ShresDesktopApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as Promise<DesktopLocale>,
  plugins: {
    disableAll: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  },
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as Promise<DesktopBackendState>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

contextBridge.exposeInMainWorld('shresDesktop', api)
