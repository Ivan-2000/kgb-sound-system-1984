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
  /** AudioWorklet node that taps Tone.js output and forwards PCM to PortAudio. */
  private workletNode: AudioWorkletNode | null = null
  /** Native AudioContext extracted from the Tone.js wrapper (set by the bridge). */
  private rawCtx: (AudioContext & { setSinkId?: (id: string | { type: string }) => Promise<void> }) | null = null
  /** True while a PortAudio stream with an output side is active. */
  private portAudioActive = false

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

    this.unlockPromise ??= Tone.start().then(async () => {
      Tone.Transport.bpm.value = this.bpm
      this.initialized = true
      // Route all audio through PortAudio instead of Web Audio output device.
      await this.setupPortAudioBridge()
    })

    await this.unlockPromise
  }

  /**
   * Connect an AudioWorklet tap to the Tone.js master bus and silence the
   * native Web Audio output (setSinkId none).  The worklet forwards PCM to
   * window.nativeAudio.pushSoftmix() → PortAudio ring → physical speakers.
   *
   * No-op if window.nativeAudio is unavailable (non-Electron environments keep
   * the default Web Audio output path).
   */
  private async setupPortAudioBridge(): Promise<void> {
    if (!window.nativeAudio || this.workletNode) return
    try {
      // ── Step 1: extract the native AudioContext ────────────────────────────
      //
      // Tone.js wraps the native AudioContext in its own Context class.
      // In minified Rolldown bundles internal property names may be renamed,
      // so we try several strategies and accept the first real AudioContext.
      //
      // Strategy A — Tone.getContext().createGain() always delegates to the
      //   native AudioContext's createGain(), so the returned GainNode's
      //   .context is always the native AudioContext (Web Audio spec §2.5).
      //
      // Strategy B/C — well-known private property names used by Tone.js v15.
      //
      // Strategy D — linear scan of all own keys on the Context wrapper.
      //
      let rawCtx: AudioContext | undefined

      // A: create a temp native gain; its .context is guaranteed native.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g: GainNode | undefined = (Tone.getContext() as any).createGain?.()
        if (g?.context instanceof AudioContext) rawCtx = g.context as AudioContext
      } catch { /* ignore */ }

      // B: rawContext (Tone.js v15 public getter)
      if (!rawCtx) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (Tone.getContext() as any).rawContext
        if (c instanceof AudioContext) rawCtx = c
      }

      // C: _context (Tone.js v15 private backing field)
      if (!rawCtx) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (Tone.getContext() as any)._context
        if (c instanceof AudioContext) rawCtx = c
      }

      // D: scan all own keys for an AudioContext-shaped value
      if (!rawCtx) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toneCtx = Tone.getContext() as any
        for (const key of Object.keys(toneCtx)) {
          if (toneCtx[key] instanceof AudioContext) { rawCtx = toneCtx[key]; break }
        }
      }

      if (!rawCtx?.audioWorklet) {
        console.error('[audioEngine] AudioWorklet unavailable — bridge disabled.', { rawCtx })
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
        if (buf && this.portAudioActive) window.nativeAudio!.pushSoftmix(buf)
      }

      // ── Step 4: tap Tone.js master output ────────────────────────────────
      // Use Tone.js's own connect() API — it correctly resolves ToneAudioNode
      // → native AudioNode connections regardless of internal property naming.
      // InputNode type includes AudioNode, so AudioWorkletNode is accepted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Tone.getDestination() as any).connect(worklet)

      // ── Step 5: route Web Audio sink to match the PortAudio stream state ──
      // Stream active → sink 'none' (PortAudio owns the hardware, softmix plays
      // through the user-selected output device). Stream inactive → default sink
      // so Tone.js is still audible before a device is opened.
      this.rawCtx = rawCtx as typeof this.rawCtx
      await this.applySink()

      console.log('[audioEngine] PortAudio output bridge active')
    } catch (err) {
      console.error('[audioEngine] PortAudio bridge setup failed:', err)
    }
  }

  /**
   * Called when the PortAudio stream opens/closes (App subscribes to
   * nativeAudioController state). Active → silence Web Audio output and feed
   * the softmix bridge; inactive → restore the system-default sink so Tone.js
   * remains audible without a stream.
   */
  setPortAudioActive(active: boolean): void {
    if (this.portAudioActive === active) return
    this.portAudioActive = active
    void this.applySink()
  }

  private async applySink(): Promise<void> {
    const ctx = this.rawCtx
    if (!ctx || typeof ctx.setSinkId !== 'function') return
    try {
      if (this.portAudioActive) {
        await ctx.setSinkId({ type: 'none' })
        console.log('[audioEngine] Web Audio output silenced (routing via PortAudio)')
      } else {
        await ctx.setSinkId('') // '' = system default device
        console.log('[audioEngine] Web Audio output → system default (no PortAudio stream)')
      }
    } catch (err) {
      console.warn('[audioEngine] setSinkId failed — audio may play on the wrong device:', err)
    }
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

  /** Current transport position in seconds (for the timeline playhead). */
  getTransportSeconds(): number {
    return Tone.Transport.seconds
  }

  /** Move the transport playhead (timeline scrub). */
  seekSeconds(sec: number): void {
    Tone.Transport.seconds = Math.max(0, sec)
  }

  /** Set the transport loop region (timeline playback region markers). */
  setLoopRegion(start: number, end: number): void {
    if (end > start) {
      Tone.Transport.setLoopPoints(start, end)
      Tone.Transport.loop = true
    }
  }

  clearLoopRegion(): void {
    Tone.Transport.loop = false
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

