// Offline mixdown of all audio clips on the timeline.
// Renders each WAV blob from clipAudio at its startSec position into a single
// Float32 master buffer using the browser's AudioContext decoder.
// MIDI clip audio (drum voices, VSTi) is NOT included here — offline VSTi
// rendering requires §9.D.1 / streaming write (future sprint).
import { clipAudio } from '../audio/recorder'
import type { TimelineStoreApi } from './timelineStore'

const SR = 44100 // export sample rate

/** Decode a WAV/audio Blob into a Float32Array at SR=44100 mono. */
async function blobToFloat32(blob: Blob): Promise<Float32Array | null> {
  const ctx = new OfflineAudioContext(1, 1, SR)
  const buf = await blob.arrayBuffer()
  try {
    const decoded = await ctx.decodeAudioData(buf)
    // Downmix to mono if needed
    const out = new Float32Array(decoded.length)
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const ch_data = decoded.getChannelData(ch)
      const scale = 1 / decoded.numberOfChannels
      for (let i = 0; i < out.length; i++) out[i] += ch_data[i] * scale
    }
    return out
  } catch {
    return null
  }
}

export interface MixdownResult {
  samples: Float32Array
  sampleRate: number
  durationSec: number
}

/**
 * Render all audio clips (with real WAV data) into a single mono Float32 buffer.
 * Returns null if there are no audio clips with data.
 */
export async function renderMixdown(store: TimelineStoreApi): Promise<MixdownResult | null> {
  const { clips, tracks } = store.getState()
  const anySolo = tracks.some((t) => t.solo)

  // Collect audible audio clips that have real recorded data
  const toMix: Array<{ startSec: number; samples: Float32Array }> = []
  let endSec = 0

  for (const clip of clips) {
    if (clip.kind !== 'audio' || clip.proxy) continue
    const track = tracks.find((t) => t.id === clip.trackId)
    if (!track) continue
    if (track.muted) continue
    if (anySolo && !track.solo) continue
    const blob = clipAudio.get(clip.id)
    if (!blob) continue

    const samples = await blobToFloat32(blob)
    if (!samples) continue

    const clipEnd = clip.startSec + samples.length / SR
    if (clipEnd > endSec) endSec = clipEnd
    toMix.push({ startSec: clip.startSec, samples })
  }

  if (toMix.length === 0) return null

  const totalFrames = Math.ceil(endSec * SR)
  const out = new Float32Array(totalFrames)

  for (const { startSec, samples } of toMix) {
    const offset = Math.round(startSec * SR)
    for (let i = 0; i < samples.length; i++) {
      const pos = offset + i
      if (pos >= 0 && pos < totalFrames) out[pos] += samples[i]
    }
  }

  // Soft-limit to [-1, 1] without hard clipping
  let peak = 0
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a }
  if (peak > 1) {
    const inv = 1 / peak
    for (let i = 0; i < out.length; i++) out[i] *= inv
  }

  return { samples: out, sampleRate: SR, durationSec: endSec }
}

/** Encode a mono Float32 buffer as a 16-bit PCM WAV Blob. */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** Encode a mono Float32 buffer as MP3 using the background worker. */
export function encodeMp3(samples: Float32Array, sampleRate: number, kbps = 128): Promise<Blob> {
  return new Promise((resolve, reject) => {
    import('./mp3Encoder.worker?worker').then(({ default: Mp3Worker }) => {
      const worker = new Mp3Worker()
      const copy = new Float32Array(samples)  // transfer-safe copy
      worker.onmessage = (e: MessageEvent<{ mp3?: ArrayBuffer; error?: string }>) => {
        worker.terminate()
        if (e.data.error) { reject(new Error(e.data.error)); return }
        resolve(new Blob([e.data.mp3!], { type: 'audio/mpeg' }))
      }
      worker.postMessage({ samples: copy, sampleRate, bitrate: kbps }, [copy.buffer])
    }).catch(reject)
  })
}
