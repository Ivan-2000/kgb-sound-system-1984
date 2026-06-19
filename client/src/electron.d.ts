interface NativeAudioDevice {
  id: number
  name: string
  hostApis: Array<{ kind: string; name: string }>
  inputChannels: number
  outputChannels: number
  defaultSampleRate: number
}

/** Priority order for automatic Host API selection (best → worst). */
type HostApiKind = 'ASIO' | 'WASAPI_EXCLUSIVE' | 'WASAPI' | 'DirectSound' | 'MME'

interface NativeAudioStreamResult {
  ok: boolean
  streamId?: number
  inputLatency?: number
  outputLatency?: number
  sampleRate?: number
  inputChannels?: number
  outputChannels?: number
  bufferSize?: number
  error?: string
}

interface OpusOutMessage {
  kind: 'opus-out'
  channelIndex: number
  sequence: number
  timestampUs: bigint
  payload: ArrayBuffer
}

interface InboundOpusPacket {
  peerId: string
  channelId: string
  sequence: number
  timestampUs: bigint
  payload: ArrayBuffer
}

interface NativeAudioStreamOpts {
  inputDeviceId?: number
  outputDeviceId?: number
  inputHostApiKind?: string
  outputHostApiKind?: string
  deviceId?: number
  hostApiKind?: string
  sampleRate?: number
  bufferSize?: 64 | 128 | 256 | 512
  inputChannels?: number
  outputChannels?: number
  monitor?: boolean
  monitorGain?: number
  opus?: { bitrate?: number; complexity?: number; frameMs?: 10 | 20 }
}

interface NativeAudioLatency {
  inputLatency: number
  outputLatency: number
  sampleRate: number
}

interface NativeAudioStats {
  xrunCount: number
  dropCount: number
  bufferFillPct: number
  cpuLoad: number
  /** M5: per-channel RMS levels keyed by peerId. Index = channelIdx. */
  remoteChannelLevels?: Record<string, number[]>
  /** Softmix messages received by the utility process since launch. */
  softmixReceived?: number
  /** Max |sample| in received softmix PCM since the previous getStats (read-and-reset). */
  softmixPeak?: number
}

// ── VST3 host (V2/V3) ─────────────────────────────────────────────────────
type VstPluginType = 'effect' | 'instrument' | 'other'

/** A plugin class discovered by a scan. */
interface VstPluginInfo {
  name: string
  vendor: string
  version: string
  type: VstPluginType
  subCategories: string
  uid: string
  path: string
}

/** One automatable parameter of a loaded plugin. */
interface VstParamDesc {
  id: number
  title: string
  units: string
  defaultNormalized: number
  stepCount: number
  flags: number
}

/** Result of loading a plugin into a runtime slot. */
interface VstLoadResult {
  ok: boolean
  error?: string
  slotId: number
  name: string
  vendor: string
  type: VstPluginType
  uid: string
  numInputChannels: number
  numOutputChannels: number
  params: VstParamDesc[]
}

