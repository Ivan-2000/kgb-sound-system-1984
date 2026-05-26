// Entry-point for the portaudio engine utilityProcess (A3.5c, ADR §3.2).
//
// Lives in a child utilityProcess.fork() so a PortAudio segfault, BSOD-prone
// ASIO driver bug, or RT-callback crash takes down THIS process — not the
// Electron main window. The renderer keeps its room, drum machine, chat, etc.
// main observes the exit and re-spawns lazily on the next request.
//
// Boundaries (mirror of ipc.js before A3.5c):
//   - Control plane:   process.parentPort  ←→  main's utility.postMessage
//                      Format: { kind:'request', id, op, opts }
//                              { kind:'reply',   id, payload }
//   - Data plane:      MessagePortMain transferred via the open-stream
//                      request's `ports[0]`. Utility holds port1, renderer
//                      holds port2 (main bridges the transfer).
//                      PCM frames flow utility → renderer DIRECTLY.

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// libwinpthread-1.dll is a MinGW runtime dep of the addon. The addon now
// loads HERE (utility process), so the PATH must be augmented before
// require() — not in main. Skip silently when MSYS2 isn't installed at
// the conventional path: lets developers with MSYS2 elsewhere supply PATH
// themselves without us failing loudly.
const MSYS2_BIN = 'C:\\msys64\\ucrt64\\bin'
if (process.platform === 'win32' && existsSync(MSYS2_BIN) && !process.env.PATH?.includes(MSYS2_BIN)) {
  process.env.PATH = `${MSYS2_BIN};${process.env.PATH ?? ''}`
}

let addon = null
function loadAddon() {
  if (addon) return addon
  addon = require('./portaudioAddon/index.js')
  return addon
}

// === Stream / data plane state ===
let audioDataPort = null      // MessagePortMain owned utility-side, port2 is in renderer
let pcmStreamId = 0
let firstChunkSent = false    // attach Pa_GetStreamInfo() latency to the FIRST PCM frame only
let paInitialized = false

function closeAudioPort() {
  if (audioDataPort) {
    try { audioDataPort.close() } catch { /* port may already be closed */ }
    audioDataPort = null
  }
  firstChunkSent = false
}

function ensurePaInitialized() {
  if (paInitialized) return
  loadAddon().paInit()
  paInitialized = true
}

// === parentPort reply helpers ===
function reply(id, payload) {
  if (id == null) return
  try { process.parentPort.postMessage({ kind: 'reply', id, payload }) } catch { /* parent gone */ }
}
function replyError(id, error) {
  reply(id, { ok: false, error: String(error?.message ?? error) })
}

// === openStream handler — shared by 'openStream' and 'reinit' ops ===
// Receives the freshly transferred port1 each time, so reinit always gets a
// new MessageChannelMain (renderer also gets a new port2 via main).
function doOpenStream(opts, port1) {
  const a = loadAddon()

  // Drop any prior stream / port (defensive — reinit relies on this).
  try { if (a.isStreamActive?.()) a.closeStream() } catch (e) {
    console.error('[utility] prior closeStream failed:', e.message)
  }
  closeAudioPort()

  const streamId = ++pcmStreamId
  audioDataPort = port1
  audioDataPort.start()

  // Tear down PA stream when the renderer-side port closes (window reload,
  // BrowserWindow destroyed, devtools-only crash). Without this, the audio
  // thread keeps burning CPU while every postMessage throws.
  // (Moved here from ipc.js per A3.5c — was the 33a6bb1 fix #2.)
  // Fallback: if Electron doesn't propagate 'close' to the utility side of
  // a transferred port, the TSFN callback's postMessage try/catch below
  // will close the port and the next renderer reinit will re-open cleanly.
  audioDataPort.on('close', () => {
    if (audioDataPort !== port1) return
    audioDataPort = null
    firstChunkSent = false
    try { a.closeStream() } catch (e) {
      console.error('[utility] closeStream after port disconnect failed:', e.message)
    }
  })

  // A4: opus opts — only pass onOpus callback when opts.opus is present.
  const hasOpus = opts.opus && typeof opts.opus === 'object'

  const addonOpts = {
    inputDeviceId:     opts.inputDeviceId,
    outputDeviceId:    opts.outputDeviceId,
    inputHostApiKind:  opts.inputHostApiKind,
    outputHostApiKind: opts.outputHostApiKind,
    deviceId:          opts.deviceId,
    hostApiKind:       opts.hostApiKind ?? 'WASAPI_SHARED',
    sampleRate:        opts.sampleRate  ?? 48000,
    bufferSize:        opts.bufferSize  ?? 256,
    inputChannels:     opts.inputChannels ?? 2,
    outputChannels:    opts.outputChannels,
    monitor:           opts.monitor,
    monitorGain:       opts.monitorGain,
    // A3.5c smoke test: opts.crashMe === true makes addon.cc abort()
    // immediately so we can verify the utility crash is isolated from
    // the Electron main window. Never set in production code paths.
    crashMe:           opts.crashMe,
    opus:              hasOpus ? opts.opus : undefined,
  }

  // TSFN → JS thread of THIS utility process. Forward PCM frames to the
  // renderer through MessageChannelMain. ArrayBuffer rides as a normal
  // structured-clone copy because MessagePortMain only accepts other
  // MessagePortMain[] in its transfer list (Electron limitation; see
  // ipc.js history before A3.5c, and commit 17b1299).
  const onPcm = (arrayBuffer, frames, channels) => {
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
      try { message.latency = a.getStreamLatency() } catch { /* best-effort metadata */ }
    }
    try {
      audioDataPort.postMessage(message)
    } catch {
      // Renderer-side port closed mid-stream; stop pumping.
      closeAudioPort()
    }
  }

  // A4: Opus packet callback — forward kind:'opus-out' to renderer.
  // BigInt (timestampUs) is passed as a JS BigInt through the TSFN lambda
  // and survives structured-clone over MessagePortMain unchanged.
  const onOpus = hasOpus
    ? (payload, channelIndex, sequence, timestampUs) => {
        if (!audioDataPort) return
        try {
          audioDataPort.postMessage({
            kind: 'opus-out',
            channelIndex,
            sequence,
            timestampUs,
            payload,
          })
        } catch {
          closeAudioPort()
        }
      }
    : undefined

  let result
  try {
    result = hasOpus
      ? a.openStream(addonOpts, onPcm, onOpus)
      : a.openStream(addonOpts, onPcm)
  } catch (e) {
    closeAudioPort()
    return { ok: false, error: e.message }
  }

  return { ok: true, streamId, ...result }
}

