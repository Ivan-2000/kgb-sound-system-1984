// T3 — MP3 encoding in a background worker using lamejs (pure-JS LAME port).
// Receives { samples: Float32Array, sampleRate: number, bitrate: number }
// Posts back { mp3: ArrayBuffer } on success or { error: string } on failure.
import { Mp3Encoder } from 'lamejs'

const CHUNK = 1152 // lamejs block size (one MP3 frame worth of samples)

function float32ToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number; bitrate: number }>) => {
  const { samples, sampleRate, bitrate } = e.data
  try {
    const encoder = new Mp3Encoder(1, sampleRate, bitrate)
    const pcm = float32ToInt16(samples)
    const chunks: Int16Array[] = []

    for (let offset = 0; offset < pcm.length; offset += CHUNK) {
      const block = pcm.subarray(offset, offset + CHUNK)
      const chunk = encoder.encodeBuffer(block)
      if (chunk.length > 0) chunks.push(new Int16Array(chunk))
    }
    const tail = encoder.flush()
    if (tail.length > 0) chunks.push(new Int16Array(tail))

    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const mp3 = new Uint8Array(totalLen * 2)
    let pos = 0
    for (const chunk of chunks) {
      mp3.set(new Uint8Array(chunk.buffer), pos)
      pos += chunk.byteLength
    }
    self.postMessage({ mp3: mp3.buffer }, [mp3.buffer])
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
