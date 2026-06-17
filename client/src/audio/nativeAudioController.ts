import { normalizeDeviceName } from './deviceUtils'
import { useInsertChainStore } from './insertChainStore'

// A2 — auto-select priority: best driver wins, user can override via Settings.
const HOST_API_PRIORITY: readonly string[] = ['ASIO', 'WASAPI_EXCLUSIVE', 'WASAPI', 'DirectSound', 'MME']

// §8.A.2: single source of truth for Opus options.
// 32 kbps is the sweet-spot for mono speech/instrument at this application's
// use-case; 96 kbps (previous) was 3-4× above Opus saturation point and
// inflated mesh traffic without perceptible quality gain.
const OPUS_OPTS = { bitrate: 32000, complexity: 5, frameMs: 20 } as const

function bestApiForDevice(device: NativeAudioDevice): string {
  for (const kind of HOST_API_PRIORITY) {
    if (device.hostApis.some((a) => a.kind === kind)) return kind
  }
  return device.hostApis[0]?.kind ?? ''
}

export interface NativeAudioSnapshot {
  streamActive: boolean
  devices: NativeAudioDevice[]
  selectedInputId: number | null
  selectedOutputId: number | null
  inputHostApiKind: string
  outputHostApiKind: string
  /** Requested sample rate (may differ from actualSampleRate on some drivers). */
  sampleRate: number
  /** §8.A.1: real SR reported by Pa_GetStreamInfo; null when no stream is active. */
  actualSampleRate: number | null
  bufferSize: 64 | 128 | 256 | 512
  inputChannels: number
  /** Maximum input channels the selected device supports (0 when no device selected). */
  maxInputChannels: number
  activeInputChannels: number
  /** Output channels of the active stream (0 = capture-only, softmix/peers inaudible). */
  activeOutputChannels: number
  inputChannelNames: string[]
  monitorGain: number
  inputLatencyMs: number | null
  outputLatencyMs: number | null
  error: string | null
}

type StateListener = (snap: NativeAudioSnapshot) => void

class NativeAudioController {
  private streamActive = false
  private devices: NativeAudioDevice[] = []
  private selectedInputId: number | null = null
  private selectedOutputId: number | null = null
  private inputHostApiKind = ''
  private outputHostApiKind = ''
  private sampleRate = 48000
  private actualSampleRate: number | null = null  // §8.A.1: from Pa_GetStreamInfo
  private bufferSize: 64 | 128 | 256 | 512 = 256
  private inputChannels = 2
  private activeInputChannels = 0
  private activeOutputChannels = 0
  private inputChannelNames: string[] = []
  private monitorGain = 0
  private channelLevels: number[] = []
  private pcmUnsub: (() => void) | null = null
  private inputLatencyMs: number | null = null
  private outputLatencyMs: number | null = null
  private error: string | null = null
  private listeners = new Set<StateListener>()

  constructor() {
    window.nativeAudio?.onEngineCrashed(() => {
      this.streamActive = false
      this.activeInputChannels = 0
      this.activeOutputChannels = 0
      this.inputChannelNames = []
      this.unsubscribePcm()
      this.inputLatencyMs = null
      this.outputLatencyMs = null
      this.actualSampleRate = null
      this.error = 'Audio engine crashed'
      this.notify()
    })
  }

