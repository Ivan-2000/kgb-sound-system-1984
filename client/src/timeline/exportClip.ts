// T3 — per-clip and full mixdown export.
// MP3 encoding runs in a background Web Worker (mp3Encoder.worker.ts / lamejs).
import { clipAudio } from '../audio/recorder'
import type { TimelineStoreApi } from './timelineStore'
import { renderMixdown, encodeWavMono, encodeMp3 } from './mixdown'
import { downloadProject } from './projectExport'

export type ExportCodec = 'wav' | 'mp3'

export interface ExportOptions {
  clipId?: string
  label: string
  durSec: number
  codec: ExportCodec
  bitrate: number
  sampleRate?: number
}

/**
 * Build a valid 16-bit mono PCM WAV Blob of the given duration (silent).
 * Used when real audio is not yet available.
 */
function silentWav(durSec: number, sampleRate: number): Blob {
  const frames = Math.max(1, Math.floor(durSec * sampleRate))
  const dataLen = frames * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, dataLen, true)
  return new Blob([buf], { type: 'audio/wav' })
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function float32FromBlob(blob: Blob, sampleRate: number): Promise<Float32Array> {
  return blob.arrayBuffer().then((buf) => {
    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    return ctx.decodeAudioData(buf).then((decoded) => {
      // Downmix to mono
      const out = new Float32Array(decoded.length)
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch)
        const scale = 1 / decoded.numberOfChannels
        for (let i = 0; i < out.length; i++) out[i] += data[i] * scale
      }
      return out
    })
  })
}

/**
 * Export a single clip to disk (WAV or MP3).
 * Returns the codec actually written so the UI can inform the user.
 * If the clip has real recorded audio (T2 recorder), uses that; otherwise exports silence.
 */
export async function exportClipFile(opts: ExportOptions): Promise<ExportCodec> {
  const sampleRate = opts.sampleRate ?? 44100
  const safe = (opts.label || 'clip').replace(/[^\w.-]+/g, '_')
  const realBlob = opts.clipId ? clipAudio.get(opts.clipId) : undefined

  if (opts.codec === 'mp3') {
    try {
      const sourceBlob = realBlob ?? silentWav(opts.durSec, sampleRate)
      const samples = await float32FromBlob(sourceBlob, sampleRate)
      const mp3Blob = await encodeMp3(samples, sampleRate, opts.bitrate)
      download(mp3Blob, `${safe}.mp3`)
      return 'mp3'
    } catch (err) {
      console.warn('[exportClip] MP3 encoding failed, falling back to WAV:', err)
    }
  }

  const blob = realBlob ?? silentWav(opts.durSec, sampleRate)
  download(blob, `${safe}.wav`)
  return 'wav'
}

/**
 * T3 / mixdown: render all audible audio clips into a single WAV or MP3 file.
 * Returns the codec written.
 */
export async function exportMixdown(
  store: TimelineStoreApi,
  opts: { codec: ExportCodec; bitrate: number; label?: string },
): Promise<ExportCodec> {
  const safe = (opts.label || 'mixdown').replace(/[^\w.-]+/g, '_')
  const result = await renderMixdown(store)
  if (!result) {
    console.warn('[mixdown] no audio clips with data — exporting silence')
    const blob = silentWav(4, 44100)
    download(blob, `${safe}.wav`)
    return 'wav'
  }

  if (opts.codec === 'mp3') {
    try {
      const mp3Blob = await encodeMp3(result.samples, result.sampleRate, opts.bitrate)
      download(mp3Blob, `${safe}.mp3`)
      return 'mp3'
    } catch (err) {
      console.warn('[mixdown] MP3 encoding failed, falling back to WAV:', err)
    }
  }

  const wavBlob = encodeWavMono(result.samples, result.sampleRate)
  download(wavBlob, `${safe}.wav`)
  return 'wav'
}

/** Export project as JSON (tracks, clips, drum patterns, VST params). */
export async function exportProjectJson(store: TimelineStoreApi, name?: string): Promise<void> {
  return downloadProject(store, name)
}
