type ChannelControls = {
  volume: number   // 0–1
  muted: boolean
  solo: boolean
  pan: number      // -1 to 1
}

type ChannelNodes = {
  source: MediaStreamAudioSourceNode
  gain: GainNode
  panner: StereoPannerNode
  analyser: AnalyserNode
  controls: ChannelControls
}

const ANALYSER_FFT = 256
const SMOOTH_TIME = 0.02  // seconds for gain ramp

class MixerEngine {
  private context: AudioContext | null = null
  private channels = new Map<string, ChannelNodes>()
  private masterGain: GainNode | null = null
  private masterCompressor: DynamicsCompressorNode | null = null
  private masterVolume = 1

  private ensureContext(): AudioContext {
    if (this.context) return this.context

    const ctx = new AudioContext()

    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -24
    compressor.knee.value = 10
    compressor.ratio.value = 4
    compressor.attack.value = 0.003
    compressor.release.value = 0.25

    const master = ctx.createGain()
    master.gain.value = this.masterVolume

    compressor.connect(master)
    master.connect(ctx.destination)

    this.masterCompressor = compressor
    this.masterGain = master
    this.context = ctx
    return ctx
  }

  addChannel(socketId: string, stream: MediaStream) {
    // Remove stale channel if stream changed
    if (this.channels.has(socketId)) {
      this.removeChannel(socketId)
    }

    const ctx = this.ensureContext()
    // Resume if browser suspended context (autoplay policy)
    void ctx.resume()

    const source = ctx.createMediaStreamSource(stream)

    const gain = ctx.createGain()
    gain.gain.value = 0.8

    const panner = ctx.createStereoPanner()
    panner.pan.value = 0

    const analyser = ctx.createAnalyser()
    analyser.fftSize = ANALYSER_FFT
    analyser.smoothingTimeConstant = 0.8

    source.connect(gain)
    gain.connect(panner)
    panner.connect(analyser)
    analyser.connect(this.masterCompressor!)

    this.channels.set(socketId, {
      source,
      gain,
      panner,
      analyser,
      controls: { volume: 0.8, muted: false, solo: false, pan: 0 },
    })
  }

  removeChannel(socketId: string) {
    const ch = this.channels.get(socketId)
    if (!ch) return

    try {
      ch.analyser.disconnect()
      ch.panner.disconnect()
      ch.gain.disconnect()
      ch.source.disconnect()
    } catch {
      // Nodes may already be disconnected
    }

    this.channels.delete(socketId)
  }

  setVolume(socketId: string, volume: number) {
    const ch = this.channels.get(socketId)
    if (!ch || !this.context) return
    ch.controls.volume = volume
    if (!ch.controls.muted) {
      const effective = this.effectiveGain(socketId)
      ch.gain.gain.setTargetAtTime(effective, this.context.currentTime, SMOOTH_TIME)
    }
  }

  setMuted(socketId: string, muted: boolean) {
    const ch = this.channels.get(socketId)
    if (!ch || !this.context) return
    ch.controls.muted = muted
    const target = muted ? 0 : this.effectiveGain(socketId)
    ch.gain.gain.setTargetAtTime(target, this.context.currentTime, SMOOTH_TIME)
  }

  setSolo(socketId: string, solo: boolean) {
    const ch = this.channels.get(socketId)
    if (!ch) return
    ch.controls.solo = solo
    this.recomputeAllGains()
  }

  setPan(socketId: string, pan: number) {
    const ch = this.channels.get(socketId)
    if (!ch || !this.context) return
    ch.controls.pan = pan
    ch.panner.pan.setTargetAtTime(pan, this.context.currentTime, SMOOTH_TIME)
  }

  setMasterVolume(volume: number) {
    this.masterVolume = volume
    if (!this.masterGain || !this.context) return
    this.masterGain.gain.setTargetAtTime(volume, this.context.currentTime, SMOOTH_TIME)
  }

  getMasterVolume() {
    return this.masterVolume
  }

  getControls(socketId: string): ChannelControls | null {
    return this.channels.get(socketId)?.controls ?? null
  }

  /**
   * Returns RMS level 0–1 for the given channel, sampled from the AnalyserNode.
   * Returns null if the channel doesn't exist yet.
   */
  getLevelRms(socketId: string): number | null {
    const ch = this.channels.get(socketId)
    if (!ch) return null

    const buf = new Uint8Array(ch.analyser.frequencyBinCount)
    ch.analyser.getByteTimeDomainData(buf)

    let sum = 0
    for (const v of buf) {
      const sample = (v - 128) / 128
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / buf.length)
    // Scale to 0–1; raw RMS from voice is usually 0.01–0.15
    return Math.min(1, rms * 6)
  }

  private effectiveGain(socketId: string): number {
    const ch = this.channels.get(socketId)
    if (!ch || ch.controls.muted) return 0
    const anySoloed = [...this.channels.values()].some((c) => c.controls.solo)
    if (anySoloed && !ch.controls.solo) return 0
    return ch.controls.volume
  }

  private recomputeAllGains() {
    if (!this.context) return
    for (const [socketId, ch] of this.channels) {
      const target = ch.controls.muted ? 0 : this.effectiveGain(socketId)
      ch.gain.gain.setTargetAtTime(target, this.context.currentTime, SMOOTH_TIME)
    }
  }
}

export const mixerEngine = new MixerEngine()
export type { ChannelControls }
