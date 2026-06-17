// Project export/import — serialises timeline + drum machine + VST chain params.
// Binary VST preset data is base64-encoded inside the JSON.
// Format version 1.
import * as Tone from 'tone'
import type { TimelineStoreApi } from './timelineStore'
import { drumMachine } from '../drumMachine/drumSingleton'
import { useInsertChainStore, targetKey, type InsertTarget } from '../audio/insertChainStore'

const FORMAT_VERSION = 1

export interface ProjectExportData {
  version: number
  bpm: number
  timeline: {
    tracks: ReturnType<TimelineStoreApi['getState']>['tracks']
    clips: ReturnType<TimelineStoreApi['getState']>['clips']
  }
  drumMachine: {
    patterns: ReturnType<typeof drumMachine.getPatternBank>
    swing: number
    activePatternIndex: number
    stepCount: number
  }
  vstChains: Record<string, Array<{
    uid: string
    path: string
    name: string
    bypass: boolean
    values: Record<number, number>
    presetData?: string  // base64-encoded ArrayBuffer
  }>>
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const raw = atob(b64)
  const buf = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buf
}

/** Serialise the full project state to JSON-ready object. */
export async function exportProject(store: TimelineStoreApi): Promise<ProjectExportData> {
  const tl = store.getState()
  const dm = drumMachine.getState()
  const bank = drumMachine.getPatternBank()
  const chainState = useInsertChainStore.getState()

  // Build VST chain export (capture preset states for all loaded slots)
  const vstChains: ProjectExportData['vstChains'] = {}
  for (const [key, slots] of Object.entries(chainState.chains)) {
    vstChains[key] = await Promise.all(slots.map(async (slot, idx) => {
      const sep = key.indexOf(':')
      const kind = sep >= 0 ? key.slice(0, sep) : 'channel'
      const id   = sep >= 0 ? key.slice(sep + 1) : '0'
      const target: InsertTarget = { kind: kind as 'channel' | 'track', id }

      // Capture latest preset state
      let b64: string | undefined
      try {
        const data = await useInsertChainStore.getState().capturePluginState(target, idx)
        if (data) b64 = arrayBufferToBase64(data)
      } catch { /* skip if not available */ }

      return {
        uid: slot.uid,
        path: slot.path,
        name: slot.name,
        bypass: slot.bypass,
        values: { ...slot.values },
        ...(b64 !== undefined ? { presetData: b64 } : {}),
      }
    }))
  }

  return {
    version: FORMAT_VERSION,
    bpm: Tone.getTransport().bpm.value,
    timeline: {
      // Omit peaks (large, re-derived) and proxy clips (transient network state)
      tracks: tl.tracks.map((t) => ({ ...t })),
      clips: tl.clips
        .filter((c) => !c.proxy)
        .map((c) => ({ ...c, peaks: undefined })),
    },
    drumMachine: {
      patterns: bank,
      swing: dm.swing,
      activePatternIndex: dm.activePatternIndex,
      stepCount: dm.stepCount,
    },
    vstChains,
  }
}

/** Serialise to JSON string and trigger browser download. */
export async function downloadProject(store: TimelineStoreApi, name = 'project'): Promise<void> {
  const data = await exportProject(store)
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[^\w.-]+/g, '_') || 'project'}.kgb.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { base64ToArrayBuffer }
