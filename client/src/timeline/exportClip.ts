import { clipAudio } from '../audio/recorder'

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
 *
 * Placeholder: clips don't carry captured audio yet, so we export silence of the
 * right length. This makes the export flow real/testable; real audio + MP3
 * encoding (ffmpeg-wasm/lamejs) land with the recording pipeline.
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

/**
 * Export a clip to disk. Returns the codec actually written ('wav' even when
 * 'mp3' was requested, until the MP3 encoder ships) so the UI can inform the user.
 * If the clip has real recorded audio (via T2 recorder), uses that; otherwise exports silence.
 */
export function exportClipFile(opts: ExportOptions): ExportCodec {
  const sampleRate = opts.sampleRate ?? 44100
  const safe = (opts.label || 'clip').replace(/[^\w.-]+/g, '_')
  const real = opts.clipId ? clipAudio.get(opts.clipId) : undefined
  const blob = real ?? silentWav(opts.durSec, sampleRate)
  // MP3 not encoded yet → write a .wav placeholder.
  download(blob, `${safe}.wav`)
  return 'wav'
}
