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
    getLatency(): Promise<NativeAudioLatency>
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
    }
  }
}
