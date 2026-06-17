// §9.D.1 — OPFS-backed PCM recorder worker.
// Runs in a Dedicated Web Worker where FileSystemSyncAccessHandle is available
// (synchronous, no microtask boundary) so audio chunks are written to disk
// without blocking the renderer's event loop.
//
// Protocol (postMessage):
//   { kind: 'start',  clipId: string }
//   { kind: 'chunk',  clipId: string, pcm: Int16Array }   ← Transferable buffer
//   { kind: 'stop',   clipId: string, sampleRate: number }
//   → responds { kind: 'done', clipId, wav: ArrayBuffer } | { kind: 'error', clipId, error }

interface StartMsg  { kind: 'start';  clipId: string }
interface ChunkMsg  { kind: 'chunk';  clipId: string; pcm: Int16Array }
interface StopMsg   { kind: 'stop';   clipId: string; sampleRate: number }
type InMsg = StartMsg | ChunkMsg | StopMsg

interface FileEntry {
  handle: FileSystemSyncAccessHandle
  offset: number  // current write position in bytes
}

const files = new Map<string, FileEntry>()

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function openEntry(clipId: string): Promise<FileEntry> {
  const root = await getOpfsRoot()
  const fh = await root.getFileHandle(`rec-${clipId}.pcm`, { create: true })
  const sh = await fh.createSyncAccessHandle()
  sh.truncate(0)
  return { handle: sh, offset: 0 }
}

async function closeEntry(clipId: string, sampleRate: number): Promise<ArrayBuffer> {
  const entry = files.get(clipId)
  if (!entry) throw new Error(`no active recording for ${clipId}`)
  files.delete(clipId)

  const byteLen = entry.offset
  entry.handle.close()

  // Re-open for reading
  const root = await getOpfsRoot()
  const fh = await root.getFileHandle(`rec-${clipId}.pcm`)
  const file = await fh.getFile()
  const raw = await file.arrayBuffer()

  // Clean up temp file
  try { await root.removeEntry(`rec-${clipId}.pcm`) } catch { /* ignore */ }

  // raw contains Int16 mono PCM; encode as WAV
  const n = raw.byteLength / 2  // number of samples
  const wav = new ArrayBuffer(44 + byteLen)
  const v = new DataView(wav)
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  wr(0, 'RIFF'); v.setUint32(4, 36 + byteLen, true); wr(8, 'WAVE')
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  wr(36, 'data'); v.setUint32(40, byteLen, true)
  new Uint8Array(wav, 44).set(new Uint8Array(raw, 0, byteLen))
  return wav
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.kind === 'start') {
    openEntry(msg.clipId).then((entry) => {
      files.set(msg.clipId, entry)
    }).catch((err) => {
      self.postMessage({ kind: 'error', clipId: msg.clipId, error: String(err) })
    })
    return
  }

  if (msg.kind === 'chunk') {
    const entry = files.get(msg.clipId)
    if (!entry) return  // not yet open — drop chunk (race during start)
    const written = entry.handle.write(msg.pcm.buffer, { at: entry.offset })
    entry.offset += written
    return
  }

  if (msg.kind === 'stop') {
    closeEntry(msg.clipId, msg.sampleRate).then((wav) => {
      self.postMessage({ kind: 'done', clipId: msg.clipId, wav }, [wav])
    }).catch((err) => {
      self.postMessage({ kind: 'error', clipId: msg.clipId, error: String(err) })
    })
  }
}
