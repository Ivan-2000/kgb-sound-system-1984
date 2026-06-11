import * as Tone from 'tone'
import { nativeToneContext } from './toneNativeContext'

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
  /** AudioWorklet node that taps Tone.js output and forwards PCM to PortAudio. */
  private workletNode: AudioWorkletNode | null = null
  /** True while a PortAudio stream with an output side is active. */
  private portAudioActive = false
  /** Diagnostics: worklet messages forwarded to pushSoftmix since bridge start. */
  private smFrames = 0
  /** Diagnostics: decaying peak |sample| in forwarded PCM (NOT reset on read). */
  private smPeak = 0

  constructor() {
    Tone.getTransport().bpm.value = DEFAULT_BPM
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

    this.unlockPromise ??= Tone.start().then(async () => {
      Tone.getTransport().bpm.value = this.bpm
      this.initialized = true
      // Route all audio through PortAudio instead of Web Audio output device.
      await this.setupPortAudioBridge()
    })

    await this.unlockPromise
  }

  /**
   * Connect an AudioWorklet tap to the Tone.js master bus. The worklet forwards
   * PCM to window.nativeAudio.pushSoftmix() → PortAudio ring → physical
   * speakers. (The Web Audio sink itself is silenced at context creation in
   * toneNativeContext.ts — Electron never plays through system devices.)
   *
   * No-op if window.nativeAudio is unavailable (non-Electron environments keep
   * the default Web Audio output path).
   */
  private async setupPortAudioBridge(): Promise<void> {
    if (!window.nativeAudio || this.workletNode) return
    try {
      // ── Step 1: the native AudioContext ───────────────────────────────────
      // toneNativeContext.ts (imported first in main.tsx) hands Tone a NATIVE
      // AudioContext, so Tone's whole graph is built on native nodes and we can
      // use audioWorklet + setSinkId directly. (Tone's default context is a
      // standardized-audio-context wrapper where neither is reachable.)
      const rawCtx = nativeToneContext
      if (Tone.getContext().rawContext !== rawCtx) {
        console.warn('[audioEngine] Tone is not on the native context — bridge may tap silence.')
      }
      if (!rawCtx.audioWorklet) {
        console.error('[audioEngine] AudioWorklet unavailable — bridge disabled.')
        return
      }

      // ── Step 2: register worklet module ───────────────────────────────────
      // File lives in public/ and is copied verbatim to dist/ at build time.
      await rawCtx.audioWorklet.addModule('./portaudioWorklet.js')

      // ── Step 3: create pure-sink worklet node ─────────────────────────────
      const worklet = new AudioWorkletNode(rawCtx, 'portaudio-output-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      this.workletNode = worklet

      // Each 128-sample quantum → forward to PortAudio ring buffer (zero-copy).
      // Gated on portAudioActive: while no stream is open the ring isn't drained,
      // so pushing would only leave stale audio that bursts out on stream open.
      worklet.port.onmessage = (e: MessageEvent<{ samples: ArrayBuffer }>) => {
        const buf = e.data?.samples
        if (!buf || !this.portAudioActive) return
        // Diagnostics scan (buffer is structured-clone copied, not detached).
        // Decaying peak — same scheme as utilityHost (~−33 dB/s at 375 msg/s).
        const a = new Float32Array(buf)
        let msgPeak = 0
        for (let i = 0; i < a.length; i++) {
          const v = a[i] < 0 ? -a[i] : a[i]
          if (v > msgPeak) msgPeak = v
        }
        this.smPeak = Math.max(msgPeak, this.smPeak * 0.99)
        this.smFrames++
        window.nativeAudio!.pushSoftmix(buf)
      }

      // ── Step 4: tap Tone.js master output ────────────────────────────────
      // Use Tone.js's own connect() API — it correctly resolves ToneAudioNode
      // → native AudioNode connections regardless of internal property naming.
      // InputNode type includes AudioNode, so AudioWorkletNode is accepted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Tone.getDestination() as any).connect(worklet)

      // Sink note: the Web Audio sink is permanently 'none' in Electron —
      // silenced at context creation in toneNativeContext.ts. All audible
      // program sound exits ONLY via this worklet → PortAudio.

      console.log('[audioEngine] PortAudio output bridge active')
    } catch (err) {
      console.error('[audioEngine] PortAudio bridge setup failed:', err)
    }
  }

  /**
   * Called when the PortAudio stream opens/closes (App subscribes to
   * nativeAudioController state). Only gates the worklet → pushSoftmix feed:
   * with no stream the ring isn't drained, so pushing would leave stale audio
   * that bursts out on the next stream open. The Web Audio sink itself is
   * permanently 'none' in Electron (toneNativeContext.ts).
   */
  setPortAudioActive(active: boolean): void {
    this.portAudioActive = active
  }

  /**
   * Bridge health snapshot for the Settings diagnostics row. `peak` is a
   * decaying max |sample| (NOT reset on read — safe for any number of
   * concurrent readers). All values are cheap counters.
   */
  getBridgeStats(): { bridgeUp: boolean; routingToPortAudio: boolean; framesSent: number; peak: number; contextState: string } {
    const peak = this.smPeak
    return {
      bridgeUp: this.workletNode !== null,
      routingToPortAudio: this.portAudioActive,
      framesSent: this.smFrames,
      peak,
      contextState: nativeToneContext.state,
    }
  }

  setBpm(nextBpm: number) {
    const bpm = clampBpm(nextBpm)

    this.bpm = bpm
    Tone.getTransport().bpm.rampTo(bpm, 0.03)

    return bpm
  }

  getBpm() {
    return this.bpm
  }

  /** Current transport position in seconds (for the timeline playhead). */
  getTransportSeconds(): number {
    return Tone.getTransport().seconds
  }

  /** Move the transport playhead (timeline scrub). */
  seekSeconds(sec: number): void {
    Tone.getTransport().seconds = Math.max(0, sec)
  }

  /** Set the transport loop region (timeline playback region markers). */
  setLoopRegion(start: number, end: number): void {
    if (end > start) {
      Tone.getTransport().setLoopPoints(start, end)
      Tone.getTransport().loop = true
    }
  }

  clearLoopRegion(): void {
    Tone.getTransport().loop = false
  }

  async play(options: TransportStartOptions = {}) {
    await this.unlock()

    if (this.playing) {
      return
    }

    Tone.getTransport().start(options.time, options.position)
    this.playing = true
  }

  stop() {
    Tone.getTransport().stop()
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

