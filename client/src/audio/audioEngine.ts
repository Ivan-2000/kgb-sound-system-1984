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
  /** §9.A.4: only run the peak scan when Settings is open (caller toggles via setDiagnosticsActive). */
  private diagActive = false
  /**
   * E3 §1.1 pt.2: anchor for AudioContext ↔ PortAudio clock drift correction.
   * Captured once at each transport start via captureClockAnchor().
   * acTime = nativeToneContext.currentTime just before the getStreamTime IPC.
   * paTime = Pa_GetStreamTime() returned by the utility process.
   * The ~2-5 ms IPC round-trip introduces a constant bias that does not affect
   * the drift RATE measurement used in computeDriftRatio().
   */
  private clockAnchor: { acTime: number; paTime: number } | null = null

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
        // §9.A.4: peak scan only when Settings is open.
        if (this.diagActive) {
          const a = new Float32Array(buf)
          let msgPeak = 0
          for (let i = 0; i < a.length; i++) {
            const v = a[i] < 0 ? -a[i] : a[i]
            if (v > msgPeak) msgPeak = v
          }
          this.smPeak = Math.max(msgPeak, this.smPeak * 0.99)
        }
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

  /** §9.A.4: toggle the expensive peak scan. Call with true when Settings opens, false on close. */
  setDiagnosticsActive(active: boolean): void {
    this.diagActive = active
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

  /**
   * E3 §1.1 pt.2: capture a paired { acTime, paTime } clock anchor.
   * Called fire-and-forget from play() so that it doesn't delay transport start.
   * acTime is sampled BEFORE the async IPC hop; paTime arrives a few ms later.
   * The mismatch is a constant bias and does not pollute the drift rate.
   */
  private async captureClockAnchor(): Promise<void> {
    if (!window.nativeAudio) return
    const acTime = nativeToneContext.currentTime
    try {
      const paTime = await window.nativeAudio.getStreamTime()
      if (typeof paTime === 'number' && paTime > 0) {
        this.clockAnchor = { acTime, paTime }
      }
    } catch {
      // No stream open — anchor stays null; drift correction is skipped.
    }
  }

  /**
   * E3 §1.1 pt.2: compute the AC/PA clock ratio for drift correction.
   * Returns acElapsed/paElapsed (< 1 if PA ran faster, > 1 if AC ran faster),
   * or null if the anchor is missing, too fresh, or the ratio looks unreasonable.
   * Multiply durSec (PA-time) by this ratio to get the AC-time clip duration.
   */
  async computeDriftRatio(): Promise<number | null> {
    if (!this.clockAnchor || !window.nativeAudio) return null
    const acNow = nativeToneContext.currentTime
    let paTimeNow: number
    try {
      paTimeNow = await window.nativeAudio.getStreamTime()
    } catch {
      return null
    }
    if (typeof paTimeNow !== 'number' || paTimeNow <= 0) return null
    const acElapsed = acNow - this.clockAnchor.acTime
    const paElapsed = paTimeNow - this.clockAnchor.paTime
    // Require at least 2 s of data and reject wildly wrong ratios (> 1% drift
    // would be a misconfigured clock, not normal audio drift).
    if (acElapsed < 2 || paElapsed < 2) return null
    const ratio = acElapsed / paElapsed
    if (Math.abs(ratio - 1) > 0.01) return null
    return ratio
  }

  async play(options: TransportStartOptions = {}) {
    await this.unlock()

    if (this.playing) {
      return
    }

    Tone.getTransport().start(options.time, options.position)
    this.playing = true
    // E3 §1.1 pt.2: fire-and-forget — must not delay transport start.
    void this.captureClockAnchor()
  }

  stop() {
    Tone.getTransport().stop()
    this.playing = false
    this.clockAnchor = null  // reset anchor — next play() captures a fresh one
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