  private subscribePcm(): void {
    if (!window.nativeAudio || this.pcmUnsub) return
    this.pcmUnsub = window.nativeAudio.onPcm((msg) => {
      const { frames, channels } = msg
      if (frames === 0 || channels === 0) return
      const samples = new Float32Array(msg.payload)
      const levels = new Array<number>(channels).fill(0)
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const s = samples[f * channels + c]
          levels[c] += s * s
        }
      }
      for (let c = 0; c < channels; c++) {
        levels[c] = Math.sqrt(levels[c] / frames)
      }
      this.channelLevels = levels
    })
  }

  private unsubscribePcm(): void {
    this.pcmUnsub?.()
    this.pcmUnsub = null
    this.channelLevels = []
  }

  getChannelLevel(channelIndex: number): number {
    return this.channelLevels[channelIndex] ?? 0
  }

  private buildChannelNames(count: number): string[] {
    // Use generic "Ch.N" labels — the full device name is local hardware info
    // and should not be broadcast to remote peers via sync:channel_meta.
    // (Remote peers see "BEHRINGER USB WDM AUDIO 2.8.40 Ch.1" which is confusing
    // and makes it look like their machine should have that device.)
    // ASIO per-channel names (Phase 5 MI3) will replace these labels when ready.
    return Array.from({ length: count }, (_, i) => `Ch.${i + 1}`)
  }

  private maxInputChannelsForCurrent(): number {
    const dev = this.devices.find((d) => d.id === this.selectedInputId)
    return dev?.inputChannels ?? 0
  }

  /**
   * Resolve the output device id + api kind for the stream's output side.
   *
   * The output side is ALWAYS opened (not only for monitoring): it plays the
   * native monitor signal, decoded remote-peer audio (A4b) and the Web Audio →
   * PortAudio softmix bridge (Tone.js master). Without it the stream is
   * capture-only and all of those are silently dropped.
   *
   * Priority:
   *   1. User-selected output device (selectedOutputId)
   *   2. The input device itself, if it also has output channels (ASIO duplex)
   *   3. An output device on the SAME host API as the input — Pa_OpenStream
   *      rejects cross-API duplex ("Illegal combination of I/O devices"), so
   *      auto-selection must never mix APIs. Prefer the same physical
   *      interface (matching normalized name), then list order.
   *
   * Returns null when no same-API output exists — capture-only is better
   * than a guaranteed-failing open.
   */
  private resolveOutput(): { id: number; apiKind: string } | null {
    // 1. Explicit user choice
    if (this.selectedOutputId !== null) {
      const dev = this.devices.find((d) => d.id === this.selectedOutputId)
      return { id: this.selectedOutputId, apiKind: this.outputHostApiKind || (dev ? bestApiForDevice(dev) : '') }
    }
    // 2. Input device is duplex (ASIO)
    const inputDev = this.devices.find((d) => d.id === this.selectedInputId)
    if (inputDev && inputDev.outputChannels > 0) {
      return { id: inputDev.id, apiKind: this.inputHostApiKind }
    }
    // 3. Same-API output, same physical device first
    const apiKind = this.inputHostApiKind || (inputDev ? bestApiForDevice(inputDev) : '')
    if (!apiKind) return null
    const candidates = this.devices.filter(
      (d) => d.outputChannels > 0 && d.hostApis.some((h) => h.kind === apiKind),
    )
    if (candidates.length === 0) return null
    const inputName = inputDev ? normalizeDeviceName(inputDev.name) : ''
    const samePhysical = inputName !== ''
      ? candidates.find((d) => normalizeDeviceName(d.name) === inputName)
      : undefined
    return { id: (samePhysical ?? candidates[0]).id, apiKind }
  }

  private notify(): void {
    const snap = this.getSnapshot()
    for (const l of this.listeners) l(snap)
  }

  getSnapshot(): NativeAudioSnapshot {
    return {
      streamActive: this.streamActive,
      devices: this.devices,
      selectedInputId: this.selectedInputId,
      selectedOutputId: this.selectedOutputId,
      inputHostApiKind: this.inputHostApiKind,
      outputHostApiKind: this.outputHostApiKind,
      sampleRate: this.sampleRate,
      actualSampleRate: this.actualSampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      maxInputChannels: this.maxInputChannelsForCurrent(),
      activeInputChannels: this.activeInputChannels,
      activeOutputChannels: this.activeOutputChannels,
      inputChannelNames: this.inputChannelNames,
      monitorGain: this.monitorGain,
      inputLatencyMs: this.inputLatencyMs,
      outputLatencyMs: this.outputLatencyMs,
      error: this.error,
    }
  }

  subscribeState(listener: StateListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => { this.listeners.delete(listener) }
  }

  selectInput(id: number, hostApiKind?: string): void {
    this.selectedInputId = id
    const dev = this.devices.find((d) => d.id === id)
    // A2: auto-select best API when caller doesn't specify one (manual override preserved).
    this.inputHostApiKind = hostApiKind ?? (dev ? bestApiForDevice(dev) : '')
    // Clamp channel count to device capability.
    if (dev && this.inputChannels > dev.inputChannels && dev.inputChannels > 0) {
      this.inputChannels = dev.inputChannels
    }
    this.notify()
  }

  selectOutput(id: number, hostApiKind?: string): void {
    this.selectedOutputId = id
    const dev = this.devices.find((d) => d.id === id)
    this.outputHostApiKind = hostApiKind ?? (dev ? bestApiForDevice(dev) : '')
    this.notify()
  }

  /** Reset output to "same as input" — resolveOutputForMonitor() handles auto-routing. */
  clearOutput(): void {
    this.selectedOutputId = null
    this.outputHostApiKind = ''
    this.notify()
  }

  /** A2: set number of input channels to capture (1 .. maxInputChannels of selected device). */
  setInputChannels(n: number): void {
    const max = this.maxInputChannelsForCurrent()
    this.inputChannels = max > 0 ? Math.max(1, Math.min(n, max)) : Math.max(1, n)
    this.notify()
  }

  setBufferSize(size: 64 | 128 | 256 | 512): void {
    this.bufferSize = size
    this.notify()
  }

  async loadDevices(): Promise<NativeAudioDevice[]> {
    if (!window.nativeAudio) return []
    // Never re-enumerate while a stream is active — some ASIO drivers crash when
    // Pa_GetDeviceCount() is called while a stream is open, which kills the
    // renderer (black screen). If devices were already loaded, just re-notify.
    if (this.streamActive && this.devices.length > 0) {
      this.notify()
      return this.devices
    }
    let list: NativeAudioDevice[]
    try {
      list = await window.nativeAudio.getDevices()
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to enumerate devices'
      this.notify()
      return this.devices
    }
    this.devices = list
    // A2: auto-select on first load if nothing is selected yet.
    if (this.selectedInputId === null) {
      // IMPORTANT: do NOT auto-select ASIO. ASIO requires the exact USB hardware
      // to be physically present and the driver initialised. Auto-selecting it on a
      // machine where the device is absent causes PortAudio to return
      // "Requested device not found" — confusing because the user never asked for it.
      // Priority: WASAPI → DirectSound → MME → ASIO (only as last resort).
      const AUTO_PRIORITY = ['WASAPI', 'WASAPI_EXCLUSIVE', 'DirectSound', 'MME', 'ASIO']
      const autoRank = (dev: NativeAudioDevice) => {
        for (let i = 0; i < AUTO_PRIORITY.length; i++) {
          if (dev.hostApis.some((a) => a.kind === AUTO_PRIORITY[i])) return i
        }
        return AUTO_PRIORITY.length
      }
      const inputDevs = list.filter((d) => d.inputChannels > 0)
      const inputDev = inputDevs.slice().sort((a, b) => autoRank(a) - autoRank(b))[0]
      if (inputDev) {
        this.selectedInputId = inputDev.id
        // Use the best non-ASIO API available for the selected device.
        this.inputHostApiKind = AUTO_PRIORITY
          .find((kind) => inputDev.hostApis.some((a) => a.kind === kind))
          ?? bestApiForDevice(inputDev)
        this.inputChannels = Math.min(this.inputChannels, inputDev.inputChannels || this.inputChannels)
      }
    }
    this.notify()
    return list
  }

  async openStream(): Promise<NativeAudioStreamResult> {
    if (!window.nativeAudio) return { ok: false, error: 'nativeAudio not available' }
    if (this.selectedInputId === null) return { ok: false, error: 'No input device selected' }

    // Output side is always opened — monitor, remote peers and the Web Audio
    // softmix bridge all play through it (see resolveOutput).
    const resolvedOut = this.resolveOutput()

    const opts: NativeAudioStreamOpts = {
      inputDeviceId: this.selectedInputId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: this.monitorGain > 0,
      monitorGain: this.monitorGain,
      opus: OPUS_OPTS,  // §8.A.2
    }
    if (resolvedOut) {
      opts.outputDeviceId = resolvedOut.id
      if (resolvedOut.apiKind) opts.outputHostApiKind = resolvedOut.apiKind
      opts.outputChannels = 2  // stereo — both ears
    }
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind

    let result = await window.nativeAudio.openStream(opts)
    if (!result.ok && resolvedOut && this.selectedOutputId === null) {
      // The auto-picked output made the duplex combination invalid (driver
      // refused the pair). Retry capture-only so recording still works; Tone.js
      // stays on the system-default sink (gated on activeOutputChannels).
      console.warn('[nativeAudio] duplex open failed, retrying capture-only:', result.error)
      delete opts.outputDeviceId
      delete opts.outputHostApiKind
      delete opts.outputChannels
      opts.monitor = false
      result = await window.nativeAudio.openStream(opts)
    }
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
      this.activeOutputChannels = result.outputChannels ?? 0
      this.inputChannelNames = this.buildChannelNames(this.activeInputChannels)
      this.subscribePcm()
      this.error = null
      if (result.inputLatency !== undefined) this.inputLatencyMs = Math.round(result.inputLatency * 1000)
      if (result.outputLatency !== undefined) this.outputLatencyMs = Math.round(result.outputLatency * 1000)
      // §8.A.1: save the SR actually negotiated by Pa_GetStreamInfo (may differ from requested).
      this.actualSampleRate = result.sampleRate ?? null
      // V10: re-push all per-channel VST chains after (re)open — native g_chanChain*
      // tables survive closeStream/openStream but are reset on utility process respawn.
      void useInsertChainStore.getState().resyncAllChains()
    } else {
      this.error = result.error ?? 'openStream failed'
      this.inputLatencyMs = null
      this.outputLatencyMs = null
      this.actualSampleRate = null
    }
    this.notify()
    return result
  }

  async closeStream(): Promise<void> {
    if (!window.nativeAudio) return
    await window.nativeAudio.closeStream()
    this.streamActive = false
    this.activeInputChannels = 0
    this.activeOutputChannels = 0
    this.inputChannelNames = []
    this.unsubscribePcm()
    this.inputLatencyMs = null
    this.outputLatencyMs = null
    this.actualSampleRate = null
    this.notify()
  }

  async reinit(partialOpts?: Partial<NativeAudioStreamOpts>): Promise<NativeAudioStreamResult> {
    if (!window.nativeAudio) return { ok: false, error: 'nativeAudio not available' }

    // Snapshot current settings so we can roll back on failure — mutations
    // happen before the async call and must not persist if reinit() rejects.
    const prevSampleRate = this.sampleRate
    const prevBufferSize = this.bufferSize
    const prevInputChannels = this.inputChannels
    const prevActiveInputChannels = this.activeInputChannels
    const prevActiveOutputChannels = this.activeOutputChannels
    const prevInputChannelNames = this.inputChannelNames
    const prevSelectedInputId = this.selectedInputId
    const prevSelectedOutputId = this.selectedOutputId
    const prevInputHostApiKind = this.inputHostApiKind
    const prevOutputHostApiKind = this.outputHostApiKind
    const prevMonitorGain = this.monitorGain

    if (partialOpts) {
      if (partialOpts.sampleRate !== undefined) this.sampleRate = partialOpts.sampleRate
      if (partialOpts.bufferSize !== undefined) this.bufferSize = partialOpts.bufferSize
      if (partialOpts.inputChannels !== undefined) this.inputChannels = partialOpts.inputChannels
      if (partialOpts.inputDeviceId !== undefined) this.selectedInputId = partialOpts.inputDeviceId
      if (partialOpts.outputDeviceId !== undefined) this.selectedOutputId = partialOpts.outputDeviceId
      if (partialOpts.inputHostApiKind !== undefined) this.inputHostApiKind = partialOpts.inputHostApiKind
      if (partialOpts.outputHostApiKind !== undefined) this.outputHostApiKind = partialOpts.outputHostApiKind
      if (partialOpts.monitorGain !== undefined) this.monitorGain = partialOpts.monitorGain
    }

    // Assign to a local const so TypeScript can narrow the null check below
    // (class properties are not narrowed after an if-check in strict mode).
    const inputDeviceId = this.selectedInputId
    if (inputDeviceId === null) return { ok: false, error: 'No input device selected' }

    // Same as openStream: output side is always opened.
    const resolvedOut = this.resolveOutput()

    const opts: NativeAudioStreamOpts = {
      inputDeviceId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: this.monitorGain > 0,
      monitorGain: this.monitorGain,
      opus: OPUS_OPTS,  // §8.A.2
    }
    if (resolvedOut) {
      opts.outputDeviceId = resolvedOut.id
      if (resolvedOut.apiKind) opts.outputHostApiKind = resolvedOut.apiKind
      opts.outputChannels = 2
    }
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind

    let result = await window.nativeAudio.reinit(opts)
    if (!result.ok && resolvedOut && this.selectedOutputId === null) {
      // Same capture-only fallback as openStream.
      console.warn('[nativeAudio] duplex reinit failed, retrying capture-only:', result.error)
      delete opts.outputDeviceId
      delete opts.outputHostApiKind
      delete opts.outputChannels
      opts.monitor = false
      result = await window.nativeAudio.reinit(opts)
    }
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
      this.activeOutputChannels = result.outputChannels ?? 0
      this.inputChannelNames = this.buildChannelNames(this.activeInputChannels)
      this.subscribePcm()
      this.error = null
      if (result.inputLatency !== undefined) this.inputLatencyMs = Math.round(result.inputLatency * 1000)
      if (result.outputLatency !== undefined) this.outputLatencyMs = Math.round(result.outputLatency * 1000)
      this.actualSampleRate = result.sampleRate ?? null  // §8.A.1
      // V10: re-push per-channel VST chains after device change / engine respawn.
      void useInsertChainStore.getState().resyncAllChains()
    } else {
      // Roll back all settings mutations so callers see a consistent state.
      this.sampleRate = prevSampleRate
      this.bufferSize = prevBufferSize
      this.inputChannels = prevInputChannels
      this.activeInputChannels = prevActiveInputChannels
      this.activeOutputChannels = prevActiveOutputChannels
      this.inputChannelNames = prevInputChannelNames
      this.selectedInputId = prevSelectedInputId
      this.selectedOutputId = prevSelectedOutputId
      this.inputHostApiKind = prevInputHostApiKind
      this.outputHostApiKind = prevOutputHostApiKind
      this.monitorGain = prevMonitorGain
      this.error = result.error ?? 'reinit failed'
      this.inputLatencyMs = null
      this.outputLatencyMs = null
      this.actualSampleRate = null
    }
    this.notify()
    return result
  }

  setMonitorGain(gain: number): void {
    this.monitorGain = gain
    if (this.streamActive && window.nativeAudio) {
      void window.nativeAudio.setMonitorGain(gain)
    }
    this.notify()
  }
}

export const nativeAudioController = new NativeAudioController()
