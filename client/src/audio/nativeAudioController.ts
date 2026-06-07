// A2 — auto-select priority: best driver wins, user can override via Settings.
const HOST_API_PRIORITY: readonly string[] = ['ASIO', 'WASAPI_EXCLUSIVE', 'WASAPI', 'DirectSound', 'MME']

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
  sampleRate: number
  bufferSize: 64 | 128 | 256 | 512
  inputChannels: number
  /** Maximum input channels the selected device supports (0 when no device selected). */
  maxInputChannels: number
  activeInputChannels: number
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
  private bufferSize: 64 | 128 | 256 | 512 = 256
  private inputChannels = 2
  private activeInputChannels = 0
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
      this.inputChannelNames = []
      this.unsubscribePcm()
      this.inputLatencyMs = null
      this.outputLatencyMs = null
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
    const device = this.devices.find((d) => d.id === this.selectedInputId)
    // A2: named channels — generic Ch.N labels; ASIO per-channel names require
    // driver introspection (Phase 5 MI3) and will replace these labels then.
    return Array.from({ length: count }, (_, i) =>
      device ? `${device.name} Ch.${i + 1}` : `Input ${i + 1}`
    )
  }

  private maxInputChannelsForCurrent(): number {
    const dev = this.devices.find((d) => d.id === this.selectedInputId)
    return dev?.inputChannels ?? 0
  }

  /**
   * Resolve the output device id + api kind to use for monitoring.
   *
   * Priority:
   *   1. User-selected output device (selectedOutputId)
   *   2. The input device itself, if it also has output channels (ASIO duplex)
   *   3. Any device with output channels, best API first
   *
   * Returns null when no output device is found (input-only hardware).
   */
  private resolveOutputForMonitor(): { id: number; apiKind: string } | null {
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
    // 3. Best available output device
    const outDev = this.devices
      .filter((d) => d.outputChannels > 0)
      .sort((a, b) => {
        const rank = (d: NativeAudioDevice) =>
          HOST_API_PRIORITY.findIndex((k) => d.hostApis.some((h) => h.kind === k))
        return rank(a) - rank(b)
      })[0]
    if (outDev) return { id: outDev.id, apiKind: bestApiForDevice(outDev) }
    return null
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
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      maxInputChannels: this.maxInputChannelsForCurrent(),
      activeInputChannels: this.activeInputChannels,
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
    const list = await window.nativeAudio.getDevices()
    this.devices = list
    // A2: auto-select on first load if nothing is selected yet.
    if (this.selectedInputId === null) {
      const inputDev = list.find((d) => d.inputChannels > 0)
      if (inputDev) {
        this.selectedInputId = inputDev.id
        this.inputHostApiKind = bestApiForDevice(inputDev)
        this.inputChannels = Math.min(this.inputChannels, inputDev.inputChannels || this.inputChannels)
      }
    }
    this.notify()
    return list
  }

  async openStream(): Promise<NativeAudioStreamResult> {
    if (!window.nativeAudio) return { ok: false, error: 'nativeAudio not available' }
    if (this.selectedInputId === null) return { ok: false, error: 'No input device selected' }

    const monitoring = this.monitorGain > 0
    const resolvedOut = monitoring ? this.resolveOutputForMonitor() : null

    const opts: NativeAudioStreamOpts = {
      inputDeviceId: this.selectedInputId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: monitoring,
      monitorGain: this.monitorGain,
      opus: { bitrate: 96000, complexity: 5, frameMs: 20 },
    }
    if (resolvedOut) {
      opts.outputDeviceId = resolvedOut.id
      if (resolvedOut.apiKind) opts.outputHostApiKind = resolvedOut.apiKind
      opts.outputChannels = 2  // stereo monitoring — both ears
    } else if (this.selectedOutputId !== null) {
      opts.outputDeviceId = this.selectedOutputId
      if (this.outputHostApiKind) opts.outputHostApiKind = this.outputHostApiKind
    }
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind

    const result = await window.nativeAudio.openStream(opts)
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
      this.inputChannelNames = this.buildChannelNames(this.activeInputChannels)
      this.subscribePcm()
      this.error = null
      if (result.inputLatency !== undefined) this.inputLatencyMs = Math.round(result.inputLatency * 1000)
      if (result.outputLatency !== undefined) this.outputLatencyMs = Math.round(result.outputLatency * 1000)
    } else {
      this.error = result.error ?? 'openStream failed'
      this.inputLatencyMs = null
      this.outputLatencyMs = null
    }
    this.notify()
    return result
  }

  async closeStream(): Promise<void> {
    if (!window.nativeAudio) return
    await window.nativeAudio.closeStream()
    this.streamActive = false
    this.activeInputChannels = 0
    this.inputChannelNames = []
    this.unsubscribePcm()
    this.inputLatencyMs = null
    this.outputLatencyMs = null
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

    const monitoring = this.monitorGain > 0
    const resolvedOut = monitoring ? this.resolveOutputForMonitor() : null

    const opts: NativeAudioStreamOpts = {
      inputDeviceId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: monitoring,
      monitorGain: this.monitorGain,
      opus: { bitrate: 96000, complexity: 5, frameMs: 20 },
    }
    if (resolvedOut) {
      opts.outputDeviceId = resolvedOut.id
      if (resolvedOut.apiKind) opts.outputHostApiKind = resolvedOut.apiKind
      opts.outputChannels = 2
    } else if (this.selectedOutputId !== null) {
      opts.outputDeviceId = this.selectedOutputId
      if (this.outputHostApiKind) opts.outputHostApiKind = this.outputHostApiKind
    }
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind

    const result = await window.nativeAudio.reinit(opts)
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
      this.inputChannelNames = this.buildChannelNames(this.activeInputChannels)
      this.subscribePcm()
      this.error = null
      if (result.inputLatency !== undefined) this.inputLatencyMs = Math.round(result.inputLatency * 1000)
      if (result.outputLatency !== undefined) this.outputLatencyMs = Math.round(result.outputLatency * 1000)
    } else {
      // Roll back all settings mutations so callers see a consistent state.
      this.sampleRate = prevSampleRate
      this.bufferSize = prevBufferSize
      this.inputChannels = prevInputChannels
      this.activeInputChannels = prevActiveInputChannels
      this.inputChannelNames = prevInputChannelNames
      this.selectedInputId = prevSelectedInputId
      this.selectedOutputId = prevSelectedOutputId
      this.inputHostApiKind = prevInputHostApiKind
      this.outputHostApiKind = prevOutputHostApiKind
      this.monitorGain = prevMonitorGain
      this.error = result.error ?? 'reinit failed'
      this.inputLatencyMs = null
      this.outputLatencyMs = null
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
