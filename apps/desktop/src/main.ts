/**
 * Electron shell: desktop project ownership, the shres-app:// protocol, the
 * startup and application windows, the host child lifecycle, and the shell's
 * IPC surface.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopHostProcess } from './host-process.ts'
import { DESKTOP_IPC, type DesktopBackendState } from './ipc.ts'
import { resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { desktopErrorState } from './startup-error.ts'
import { startupFailureDocument } from './startup-document.ts'

const SCHEME = 'shres-app'
const RECOVERY_HOSTS = ['restart', 'plugins', 'reset'] as const
type RecoveryAction = typeof RECOVERY_HOSTS[number]

let focusPrimaryWindow = (): void => {}
let recoverApplication = (action: RecoveryAction): Promise<void> => {
  if (action !== 'restart') return Promise.reject(new Error('desktop recovery could not initialize; reinstall the application'))
  app.relaunch()
  app.quit()
  return Promise.resolve()
}
const emergencyPages = new WeakMap<BrowserWindow, { url: string; message: string; busy: boolean }>()

async function showEmergencyDocument(window: BrowserWindow, message: string): Promise<void> {
  const document = startupFailureDocument(resolveDesktopLocale(app.getLocale()), message)
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(document)
  emergencyPages.set(window, { url, message, busy: false })
  await window.loadURL(url)
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Node-compatible executable and runtime directory the host child is spawned from. */
interface RuntimeResources {
  readonly node: string
  readonly runtime: string
}

/**
 * Resolve the host child's launch inputs. A packaged build carries its runtime
 * tree in the application directory; a development launch points at the
 * generated workspace project.
 * @returns the executable and runtime directory.
 */
function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const runtime = process.env.SHRES_DESKTOP_RUNTIME_DIR
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(process.resourcesPath, 'shres'))
  return { node: process.env.SHRES_DESKTOP_NODE_BINARY ?? process.execPath, runtime }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.SHRES_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('shres desktop: SHRES_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol !== SCHEME + ':') event.preventDefault()
    const page = emergencyPages.get(window)
    if (page === undefined || page.busy || window.webContents.getURL() !== page.url) return
    const action = new URL(url)
    if (action.protocol !== 'shres-recovery:' || !RECOVERY_HOSTS.includes(action.hostname as RecoveryAction)) return
    // Only restart stays reachable until a packaged build owns profile repair.
    if (action.hostname !== 'restart') return
    page.busy = true
    void recoverApplication(action.hostname as RecoveryAction).catch(async (error: unknown) => {
      if (!window.isDestroyed()) await showEmergencyDocument(window, page.message + '\n' + desktopErrorState(error).message)
    }).catch((error: unknown) => { console.error(error) }).finally(() => { page.busy = false })
  })
  return window
}

