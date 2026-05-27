interface NativeAudioDevice {
  id: number
  name: string
  hostApis: Array<{ kind: string; name: string }>
  inputChannels: number
  outputChannels: number
  defaultSampleRate: number
}

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
  }
}
