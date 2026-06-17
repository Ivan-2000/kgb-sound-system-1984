// T2 — PCM accumulation and WAV encoding for local input recording.
// §9.D.1: chunks are streamed to OPFS via a dedicated Web Worker.
// Falls back to in-memory Int16 accumulation if OPFS workers are unavailable.
//
// Lifecycle:
//   recorder.start(channelIdx, clipId)
//   recorder.stopAsync(channelIdx) → Promise<{blob, durSec, clipId, peaks} | null>

import { nativeAudioController } from './nativeAudioController'

const PEAKS_PER_SEC = 50

interface ActiveRec {
  clipId: string
  channelIdx: number
  channelCount: number
  fallbackChunks: Int16Array[] | null  // used when OPFS worker is unavailable
  peaks: number[]
  binPeak: number
  binFrames: number
  framesSeen: number
  /** Resolves when the OPFS worker finishes writing and returns the WAV buffer. */
  donePromise: Promise<ArrayBuffer> | null
}

/** Exported blob per clip (kept in memory for the session). */
export const clipAudio = new Map<string, Blob>()

// ── OPFS worker singleton ────────────────────────────────────────────────────
let _worker: Worker | null | 'unavailable' = null
const _workerCbs = new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }>()

function onWorkerMessage(e: MessageEvent<{ kind: string; clipId: string; wav?: ArrayBuffer; error?: string }>): void {
  const { kind, clipId, wav, error } = e.data
  const cb = _workerCbs.get(clipId)
  if (!cb) return
  _workerCbs.delete(clipId)
  if (kind === 'done' && wav) cb.resolve(wav)
  else cb.reject(new Error(error ?? 'recorderWorker error'))
}

/** Lazily import and create the OPFS recorder worker. Returns null if unavailable. */
async function ensureWorker(): Promise<Worker | null> {
  if (_worker === 'unavailable') return null
  if (_worker) return _worker
  try {
    const { default: Ctor } = await import('../workers/recorderWorker.worker?worker') as { default: new () => Worker }
    const w = new Ctor()
    w.onmessage = onWorkerMessage
    _worker = w
    return w
  } catch {
    _worker = 'unavailable'
    return null
  }
}

// ── Recorder class ────────────────────────────────────────────────────────────
class Recorder {
  private active = new Map<number, ActiveRec>()
  private unsub: (() => void) | null = null
  // Worker reference cached after first async resolution.
  private cachedWorker: Worker | null = null

  /** Begin accumulating PCM for the given input channel index.
   *  Kicks off async worker init; PCM chunks will be queued. */
  start(channelIdx: number, clipId: string): void {
    if (this.active.has(channelIdx)) this.stop(channelIdx)

    let donePromise: Promise<ArrayBuffer> | null = null
    let fallbackChunks: Int16Array[] | null = null
    let resolve!: (b: ArrayBuffer) => void
    let reject!: (e: unknown) => void

    // Start the worker init. If it resolves before the first chunk arrives, great;
    // otherwise chunks are queued in fallbackChunks until we know if the worker is available.
    const initPromise = ensureWorker().then((w) => {
      if (!w) {
        // No worker: switch to in-memory mode.
        fallbackChunks = []
        return
      }
      this.cachedWorker = w
      donePromise = new Promise<ArrayBuffer>((res, rej) => { resolve = res; reject = rej })
      _workerCbs.set(clipId, { resolve, reject })
      w.postMessage({ kind: 'start', clipId })
      // Flush any chunks that arrived before the worker was ready.
      const rec = this.active.get(channelIdx)
      if (rec?.fallbackChunks?.length) {
        for (const chunk of rec.fallbackChunks) {
          const copy = new Int16Array(chunk)
          w.postMessage({ kind: 'chunk', clipId, pcm: copy }, [copy.buffer])
        }
        rec.fallbackChunks = null  // hand off to worker, stop in-memory accumulation
        rec.donePromise = donePromise
      }
    }).catch(() => {
      // Worker init failed — fall back to in-memory.
      if (!this.active.get(channelIdx)?.fallbackChunks) {
        const rec = this.active.get(channelIdx)
        if (rec) rec.fallbackChunks = rec.fallbackChunks ?? []
      }
    })
    void initPromise

    // Initially accumulate in-memory until the worker is confirmed available.
    fallbackChunks = []
    this.active.set(channelIdx, {
      clipId, channelIdx, channelCount: 0,
      fallbackChunks,
      peaks: [], binPeak: 0, binFrames: 0, framesSeen: 0,
      donePromise,
    })
    this.ensureSubscribed()
  }

