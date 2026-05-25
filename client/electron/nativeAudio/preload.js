// Renderer-side bridge for the native audio engine (ADR-001 §3.5).
// A3 scope:
//   - Control plane:  contextBridge → ipcRenderer.invoke('audio:*')
//   - Data plane:     MessagePort delivered via ipcRenderer.on('audio:port'),
//                     PCM frames fanned out to renderer handlers.
import { contextBridge, ipcRenderer } from 'electron'

let audioPort = null
const pcmHandlers = new Set()
const latencyHandlers = new Set()

ipcRenderer.on('audio:port', (event) => {
  if (audioPort) {
    try { audioPort.close() } catch { /* already closed */ }
    audioPort = null
  }
  audioPort = event.ports[0]
  if (!audioPort) return
  audioPort.onmessage = (ev) => {
    const msg = ev.data
    if (!msg || msg.kind !== 'pcm') return
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

  /** Subscribe to the latency report that ships with the first PCM frame after openStream. */
  onLatency: (handler) => {
    if (typeof handler !== 'function') return () => {}
    latencyHandlers.add(handler)
    return () => latencyHandlers.delete(handler)
  },
})
