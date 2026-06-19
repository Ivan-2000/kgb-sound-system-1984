import { app, BrowserWindow, session, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupAudioIPC, initAudio, terminateAudio, logDevicesAtStartup } from './nativeAudio/ipc.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrlArg = process.argv.find((arg) => arg.startsWith('--dev-server='))
const devServerUrl = devServerUrlArg?.replace('--dev-server=', '')

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#050505',
    title: 'KGB Sound System 85',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,  // preload uses ipcRenderer (Node API); renderer stays isolated
      preload: join(__dirname, 'nativeAudio/preload.js'),
    },
  })

  // Ctrl+Shift+I opens DevTools in any mode for debugging
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  if (app.isPackaged || !devServerUrl) {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
    return
  }

  mainWindow.loadURL(devServerUrl)
  mainWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  setupAudioIPC()

  // Debug-only: per-process CPU/RAM for the debug HUD's "procs" tab
  // (client/src/debug/collectors/procs.ts). app.getAppMetrics() already
  // breaks down main/renderer/utility/GPU — no extra bookkeeping needed here.
  ipcMain.handle('debug:get-process-metrics', () =>
    app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name,
      cpuPercent: m.cpu.percentCPUUsage,
      memoryKB: m.memory?.workingSetSize ?? 0,
    })),
  )

  // Allow microphone and camera access inside the renderer (getUserMedia)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'clipboard-read']
    callback(allowed.includes(permission))
  })

  createMainWindow()

  // Pa_Initialize() calls CoInitializeEx() (COM). Defer until after Electron's
  // own COM setup completes to avoid threading-model conflict on the main thread.
  // initAudio() initializes the single PA context that lives for the app lifetime;
  // logDevicesAtStartup() uses that same context via getDevices().
  setImmediate(() => {
    initAudio()
    logDevicesAtStartup()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// Pa_Terminate() must run before the process exits so the audio utility can
// cleanly shut down any open streams and release device handles. terminateAudio
// is async since A3.5c (round-trips a shutdown message to the utilityProcess),
// so we hold quit with preventDefault → await → app.exit(). The isQuitting
// latch avoids re-entry when app.exit() refires before-quit handlers.
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  terminateAudio().finally(() => app.exit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