interface Window {
  nativeAudio?: {
    getDevices(): Promise<NativeAudioDevice[]>
    openStream(opts: NativeAudioStreamOpts): Promise<NativeAudioStreamResult>
    reinit(opts: NativeAudioStreamOpts): Promise<NativeAudioStreamResult>
    closeStream(): Promise<{ ok: boolean }>
    isStreamActive(): Promise<boolean>
    setMonitorGain(gain: number): Promise<{ ok: boolean }>
    /** Native master output gain (whole bus, before the limiter). 0 = silence, 1 = unity, ≤4. */
    setMasterGain(gain: number): Promise<{ ok: boolean }>
    getLatency(): Promise<NativeAudioLatency>
    /** E3 §1.1 pt.2: Pa_GetStreamTime() — monotonic seconds since stream open.
     *  Capture alongside AudioContext.currentTime at transport start to build a
     *  clock anchor; use at finishRecording to compute accumulated drift and
     *  convert clip durSec from PA-time to AC-time. Returns 0 if no stream. */
    getStreamTime(): Promise<number>
    getStats(): Promise<NativeAudioStats>
    onPcm(handler: (msg: {
      kind: 'pcm'
      streamId: number
      frames: number
      channels: number
      payload: ArrayBuffer
      latency?: NativeAudioLatency
    }) => void): () => void
    onOpusPacket(handler: (msg: OpusOutMessage) => void): () => void
    pushInboundOpus(packet: InboundOpusPacket): true | false | Promise<{ ok: boolean }>
    onLatency(handler: (latency: NativeAudioLatency) => void): () => void
    onEngineCrashed(handler: (info: { code: number }) => void): () => void
    /** M4: Set per-channel output gain for a remote peer. gain ∈ [0, 4]; 0 = muted. */
    setRemoteChannelGain(peerId: string, channelId: string, gain: number): Promise<{ ok: boolean }>
    /** Web Audio → PortAudio softmix bridge.  Transfers mono float32 PCM (zero-copy). */
    pushSoftmix(samples: ArrayBuffer): boolean
    /** Diagnostics: softmix buffers posted from the renderer vs failed (no port). */
    getSoftmixDiag(): { sent: number; failed: number }
    /** §9.A.4: enable/disable the softmix peak scan (call when Settings panel opens/closes). */
    setDiagnosticsActive(active: boolean): Promise<{ ok: boolean }>
    /** VST3 host (V2/V3). Present only with the build:vst addon; otherwise every
     *  call resolves to { ok:false, error:'VST host not built' }. */
    vst: {
      scan(paths?: string[]): Promise<{ ok: boolean; plugins?: VstPluginInfo[]; error?: string }>
      defaultPaths(): Promise<{ ok: boolean; paths?: string[]; error?: string }>
      load(opts: {
        path: string
        classUid?: string
        sampleRate?: number
        maxBlockSize?: number
        slotId?: number
      }): Promise<VstLoadResult>
      unload(slotId: number): Promise<{ ok: boolean; error?: string }>
      setParam(slotId: number, paramId: number, value: number): Promise<{ ok: boolean; error?: string }>
      getParam(slotId: number, paramId: number): Promise<{ ok: boolean; value?: number; error?: string }>
      setInsertChain(slotIds: number[]): Promise<{ ok: boolean; error?: string }>
      /** V4: open the plugin's own editor in a native OS window (false if headless). */
      openEditor(slotId: number): Promise<{ ok: boolean; error?: string }>
      closeEditor(slotId: number): Promise<{ ok: boolean; error?: string }>
      /** V6: set the insert chain for physical input channel `channelIdx`.
       *  Empty slotIds clears that channel's chain. Persists across reinit (V10). */
      setChannelChain(channelIdx: number, slotIds: number[]): Promise<{ ok: boolean; error?: string }>
      /** V9: read binary preset state of a loaded plugin slot. */
      getState(slotId: number): Promise<{ ok: boolean; data?: ArrayBuffer | null; error?: string }>
      /** V9: restore a plugin from a previously saved binary preset. */
      setState(slotId: number, data: ArrayBuffer): Promise<{ ok: boolean; error?: string }>
      /** I3: queue a MIDI Note On event for a VSTi slot (lock-free, delivered on next RT block). */
      noteOn(slotId: number, channel: number, pitch: number, velocity: number): Promise<void>
      /** I3: queue a MIDI Note Off event for a VSTi slot. */
      noteOff(slotId: number, channel: number, pitch: number): Promise<void>
      /** I1: register the VST insert chain for a logical track ID.
       *  Empty slotIds clears the chain for that track. JS-thread only. */
      setTrackChain(trackId: number, slotIds: number[]): Promise<void>
      /** Bug #4: register all non-bypassed instrument slots for RT synthesis output.
       *  The RT audio callback calls process() on each slot every block to drain MIDI
       *  events and produce PCM, which is mixed into the PortAudio output bus.
       *  Call this whenever any track's instrument chain changes. Up to 8 slots. */
      setSynthChain(slotIds: number[]): Promise<{ ok: boolean; error?: string }>
      /** PDC: read IAudioProcessor::getLatencySamples() for a loaded plugin slot.
       *  Call after vst.load() resolves. Returns 0 if plugin has no processing delay.
       *  Use to compensate recording start position: shift clip.startSec back by
       *  (latencySamples / sampleRate) seconds so the first beat aligns with the grid. */
      getLatency(slotId: number): Promise<{ ok: boolean; latencySamples: number; error?: string }>

      // Bug #2: user-configurable extra VST3 scan directories.
      /** Get user-saved extra VST3 scan directories from userData/kgb-settings.json.
       *  The C++ scan() always searches OS default paths + these extras. */
      getExtraScanPaths(): Promise<string[]>
      /** Persist extra scan directories to userData/kgb-settings.json. */
      setExtraScanPaths(paths: string[]): Promise<{ ok: boolean }>
      /** Open a native OS folder-picker dialog; returns the path or null if cancelled. */
      pickScanFolder(): Promise<string | null>
    }
  }
}
