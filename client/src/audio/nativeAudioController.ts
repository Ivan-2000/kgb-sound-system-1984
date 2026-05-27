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
  activeInputChannels: number
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
  private monitorGain = 0
  private inputLatencyMs: number | null = null
  private outputLatencyMs: number | null = null
  private error: string | null = null
  private listeners = new Set<StateListener>()

  constructor() {
    window.nativeAudio?.onEngineCrashed(() => {
      this.streamActive = false
      this.activeInputChannels = 0
      this.inputLatencyMs = null
      this.outputLatencyMs = null
      this.error = 'Audio engine crashed'
      this.notify()
    })
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
      activeInputChannels: this.activeInputChannels,
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
    if (hostApiKind !== undefined) this.inputHostApiKind = hostApiKind
    this.notify()
  }

  selectOutput(id: number, hostApiKind?: string): void {
    this.selectedOutputId = id
    if (hostApiKind !== undefined) this.outputHostApiKind = hostApiKind
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
    this.notify()
    return list
  }

  async openStream(): Promise<NativeAudioStreamResult> {
    if (!window.nativeAudio) return { ok: false, error: 'nativeAudio not available' }
    if (this.selectedInputId === null) return { ok: false, error: 'No input device selected' }

    const opts: NativeAudioStreamOpts = {
      inputDeviceId: this.selectedInputId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: this.monitorGain > 0,
      monitorGain: this.monitorGain,
      opus: { bitrate: 96000, complexity: 5, frameMs: 20 },
    }
    if (this.selectedOutputId !== null) opts.outputDeviceId = this.selectedOutputId
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind
    if (this.outputHostApiKind) opts.outputHostApiKind = this.outputHostApiKind

    const result = await window.nativeAudio.openStream(opts)
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
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

    const opts: NativeAudioStreamOpts = {
      inputDeviceId,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputChannels: this.inputChannels,
      monitor: this.monitorGain > 0,
      monitorGain: this.monitorGain,
      opus: { bitrate: 96000, complexity: 5, frameMs: 20 },
    }
    if (this.selectedOutputId !== null) opts.outputDeviceId = this.selectedOutputId
    if (this.inputHostApiKind) opts.inputHostApiKind = this.inputHostApiKind
    if (this.outputHostApiKind) opts.outputHostApiKind = this.outputHostApiKind

    const result = await window.nativeAudio.reinit(opts)
    if (result.ok) {
      this.streamActive = true
      this.activeInputChannels = result.inputChannels ?? this.inputChannels
      this.error = null
      if (result.inputLatency !== undefined) this.inputLatencyMs = Math.round(result.inputLatency * 1000)
      if (result.outputLatency !== undefined) this.outputLatencyMs = Math.round(result.outputLatency * 1000)
    } else {
      // Roll back all settings mutations so callers see a consistent state.
      this.sampleRate = prevSampleRate
      this.bufferSize = prevBufferSize
      this.inputChannels = prevInputChannels
      this.activeInputChannels = prevActiveInputChannels
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