function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('shres desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== SCHEME + ':' || !hostnames.includes(url.hostname)) {
    throw new Error('shres desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

async function main(): Promise<void> {
  // Unpackaged macOS launches inherit Electron's bundle icon.
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = app.isPackaged ? undefined : resources.runtime
  const activeProject = development ?? paths.profile
  const locale = resolveDesktopLocale(app.getLocale())
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const startupUrl = SCHEME + '://shell/startup.html'
  const applicationUrl = SCHEME + '://app/index.html'
  let quitting = false
  let pageError: Extract<DesktopBackendState, { phase: 'error' }> | undefined = undefined
  let state: DesktopBackendState = { phase: 'starting' }
  let host: DesktopHostProcess | undefined
  let mainWindow: BrowserWindow | undefined
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  let emergencyDocument = false
  let starting: Promise<void> | undefined

  const backendState = (): DesktopBackendState => pageError ?? state
  const publishBackend = (next: DesktopBackendState): void => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(DESKTOP_IPC.backendState, next)
  }

  const showEmergencyError = async (error: unknown): Promise<void> => {
    if (quitting || emergencyDocument) return
    emergencyDocument = true
    const diagnostic = desktopErrorState(error).message
    pageError = { phase: 'error', message: diagnostic } satisfies Extract<DesktopBackendState, { phase: 'error' }>
    if (mainWindow !== undefined) await showEmergencyDocument(mainWindow, diagnostic)
  }

  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || emergencyDocument || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || window.isDestroyed() || navigation !== next) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }

  const stopHost = async (): Promise<void> => {
    const current = host
    host = undefined
    await current?.stop()
  }

  const showStartupError = async (error: unknown): Promise<void> => {
    if (quitting) return
    pageError = desktopErrorState(error)
    try { await navigateMain(startupUrl) }
    catch (navigationError) {
      await showEmergencyError(new AggregateError([error, navigationError], locale.messages.startupFailed))
    }
    publishBackend(backendState())
  }

  const startHost = (): Promise<void> => {
    starting ??= (async () => {
      pageError = undefined
      await navigateMain(startupUrl)
      publishBackend({ phase: 'starting' })
      const child = new DesktopHostProcess(
        resources.node,
        resources.runtime,
        activeProject,
        developmentHostInspectPort(development !== undefined),
        process.env,
        (error) => { void showStartupError(error).catch((failure: unknown) => { console.error(failure) }) },
      )
      host = child
      await child.start()
      state = { phase: 'ready' }
      publishBackend(backendState())
      await navigateMain(applicationUrl)
    })().catch(async (error: unknown) => {
      await showStartupError(error)
      throw error
    }).finally(() => { starting = undefined })
    return starting
  }

  recoverApplication = async (action): Promise<void> => {
    await starting?.catch(() => undefined)
    await stopHost()
    if (action === 'restart') {
      app.relaunch()
      app.quit()
      return
    }
    throw new Error('shres desktop: profile recovery is not available in this build')
  }

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') {
      return serveShellAsset(request).then((response) => {
        if (response.status >= 400 && ['/startup.html', '/startup.js', '/startup.css'].includes(url.pathname)) {
          void showEmergencyError(new Error('desktop recovery resource could not be loaded: ' + url.pathname + ' (HTTP ' + String(response.status) + ')'))
            .catch((error: unknown) => { console.error(error) })
        }
        return response
      })
    }
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.backendStatus, (event) => {
    assertDesktopSender(event, ['shell'])
    return backendState()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsDisableAll, (event) => {
    assertDesktopSender(event, ['shell'])
    throw new Error('shres desktop: plugin management requires a packaged application')
  })
  ipcMain.handle(DESKTOP_IPC.configurationReset, (event) => {
    assertDesktopSender(event, ['shell'])
    throw new Error('shres desktop: profile reset requires a packaged application')
  })
  ipcMain.handle(DESKTOP_IPC.applicationRestart, async (event) => {
    assertDesktopSender(event, ['shell'])
    try {
      await recoverApplication('restart')
    } catch (error) {
      await showStartupError(error)
    }
  })

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true)
    mainWindow = window
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('preload-error', (_event, _path, error) => {
      void showEmergencyError(error).catch((failure: unknown) => { console.error(failure) })
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      emergencyDocument = false
      void showStartupError(new Error('desktop renderer exited: ' + details.reason))
        .catch((failure: unknown) => { console.error(failure) })
    })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      createMainWindow()
      void navigateMain(backendState().phase === 'ready' ? applicationUrl : startupUrl)
        .catch((error: unknown) => { console.error(error) })
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopHost().catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  })

  const window = createMainWindow()
  mainWindow = window
  await startHost().catch(() => undefined)
  // A quit during the host start may have destroyed the window already.
  if (window.isDestroyed()) return
  if (development && process.env.SHRES_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.SHRES_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, (error instanceof Error ? error.stack ?? message : message) + '\n').catch(() => undefined)
  }
  const window = BrowserWindow.getAllWindows()[0]
    ?? createWindow(fileURLToPath(new URL('./preload-app.cjs', import.meta.url)), true)
  window.once('closed', () => { app.quit() })
  await showEmergencyDocument(window, message)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
