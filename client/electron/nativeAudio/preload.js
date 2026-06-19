// Renderer-side bridge for the native audio engine (ADR-001 §3.5).
// A3 scope:
//   - Control plane:  contextBridge → ipcRenderer.invoke('audio:*')
//   - Data plane:     MessagePort delivered via ipcRenderer.on('audio:port'),
//                     PCM frames fanned out to renderer handlers.
import { contextBridge, ipcRenderer } from 'electron'

let audioPort = null
let softmixSent = 0
let softmixFailed = 0
const pcmHandlers = new Set()
const opusHandlers = new Set()      // A4: kind:'opus-out' packets from encoder
const latencyHandlers = new Set()
const engineCrashHandlers = new Set()

// A3.5c: main broadcasts this when the audio utilityProcess exits abnormally.
// Renderer learns the engine is gone without taking the window down with it.
ipcRenderer.on('audio:engine-crashed', (_event, payload) => {
  engineCrashHandlers.forEach((h) => {
    try { h(payload) } catch (err) { console.error('[nativeAudio] engine-crashed handler:', err) }
  })
})

ipcRenderer.on('audio:port', (event) => {
  if (audioPort) {
    try { audioPort.close() } catch { /* already closed */ }
    audioPort = null
  }
  audioPort = event.ports[0]
  if (!audioPort) return
  audioPort.onmessage = (ev) => {
    const msg = ev.data
    if (!msg) return

    if (msg.kind === 'opus-out') {
      // A4: Opus packet from encoder — fan out to onOpusPacket subscribers.
      opusHandlers.forEach((h) => {
        try { h(msg) } catch (err) { console.error('[nativeAudio] opus handler:', err) }
      })
      return
    }

    if (msg.kind !== 'pcm') return
    if (msg.latency) {
      latencyHandlers.forEach((h) => {
        try { h(msg.latency) } catch (err) { console.error('[nativeAudio] latency handler:', err) }
      })
    }
    pcmHandlers.forEach((h) => {
      try { h(msg) } catch (err) { console.error('[nativeAudio] pcm handler:', err) }
    })
  }
  audioPort.start()
})