  /** Stop recording and return WAV blob + metadata, or null if nothing was captured. */
  async stopAsync(channelIdx: number): Promise<{ blob: Blob; durSec: number; clipId: string; peaks: number[] } | null> {
    const rec = this.active.get(channelIdx)
    if (!rec) return null
    this.active.delete(channelIdx)
    this.maybeUnsubscribe()

    const snap = nativeAudioController.getSnapshot()
    const sampleRate = snap.actualSampleRate ?? snap.sampleRate ?? 48000
    const peaks = rec.peaks.slice()
    const clipId = rec.clipId
    const durSec = rec.framesSeen / sampleRate

    // OPFS path
    const w = this.cachedWorker
    if (w && rec.donePromise && !rec.fallbackChunks) {
      w.postMessage({ kind: 'stop', clipId, sampleRate })
      try {
        const wavBuf = await rec.donePromise
        const blob = new Blob([wavBuf], { type: 'audio/wav' })
        clipAudio.set(clipId, blob)
        return { blob, durSec, clipId, peaks }
      } catch (err) {
        console.warn('[recorder] OPFS path failed, trying in-memory fallback', err)
      }
    }

    // In-memory fallback
    const chunks = rec.fallbackChunks
    if (!chunks || chunks.length === 0) return null
    const blob = encodeWavFromInt16(chunks, sampleRate)
    clipAudio.set(clipId, blob)
    return { blob, durSec, clipId, peaks }
  }

  /** Fire-and-forget stop (for compatibility with existing callers). */
  stop(channelIdx: number): void { void this.stopAsync(channelIdx) }

  isRecording(channelIdx: number): boolean { return this.active.has(channelIdx) }

  getLive(channelIdx: number): { clipId: string; durSec: number; peaks: number[] } | null {
    const rec = this.active.get(channelIdx)
    if (!rec) return null
    const snap = nativeAudioController.getSnapshot()
    const sr = (snap.actualSampleRate ?? snap.sampleRate) || 48000
    return { clipId: rec.clipId, durSec: rec.framesSeen / sr, peaks: rec.peaks.slice() }
  }

  stopAll(): void { for (const ch of [...this.active.keys()]) this.stop(ch) }

  private ensureSubscribed(): void {
    if (this.unsub || !window.nativeAudio) return
    this.unsub = window.nativeAudio.onPcm((msg: { frames: number; channels: number; payload: ArrayBuffer }) => {
      const { frames, channels, payload } = msg
      if (frames === 0 || channels === 0) return
      const samples = new Float32Array(payload)
      const { sampleRate } = nativeAudioController.getSnapshot()
      const binSize = Math.max(1, Math.round((sampleRate || 48000) / PEAKS_PER_SEC))

      for (const rec of this.active.values()) {
        rec.channelCount = channels
        const ch = Math.min(rec.channelIdx, channels - 1)

        // §9.D.1: extract only the needed channel as Int16 (vs storing all channels as Float32).
        // Memory reduction: Nch × 2 (e.g. 4× for stereo).
        const int16 = new Int16Array(frames)
        for (let f = 0; f < frames; f++) {
          const s = Math.max(-1, Math.min(1, samples[f * channels + ch]))
          int16[f] = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF)
          const v = s < 0 ? -s : s
          if (v > rec.binPeak) rec.binPeak = v
          if (++rec.binFrames >= binSize) {
            rec.peaks.push(rec.binPeak)
            rec.binPeak = 0
            rec.binFrames = 0
          }
        }
        rec.framesSeen += frames

        const w = this.cachedWorker
        if (w && rec.donePromise && !rec.fallbackChunks) {
          // Hand off to OPFS worker (zero-copy transfer)
          w.postMessage({ kind: 'chunk', clipId: rec.clipId, pcm: int16 }, [int16.buffer])
        } else if (rec.fallbackChunks) {
          rec.fallbackChunks.push(int16)
        }
      }
    })
  }

  private maybeUnsubscribe(): void {
    if (this.active.size === 0 && this.unsub) { this.unsub(); this.unsub = null }
  }
}

function encodeWavFromInt16(chunks: Int16Array[], sampleRate: number): Blob {
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const byteLen = total * 2
  const buf = new ArrayBuffer(44 + byteLen)
  const v = new DataView(buf)
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  wr(0, 'RIFF'); v.setUint32(4, 36 + byteLen, true); wr(8, 'WAVE')
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  wr(36, 'data'); v.setUint32(40, byteLen, true)
  const out = new Int16Array(buf, 44)
  let pos = 0
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length }
  return new Blob([buf], { type: 'audio/wav' })
}

export const recorder = new Recorder()
