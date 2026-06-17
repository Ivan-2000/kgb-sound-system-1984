// T2 — PCM accumulation and WAV encoding for local input recording.
//
// Lifecycle:
//   recorder.start(channelIdx, clipId) — call when arm button is pressed
//   recorder.stop(channelIdx)          — call when disarm; returns encoded WAV + real duration
//
// Audio data is also stored in clipAudio (keyed by clipId) so the export
// pipeline can use actual audio instead of silence once T2 is active.

import { nativeAudioController } from './nativeAudioController'

/** Waveform resolution: peak bins per second of recorded audio. */
const PEAKS_PER_SEC = 50

interface ActiveRec {
  chunks: Float32Array[]
  channelCount: number
  clipId: string
  /** Which interleaved channel this recording extracts (the armed input). */
  channelIdx: number
  /** Downsampled |peak| per bin (0..1) — drives the live clip waveform. */
  peaks: number[]
  /** Current bin accumulator: max |sample| and frames consumed so far. */
  binPeak: number
  binFrames: number
  /** Total frames captured (real duration = framesSeen / sampleRate). */
  framesSeen: number
}

/** Exported blob per clip (kept in memory for the session). */
export const clipAudio = new Map<string, Blob>()

class Recorder {
  private active = new Map<number, ActiveRec>()
  private unsub: (() => void) | null = null

  /** Begin accumulating PCM for the given input channel index. */
  start(channelIdx: number, clipId: string): void {
    if (this.active.has(channelIdx)) this.stop(channelIdx) // replace any existing
    this.active.set(channelIdx, {
      chunks: [], channelCount: 0, clipId, channelIdx,
      peaks: [], binPeak: 0, binFrames: 0, framesSeen: 0,
    })
    this.ensureSubscribed()
  }

  /**
   * Stop recording the given channel.
   * Returns the WAV blob, actual duration and waveform peaks, or null if no
   * data was captured.
   */
  stop(channelIdx: number): { blob: Blob; durSec: number; clipId: string; peaks: number[] } | null {
    const rec = this.active.get(channelIdx)
    if (!rec) return null
    this.active.delete(channelIdx)
    this.maybeUnsubscribe()
    if (rec.chunks.length === 0 || rec.channelCount === 0) return null
    // §8.A.1: use the SR actually reported by Pa_GetStreamInfo, not the requested
    // 48000 constant. On devices that negotiate a different rate (44.1k, 44100/WASAPI)
    // the WAV header would otherwise encode the wrong pitch/length silently.
    const snap = nativeAudioController.getSnapshot()
    const sampleRate = snap.actualSampleRate ?? snap.sampleRate
    const chanIdx = Math.min(channelIdx, rec.channelCount - 1)
    const mono = extractChannel(rec.chunks, chanIdx, rec.channelCount)
    if (mono.length === 0) return null
    const blob = encodeWav(mono, sampleRate)
    clipAudio.set(rec.clipId, blob)
    return { blob, durSec: mono.length / sampleRate, clipId: rec.clipId, peaks: rec.peaks.slice() }
  }

  isRecording(channelIdx: number): boolean {
    return this.active.has(channelIdx)
  }

  /**
   * Live snapshot for the running-waveform UI: elapsed seconds + a COPY of the
   * peak bins accumulated so far. Cheap (peaks grow at PEAKS_PER_SEC).
   */
  getLive(channelIdx: number): { clipId: string; durSec: number; peaks: number[] } | null {
    const rec = this.active.get(channelIdx)
    if (!rec) return null
    const snap = nativeAudioController.getSnapshot()
    const sr = (snap.actualSampleRate ?? snap.sampleRate) || 48000
    return {
      clipId: rec.clipId,
      durSec: rec.framesSeen / sr,
      peaks: rec.peaks.slice(),
    }
  }

  /** Stop all active recordings — call on cleanup / stream close. */
  stopAll(): void {
    for (const channelIdx of [...this.active.keys()]) this.stop(channelIdx)
  }

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
        rec.chunks.push(new Float32Array(samples)) // copy — payload may be detached next frame
        // Incremental peak bins over THIS recording's channel.
        const ch = Math.min(rec.channelIdx, channels - 1)
        for (let f = 0; f < frames; f++) {
          const s = samples[f * channels + ch]
          const v = s < 0 ? -s : s
          if (v > rec.binPeak) rec.binPeak = v
          if (++rec.binFrames >= binSize) {
            rec.peaks.push(rec.binPeak)
            rec.binPeak = 0
            rec.binFrames = 0
          }
        }
        rec.framesSeen += frames
      }
    })
  }

  private maybeUnsubscribe(): void {
    if (this.active.size === 0 && this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }
}

function extractChannel(chunks: Float32Array[], chanIdx: number, numChans: number): Float32Array {
  const totalFrames = chunks.reduce((s, c) => s + Math.floor(c.length / numChans), 0)
  const out = new Float32Array(totalFrames)
  let outIdx = 0
  for (const chunk of chunks) {
    const frames = Math.floor(chunk.length / numChans)
    for (let f = 0; f < frames; f++) {
      out[outIdx++] = chunk[f * numChans + chanIdx] ?? 0
    }
  }
  return out
}

/** Encode a mono Float32 buffer as a 16-bit PCM WAV Blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)   // PCM
  v.setUint16(22, 1, true)   // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)  // byteRate = sampleRate × 1 ch × 2 bytes
  v.setUint16(32, 2, true)   // blockAlign
  v.setUint16(34, 16, true)  // bitsPerSample
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export const recorder = new Recorder()
