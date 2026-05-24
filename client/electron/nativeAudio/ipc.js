import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// libwinpthread-1.dll is a MinGW runtime dependency of the addon.
// Add MSYS2 UCRT64 bin to PATH only when the directory actually exists —
// avoids silent failures on machines where MSYS2 is installed elsewhere.
const MSYS2_BIN = 'C:\\msys64\\ucrt64\\bin'
if (process.platform === 'win32' && existsSync(MSYS2_BIN) && !process.env.PATH?.includes(MSYS2_BIN)) {
  process.env.PATH = `${MSYS2_BIN};${process.env.PATH ?? ''}`
}

let addon = null

function loadAddon() {
  if (addon) return addon
  try {
    addon = require('./portaudioAddon/index.js')
  } catch (e) {
    console.error('[nativeAudio] Cannot load portaudio addon:', e.message)
    if (process.platform === 'win32' && e.message.toLowerCase().includes('winpthread')) {
      console.error('[nativeAudio] libwinpthread-1.dll not found — MSYS2 UCRT64 not at', MSYS2_BIN)
    }
    console.error('[nativeAudio] Rebuild: cd client/electron/nativeAudio/portaudioAddon && npm run rebuild')
  }
  return addon
}

// initAudio() — call once at startup (deferred past Electron COM setup).
// Calls Pa_Initialize(); all subsequent getDevices() and A3 stream calls
// reuse this single PA context.
export function initAudio() {
  const a = loadAddon()
  if (!a) return
  try {
    a.paInit()
    console.log('[nativeAudio] PortAudio initialized')
  } catch (e) {
    console.error('[nativeAudio] Pa_Initialize failed:', e.message)
  }
}

// terminateAudio() — call from app.before-quit.
export function terminateAudio() {
  if (!addon) return
  try {
    addon.paTerminate()
    console.log('[nativeAudio] PortAudio terminated')
  } catch (e) {
    console.error('[nativeAudio] Pa_Terminate failed:', e.message)
  }
}

export function setupAudioIPC() {
  ipcMain.handle('audio:list-devices', () => {
    const a = loadAddon()
    if (!a) return []
    try {
      return a.getDevices()
    } catch (e) {
      console.error('[nativeAudio] getDevices error:', e.message)
      return []
    }
  })
}

export function logDevicesAtStartup() {
  const a = loadAddon()
  if (!a) return

  let devices
  try {
    devices = a.getDevices()
  } catch (e) {
    console.error('[nativeAudio] Error enumerating devices:', e.message)
    return
  }

  console.log(`[nativeAudio] ${devices.length} audio device(s) found:`)
  for (const dev of devices) {
    const apis = dev.hostApis.map((h) => h.kind).join(', ')
    const ch = `in:${dev.inputChannels} out:${dev.outputChannels}`
    console.log(`  [${dev.id}] ${dev.name}  ${ch}  [${apis}]`)
  }
}