// === parentPort dispatcher ===
process.parentPort.on('message', (event) => {
  const msg = event?.data
  if (!msg || msg.kind !== 'request') return
  const { id, op, opts } = msg

  try {
    switch (op) {
      case 'listDevices': {
        ensurePaInitialized()
        reply(id, loadAddon().getDevices())
        return
      }

      case 'openStream':
      case 'reinit': {
        ensurePaInitialized()
        const port1 = event.ports?.[0]
        if (!port1) {
          replyError(id, `${op}: missing MessagePort in transfer list`)
          return
        }
        reply(id, doOpenStream(opts ?? {}, port1))
        return
      }

      case 'closeStream': {
        const a = loadAddon()
        try { a.closeStream() } catch (e) {
          console.error('[utility] closeStream error:', e.message)
        }
        closeAudioPort()
        reply(id, { ok: true })
        return
      }

      case 'setMonitorGain': {
        const a = loadAddon()
        const gain = Number(opts?.gain)
        if (!Number.isFinite(gain)) { replyError(id, 'gain must be a finite number'); return }
        try { a.setMonitorGain(gain); reply(id, { ok: true }) }
        catch (e) { replyError(id, e) }
        return
      }

      case 'getLatency': {
        try { reply(id, loadAddon().getStreamLatency()) }
        catch { reply(id, { inputLatency: 0, outputLatency: 0, sampleRate: 0 }) }
        return
      }

      case 'isStreamActive': {
        try { reply(id, !!loadAddon().isStreamActive()) } catch { reply(id, false) }
        return
      }

      // A4.5: stats snapshot — xrunCount, dropCount, bufferFillPct, cpuLoad.
      case 'getStats': {
        try { reply(id, loadAddon().getStats()) }
        catch { reply(id, { xrunCount: 0, dropCount: 0, bufferFillPct: 0, cpuLoad: 0 }) }
        return
      }

      case 'shutdown': {
        // Graceful drain. closeStream is idempotent — call unconditionally
        // (33a6bb1 fix #5: a paused-but-open stream leaks driver handles
        // on Pa_Terminate, so don't gate on isStreamActive).
        try { loadAddon().closeStream?.() } catch { /* ignore */ }
        closeAudioPort()
        if (paInitialized) {
          try { loadAddon().paTerminate() } catch (e) {
            console.error('[utility] Pa_Terminate failed:', e.message)
          }
          paInitialized = false
        }
        reply(id, { ok: true })
        // Exit on the next tick so the reply flushes to the parent first.
        setImmediate(() => process.exit(0))
        return
      }

      default:
        replyError(id, `unknown op: ${op}`)
    }
  } catch (e) {
    replyError(id, e)
  }
})

// Eager PortAudio init at startup — mirrors the previous main-side
// `initAudio()` behaviour. If it throws (e.g. no audio subsystem), subsequent
// ops will surface "PortAudio not initialized" errors from the addon — the
// utility stays alive so the renderer can still call listDevices etc. for
// diagnostics.
try {
  ensurePaInitialized()
  console.log('[utility] PortAudio initialized')
} catch (e) {
  console.error('[utility] Pa_Initialize failed:', e.message)
}
