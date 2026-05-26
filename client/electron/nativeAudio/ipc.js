// Main-process proxy to the audio engine utilityProcess (A3.5c, ADR §3.2).
//
// Before A3.5c: this file loaded the addon directly via require() and any
// PortAudio crash took down the whole Electron window with it. Now the
// addon lives in a child utilityProcess (see utilityHost.mjs); main just:
//   - lifecycle:     spawns utility on initAudio(), graceful shutdown on
//                    terminateAudio() with a kill-fallback.
//   - control plane: each ipcMain.handle('audio:*') forwards a
//                    { kind:'request', id, op, opts } message to utility
//                    and resolves on a matching kind:'reply'.
//   - data plane:    on open-stream/reinit, main mints a MessageChannelMain,
//                    transfers port1 → utility (TSFN endpoint) and port2 →
//                    renderer (preload listens for 'audio:port'). PCM frames
//                    flow utility → renderer directly; main never sees them.
//   - crash watch:   utility.on('exit', code) — if code !== 0, broadcast
//                    'audio:engine-crashed' to all windows and reject all
//                    pending requests. No auto-restart (renderer triggers
//                    reinit explicitly to avoid crash loops).

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, MessageChannelMain, ipcMain, utilityProcess } from 'electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UTILITY_ENTRY = join(__dirname, 'utilityHost.mjs')

let utility = null
let reqId = 0
const pending = new Map()  // id → { resolve, reject }

function spawnUtility() {
  if (utility) return utility

  const u = utilityProcess.fork(UTILITY_ENTRY, [], {
    serviceName: 'kgb-audio-engine',
    stdio: 'inherit',
  })
  utility = u

  u.on('message', (msg) => {
    if (!msg || msg.kind !== 'reply') return
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    slot.resolve(msg.payload)
  })

  // utility crashed (or shutdown — distinguished by exit code).
  // - reject all pending requests so callers don't hang forever;
  // - notify every renderer so UI can show «audio engine crashed»;
  // - leave `utility = null` so the next sendRequest() will lazily respawn.
  u.on('exit', (code) => {
    if (utility !== u) return  // stale handler from a previous instance
    const graceful = code === 0
    console[graceful ? 'log' : 'error'](`[nativeAudio] utility exited code=${code}`)
    utility = null

    for (const [, slot] of pending) {
      slot.reject(new Error('engine crashed'))
    }
    pending.clear()

    if (!graceful) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try { win.webContents.send('audio:engine-crashed', { code }) } catch { /* ignore */ }
      }
    }
  })

  return u
}

function sendRequest(op, opts, transfer) {
  const u = spawnUtility()
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      const message = { kind: 'request', id, op, opts }
      if (transfer && transfer.length > 0) {
        u.postMessage(message, transfer)
      } else {
        u.postMessage(message)
      }
    } catch (e) {
      pending.delete(id)
      reject(e)
    }
  })
}

// initAudio() — called once at app startup (deferred past Electron COM
// setup, see main.js setImmediate block). Spawns the utility; PortAudio
// initializes inside it. Sync signature retained for back-compat.
export function initAudio() {
  spawnUtility()
}

// terminateAudio() — called from app.before-quit. Sends a graceful
// shutdown message and waits up to 1.5 s for the utility to exit before
// killing it. Async; main.js awaits via event.preventDefault().
export async function terminateAudio() {
  const u = utility
  if (!u) return

  const exited = new Promise((resolve) => u.once('exit', resolve))
  try {
    u.postMessage({ kind: 'request', id: ++reqId, op: 'shutdown' })
  } catch (e) {
    console.error('[nativeAudio] shutdown postMessage failed:', e.message)
  }

  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])

  if (utility === u) {
    try { u.kill() } catch { /* already dead */ }
    utility = null
  }
}

// === Control plane proxies ===
// Each ipcMain.handle forwards to utility and returns its reply unchanged.
// Renderer-facing payload/response shapes are IDENTICAL to pre-A3.5c.
export function setupAudioIPC() {
  ipcMain.handle('audio:list-devices', async () => {
    try { return await sendRequest('listDevices') }
    catch (e) {
      console.error('[nativeAudio] list-devices:', e.message)
      return []
    }
  })

  ipcMain.handle('audio:open-stream',  (event, opts) => proxyOpenStream(event, 'openStream', opts))
  ipcMain.handle('audio:reinit',       (event, opts) => proxyOpenStream(event, 'reinit',     opts))

  ipcMain.handle('audio:close-stream', async () => {
    try { return await sendRequest('closeStream') }
    // engine crashed mid-close is equivalent to "closed" from caller's POV.
    catch { return { ok: true } }
  })

  ipcMain.handle('audio:set-monitor-gain', async (_event, payload) => {
    const gain = Number(payload?.gain)
    if (!Number.isFinite(gain)) return { ok: false, error: 'gain must be a finite number' }
    try { return await sendRequest('setMonitorGain', { gain }) }
    catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('audio:get-latency', async () => {
    try { return await sendRequest('getLatency') }
    catch { return { inputLatency: 0, outputLatency: 0, sampleRate: 0 } }
  })

  ipcMain.handle('audio:is-stream-active', async () => {
    try { return await sendRequest('isStreamActive') }
    catch { return false }
  })
}

// open-stream & reinit share the channel-minting logic.
async function proxyOpenStream(event, op, opts) {
  // Mint a fresh MessageChannelMain per call. port1 is transferred to the
  // utility (TSFN endpoint), port2 is delivered to the renderer via the
  // 'audio:port' channel that preload.js subscribes to.
  const { port1, port2 } = new MessageChannelMain()

  let result
  try {
    result = await sendRequest(op, opts ?? {}, [port1])
  } catch (e) {
    try { port2.close() } catch { /* ignore */ }
    // port1 was transferred; it's gone with the utility on crash.
    return { ok: false, error: e.message }
  }

  if (!result?.ok) {
    try { port2.close() } catch { /* ignore */ }
    return result
  }

  try {
    event.sender.postMessage('audio:port', { streamId: result.streamId }, [port2])
  } catch (e) {
    // Cannot hand port2 to renderer — close the stream so the utility's
    // PA handle doesn't leak. Fire-and-forget; we already failed the call.
    sendRequest('closeStream').catch(() => {})
    return { ok: false, error: 'postMessage failed: ' + e.message }
  }

  return result
}

// Used by main.js for startup-time visibility. Fire-and-forget — utility
// may not be ready yet, postMessage queues until it is.
export async function logDevicesAtStartup() {
  let devices
  try { devices = await sendRequest('listDevices') }
  catch (e) {
    console.error('[nativeAudio] Error enumerating devices:', e.message)
    return
  }
  if (!Array.isArray(devices)) return

  console.log(`[nativeAudio] ${devices.length} audio device(s) found:`)
  for (const dev of devices) {
    const apis = dev.hostApis.map((h) => h.kind).join(', ')
    const ch = `in:${dev.inputChannels} out:${dev.outputChannels}`
    console.log(`  [${dev.id}] ${dev.name}  ${ch}  [${apis}]`)
  }
}
