// Renderer-side bridge for the native audio engine (ADR-001 §3.5).
// A2 scope: device enumeration only.
// Full data-plane (MessagePort, Opus packets) added in A3.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('nativeAudio', {
  /** Returns system audio devices from PortAudio.
   *  @returns {Promise<Array<{id, name, hostApis, inputChannels, outputChannels, defaultSampleRate}>>}
   */
  getDevices: () => ipcRenderer.invoke('audio:list-devices'),
})
