// Main-process side of the native audio IPC (ADR-001 §3.3 control plane).
// A2 scope: device enumeration only. Stream open/close added in A3.
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ipcMain } from 'electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// libwinpthread-1.dll is a MinGW runtime dependency of the addon.
// Add MSYS2 UCRT64 bin to PATH so Windows can resolve it at addon load time.
const MSYS2_BIN = 'C:\\msys64\\ucrt64\\bin'
if (process.platform === 'win32' && !process.env.PATH?.includes(MSYS2_BIN)) {
  process.env.PATH = `${MSYS2_BIN};${process.env.PATH ?? ''}`
}

let addon = null

function loadAddon() {
  if (addon) return addon
  try {
    addon = require('./portaudioAddon/index.js')
  } catch (e) {
    console.error('[nativeAudio] Cannot load portaudio addon:', e.message)
    console.error('[nativeAudio] Run: cd client/electron/nativeAudio/portaudioAddon && npm install && npm run build')
  }
  return addon
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
