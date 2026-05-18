import * as Tone from 'tone'

export const MIN_BPM = 60
export const MAX_BPM = 240
export const DEFAULT_BPM = 120

export type AudioEngineState = {
  bpm: number
  isInitialized: boolean
  isPlaying: boolean
}

export type TransportStartOptions = {
  position?: Tone.Unit.Time
  time?: Tone.Unit.Time
}

const clampBpm = (bpm: number) => {
  if (!Number.isFinite(bpm)) {
    return DEFAULT_BPM
  }

  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)))
}

class AudioEngine {
  private bpm = DEFAULT_BPM
  private initialized = false
  private playing = false
  private unlockPromise: Promise<void> | null = null

  constructor() {
    Tone.Transport.bpm.value = DEFAULT_BPM
  }

  getState(): AudioEngineState {
    return {
      bpm: this.bpm,
      isInitialized: this.initialized,
      isPlaying: this.playing,
    }
  }

  async unlock() {
    if (this.initialized) {
      return
    }

    this.unlockPromise ??= Tone.start().then(() => {
      Tone.Transport.bpm.value = this.bpm
      this.initialized = true
    })

    await this.unlockPromise
  }

  setBpm(nextBpm: number) {
    const bpm = clampBpm(nextBpm)

    this.bpm = bpm
    Tone.Transport.bpm.rampTo(bpm, 0.03)

    return bpm
  }

  getBpm() {
    return this.bpm
  }

  async play(options: TransportStartOptions = {}) {
    await this.unlock()

    if (this.playing) {
      return
    }

    Tone.Transport.start(options.time, options.position)
    this.playing = true
  }

  stop() {
    Tone.Transport.stop()
    this.playing = false
  }

  togglePlayback() {
    if (this.playing) {
      this.stop()
      return Promise.resolve(false)
    }

    return this.play().then(() => true)
  }
}

export const audioEngine = new AudioEngine()

