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
  // §4.7: close the stale MessagePort — its utility-side counterpart is dead.
  // Without this, pushInboundOpus() would keep posting to a dead port, and
  // streamActive=true could remain set if the openStream reply arrived just
  // before the crash (the stale-port race described in AUDIT §4.7).
  if (audioPort) {
    try { audioPort.close() } catch { /* ignore */ }
    audioPort = null
  }
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

  // ── VST3 host (V2/V3). Available only with the build:vst addon; with the
  //    default build these resolve to { ok:false, error:'VST host not built' }.
  //    Contract surface agreed with nik (AGENTS.md): scanVst3 / loadPlugin /
  //    unloadPlugin / setParam / getParam / setInsertChain. openEditor (V4) and
  //    getPluginState (V9) land in E2.
  vst: {
    /** Enumerate plugin classes under `paths` (or OS default paths if omitted).
     *  @returns {Promise<{ok:boolean, plugins?:Array<{name,vendor,version,type:'effect'|'instrument',subCategories,uid,path}>, error?:string}>} */
    scan: (paths) => ipcRenderer.invoke('vst:scan', { paths }),

    /** OS default VST3 search paths. @returns {Promise<{ok:boolean, paths?:string[], error?:string}>} */
    defaultPaths: () => ipcRenderer.invoke('vst:default-paths'),

    /** Load a plugin into a runtime slot and set up realtime processing.
     *  @param {{path:string, classUid?:string, sampleRate?:number, maxBlockSize?:number, slotId?:number}} opts
     *  @returns {Promise<{ok:boolean, slotId:number, name:string, vendor:string, type:string, uid:string, numInputChannels:number, numOutputChannels:number, params:Array<{id:number,title:string,units:string,defaultNormalized:number,stepCount:number,flags:number}>, error?:string}>} */
    load: (opts) => ipcRenderer.invoke('vst:load', opts),

    /** Unload the plugin in `slotId`. @returns {Promise<{ok:boolean, error?:string}>} */
    unload: (slotId) => ipcRenderer.invoke('vst:unload', { slotId }),

    /** Set a normalized [0,1] parameter value. @returns {Promise<{ok:boolean, error?:string}>} */
    setParam: (slotId, paramId, value) => ipcRenderer.invoke('vst:set-param', { slotId, paramId, value }),

    /** Read a normalized [0,1] parameter value. @returns {Promise<{ok:boolean, value?:number, error?:string}>} */
    getParam: (slotId, paramId) => ipcRenderer.invoke('vst:get-param', { slotId, paramId }),

    /** Set the ordered input-side insert chain (array of loaded slot ids; [] clears).
     *  @returns {Promise<{ok:boolean, error?:string}>} */
    setInsertChain: (slotIds) => ipcRenderer.invoke('vst:set-insert-chain', { slotIds }),

    /** V4: open the plugin's own editor in a native OS window. Resolves
     *  { ok:false } for a headless plugin (no editor view).
     *  @returns {Promise<{ok:boolean, error?:string}>} */
    openEditor: (slotId) => ipcRenderer.invoke('vst:open-editor', { slotId }),

    /** V4: close the plugin editor window. @returns {Promise<{ok:boolean, error?:string}>} */
    closeEditor: (slotId) => ipcRenderer.invoke('vst:close-editor', { slotId }),

    /** V6: set the insert chain for a single physical input channel.
     *  Empty slotIds clears the chain. Persists across stream restarts (V10).
     *  @returns {Promise<{ok:boolean, error?:string}>} */
    setChannelChain: (channelIdx, slotIds) =>
      ipcRenderer.invoke('vst:set-channel-chain', { channelIdx, slotIds }),

    /** V9: get the binary preset state of a loaded plugin.
     *  @returns {Promise<{ok:boolean, data?:ArrayBuffer, error?:string}>} */
    getState: (slotId) => ipcRenderer.invoke('vst:get-state', { slotId }),

    /** V9: restore a plugin from a previously saved binary preset.
     *  @returns {Promise<{ok:boolean, error?:string}>} */
    setState: (slotId, data) => ipcRenderer.invoke('vst:set-state', { slotId, data }),
  },
})