contextBridge.exposeInMainWorld('nativeAudio', {
  /** Enumerate audio devices via PortAudio. */
  getDevices: () => ipcRenderer.invoke('audio:list-devices'),

  /** Open a capture+monitor stream.
   *
   *  New API — Windows split-device (A3.5b): WASAPI/DirectSound/WDM-KS expose
   *  input and output of the same physical device as separate PortAudio indices.
   *  Pass inputDeviceId + outputDeviceId to open a true duplex stream across them.
   *  Omit outputDeviceId for capture-only (no native monitoring output).
   *
   *  Back-compat: pass deviceId alone (covers both sides — existing behaviour).
   *
   *  @param {{
   *    inputDeviceId?:    number,
   *    outputDeviceId?:   number,
   *    inputHostApiKind?: 'WASAPI_SHARED'|'WASAPI_EXCLUSIVE'|'ASIO'|'DirectSound'|'MME'|'CoreAudio'|'ALSA'|'JACK',
   *    outputHostApiKind?: 'WASAPI_SHARED'|'WASAPI_EXCLUSIVE'|'ASIO'|'DirectSound'|'MME'|'CoreAudio'|'ALSA'|'JACK',
   *    deviceId?:         number,
   *    hostApiKind?:      string,
   *    sampleRate?:       number,
   *    bufferSize?:       64|128|256|512,
   *    inputChannels?:    number,
   *    outputChannels?:   number,
   *  }} opts
   *  @returns {Promise<{ok:boolean, streamId?:number, inputLatency?:number, outputLatency?:number, sampleRate?:number, inputChannels?:number, outputChannels?:number, bufferSize?:number, error?:string}>}
   */
  openStream: (opts) => ipcRenderer.invoke('audio:open-stream', opts),

  /** Close the active stream (idempotent). */
  closeStream: () => ipcRenderer.invoke('audio:close-stream'),

  /** Close and reopen with new parameters in one round-trip (device/buffer change).
   *  Accepts the same opts as openStream.
   */
  reinit: (opts) => ipcRenderer.invoke('audio:reinit', opts),

  /** Native monitor gain. 0 = off, 1 = unity. Linear amplitude, capped at 4 (+12 dB). */
  setMonitorGain: (gain) => ipcRenderer.invoke('audio:set-monitor-gain', { gain }),

  /** Pa_GetStreamInfo() snapshot — inputLatency/outputLatency in seconds. */
  getLatency: () => ipcRenderer.invoke('audio:get-latency'),

  isStreamActive: () => ipcRenderer.invoke('audio:is-stream-active'),

  /** Subscribe to PCM frames. Handler receives { kind:'pcm', streamId, frames, channels, payload:ArrayBuffer, latency? }.
   *  @returns {() => void} unsubscribe
   */
  onPcm: (handler) => {
    if (typeof handler !== 'function') return () => {}
    pcmHandlers.add(handler)
    return () => pcmHandlers.delete(handler)
  },

  /** A4: Subscribe to Opus output packets from the local encoder.
   *  Handler receives { kind:'opus-out', channelIndex, sequence, timestampUs: BigInt, payload: ArrayBuffer }.
   *  Renderer's rtc/ layer forwards these into a WebRTC DataChannel (A5).
   *  @returns {() => void} unsubscribe
   */
  onOpusPacket: (handler) => {
    if (typeof handler !== 'function') return () => {}
    opusHandlers.add(handler)
    return () => opusHandlers.delete(handler)
  },

  /** A4b: Push an inbound Opus packet (received from a remote peer's DataChannel)
   *  to the native decoder in the utility process.
   *  packet: { peerId: string, channelId: string, sequence: number,
   *            timestampUs: BigInt, payload: ArrayBuffer }
   *  Fast path: sends kind:'opus-in' directly over the audio MessagePort to avoid
   *  the main-process serialisation hop.  Falls back to ipcRenderer.invoke when
   *  the port is not yet established.
   *  @returns {true|false|Promise<{ok:boolean}>}
   */
  pushInboundOpus: (packet) => {
    if (!packet || !packet.payload) return false
    if (audioPort) {
      try {
        // kind must come AFTER the spread: if packet carries kind:'opus-out'
        // (loopback path) the spread would overwrite 'opus-in' otherwise.
        audioPort.postMessage({ ...packet, kind: 'opus-in' })
        return true
      } catch { /* port closed — fall through to IPC */ }
    }
    return ipcRenderer.invoke('audio:push-inbound-opus', packet)
  },

  /** A4.5: Snapshot of audio stream health metrics.
   *  @returns {Promise<{ xrunCount: number, dropCount: number, bufferFillPct: number, cpuLoad: number }>}
   */
  getStats: () => ipcRenderer.invoke('audio:get-stats'),

  /** Subscribe to the latency report that ships with the first PCM frame after openStream. */
  onLatency: (handler) => {
    if (typeof handler !== 'function') return () => {}
    latencyHandlers.add(handler)
    return () => latencyHandlers.delete(handler)
  },

  /** Subscribe to abnormal audio-engine termination (A3.5c utilityProcess crash).
   *  Handler receives { code: number }. UI is free to surface this and call
   *  reinit() to respawn the engine — main does not auto-restart to avoid loops.
   *  @returns {() => void} unsubscribe
   */
  onEngineCrashed: (handler) => {
    if (typeof handler !== 'function') return () => {}
    engineCrashHandlers.add(handler)
    return () => engineCrashHandlers.delete(handler)
  },

  /** M4: Set per-channel output gain for a remote peer.
   *  Mute: pass gain=0. Unmute: pass the saved gain value.
   *  gain is clamped to [0, 4] in the addon (0 = muted, 1 = unity).
   */
  setRemoteChannelGain: (peerId, channelId, gain) =>
    ipcRenderer.invoke('audio:set-remote-channel-gain', { peerId, channelId, gain }),

  /** Web Audio → PortAudio bridge (softmix).
   *  Called by the AudioWorklet message handler with a mono Float32Array buffer
   *  (stereo-summed master bus PCM) captured from Tone.js output.
   *  Sends samples to the utility process which writes them into the PortAudio
   *  output ring buffer so they play through the user's selected output device.
   *  @param {ArrayBuffer} samples  Mono float32 PCM, transferred (zero-copy).
   *  @returns {boolean}  true if sent, false if port not yet open.
   */
  pushSoftmix: (samples) => {
    if (audioPort) {
      try {
        // NO transfer list — the renderer↔utility MessagePort bridge silently
        // drops messages with ArrayBuffer transferables (same Electron
        // limitation as utility→renderer, see utilityHost onPcm comment).
        // Structured-clone copy of 512 bytes per quantum is negligible.
        audioPort.postMessage({ kind: 'softmix-in', payload: samples })
        softmixSent++
        return true
      } catch { softmixFailed++ }
    } else {
      softmixFailed++
    }
    return false
  },

  /** Diagnostics: how many softmix buffers actually left the renderer
   *  (posted into the audio MessagePort) vs failed (port missing/closed). */
  getSoftmixDiag: () => ({ sent: softmixSent, failed: softmixFailed }),
})

// Debug-only, separate global from nativeAudio on purpose: this is consumed
// only by client/src/debug/collectors/procs.ts, which treats its absence as
// "shim not applied" rather than an error. See client/src/debug/README.md.
contextBridge.exposeInMainWorld('kgbDebug', {
  getProcessMetrics: () => ipcRenderer.invoke('debug:get-process-metrics'),
})
