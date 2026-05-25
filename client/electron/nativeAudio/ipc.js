import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { ipcMain, MessageChannelMain } from 'electron'

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

// Main-side end of the MessageChannelMain used for PCM data plane.
// The renderer end is delivered via webContents.postMessage('audio:port', …).
let audioDataPort = null
let pcmStreamId = 0
let firstChunkSent = false

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
    // closeStream is idempotent — call unconditionally so a paused-but-open
    // stream (Pa_IsStreamActive returns 0 but the handle still holds the
    // device) is cleaned up before Pa_Terminate. PortAudio leaks driver
    // handles on some Windows backends if Pa_Terminate runs with open
    // streams.
    addon.closeStream?.()
  } catch (e) {
    console.error('[nativeAudio] closeStream during shutdown failed:', e.message)
  }
  closeAudioPort()
  try {
    addon.paTerminate()
    console.log('[nativeAudio] PortAudio terminated')
  } catch (e) {
    console.error('[nativeAudio] Pa_Terminate failed:', e.message)
  }
}

function closeAudioPort() {
  if (audioDataPort) {
    try { audioDataPort.close() } catch { /* port may already be closed */ }
    audioDataPort = null
  }
  firstChunkSent = false
}

// openStreamInternal — shared by audio:open-stream and audio:reinit.
// Returns the JSON-safe response delivered to the renderer.
function openStreamInternal(event, opts) {
  const a = loadAddon()
  if (!a) return { ok: false, error: 'addon not loaded' }

  // Tear down any prior stream so reinit is safe to call repeatedly.
  try { if (a.isStreamActive?.()) a.closeStream() } catch (e) {
    console.error('[nativeAudio] prior closeStream failed:', e.message)
  }
  closeAudioPort()

  const streamId = ++pcmStreamId
  const { port1, port2 } = new MessageChannelMain()
  audioDataPort = port1
  audioDataPort.start()

  // If the renderer reloads / window closes, the renderer-side port closes
  // and the channel disconnects. Without this, the addon stream keeps
  // running, audio thread burns CPU, and frames quietly drop because
  // postMessage throws. Tear down the native stream on disconnect.
  audioDataPort.on('close', () => {
    // Guard against the close firing for an already-replaced port (reinit).
    if (audioDataPort !== port1) return
    audioDataPort = null
    firstChunkSent = false
    try { a.closeStream() } catch (e) {
      console.error('[nativeAudio] closeStream after port disconnect failed:', e.message)
    }
  })

  let result
  try {
    result = a.openStream(
      {
        // Split-device fields (A3.5b): WASAPI/DS/WDM-KS expose input and output
        // of the same physical device as separate PA indices on Windows.
        inputDeviceId:     opts.inputDeviceId,
        outputDeviceId:    opts.outputDeviceId,
        inputHostApiKind:  opts.inputHostApiKind,
        outputHostApiKind: opts.outputHostApiKind,
        // Back-compat: single deviceId covers both sides (old callers unchanged).
        deviceId:          opts.deviceId,
        hostApiKind:       opts.hostApiKind ?? 'WASAPI_SHARED',
        sampleRate:        opts.sampleRate  ?? 48000,
        bufferSize:        opts.bufferSize  ?? 256,
        inputChannels:     opts.inputChannels ?? 2,
        outputChannels:    opts.outputChannels,
      },
      // Audio thread → TSFN → this JS callback. Forward each PCM chunk to
      // the renderer through the MessageChannelMain. NB: MessagePortMain in
      // the main process only accepts MessagePortMain[] in the transfer list
      // (unlike renderer's MessagePort), so the ArrayBuffer rides as a normal
      // structured-clone copy — ~2 KB per frame at 187 fps is negligible.
      (arrayBuffer, frames, channels) => {
        if (!audioDataPort) return
        const message = {
          kind: 'pcm',
          streamId,
          frames,
          channels,
          payload: arrayBuffer,
        }
        if (!firstChunkSent) {
          firstChunkSent = true
          try {
            message.latency = a.getStreamLatency()
          } catch { /* ignore — latency is best-effort metadata */ }
        }
        try {
          audioDataPort.postMessage(message)
        } catch {
          // Renderer-side port was closed; stop trying to send.
          closeAudioPort()
        }
      },
    )
  } catch (e) {
    closeAudioPort()
    return { ok: false, error: e.message }
  }

  // Deliver the renderer end of the channel. The preload listens for
  // 'audio:port' and wires up onmessage → contextBridge handlers.
  try {
    event.sender.postMessage('audio:port', { streamId }, [port2])
  } catch (e) {
    closeAudioPort()
    try { a.closeStream() } catch { /* ignore */ }
    return { ok: false, error: 'postMessage failed: ' + e.message }
  }

  return { ok: true, streamId, ...result }
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

  ipcMain.handle('audio:open-stream', (event, opts) => openStreamInternal(event, opts ?? {}))

  ipcMain.handle('audio:reinit', (event, opts) => openStreamInternal(event, opts ?? {}))

  ipcMain.handle('audio:close-stream', () => {
    const a = loadAddon()
    if (!a) return { ok: true }
    try { a.closeStream() } catch (e) {
      console.error('[nativeAudio] closeStream error:', e.message)
    }
    closeAudioPort()
    return { ok: true }
  })

  ipcMain.handle('audio:set-monitor-gain', (_event, payload) => {
    const a = loadAddon()
    if (!a) return { ok: false, error: 'addon not loaded' }
    const gain = Number(payload?.gain)
    if (!Number.isFinite(gain)) return { ok: false, error: 'gain must be a finite number' }
    try {
      a.setMonitorGain(gain)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('audio:get-latency', () => {
    const a = loadAddon()
    if (!a) return { inputLatency: 0, outputLatency: 0, sampleRate: 0 }
    try {
      return a.getStreamLatency()
    } catch {
      return { inputLatency: 0, outputLatency: 0, sampleRate: 0 }
    }
  })

  ipcMain.handle('audio:is-stream-active', () => {
    const a = loadAddon()
    if (!a) return false
    try { return !!a.isStreamActive() } catch { return false }
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
