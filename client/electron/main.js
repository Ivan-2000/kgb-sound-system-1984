import { app, BrowserWindow, session } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupAudioIPC, logDevicesAtStartup } from './nativeAudio/ipc.js'

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

  // Allow microphone and camera access inside the renderer (getUserMedia)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'clipboard-read']
    callback(allowed.includes(permission))
  })

  createMainWindow()

  // Pa_Initialize() calls CoInitializeEx() (COM). Defer until after Electron's own
  // COM setup completes to avoid threading-model conflict on the main thread.
  setImmediate(() => logDevicesAtStartup())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
