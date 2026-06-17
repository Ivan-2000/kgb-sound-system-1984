import { create } from 'zustand'

/**
 * insertChainStore — runtime data model for VST3 insert chains.
 *
 * V6 (E2): each insert target has its own native chain, applied in-order by the
 * RT callback. 'channel' targets map to physical input channels (id = channel
 * index as string); 'track' targets are wired in I1/E4 (playback only).
 *
 * Contract surface (agreed with nik, AGENTS.md): this store shape +
 * `window.nativeAudio.vst.*`.
 */

export type InsertTargetKind = 'channel' | 'track'

export interface InsertTarget {
  kind: InsertTargetKind
  id: string
}

/** One loaded plugin in a chain. `slotId` is the native runtime slot. */
export interface InsertSlot {
  slotId: number
  uid: string
  path: string
  name: string
  vendor: string
  type: VstPluginType
  bypass: boolean
  params: VstParamDesc[]
  /** Current normalized values by paramId (sparse — only edited params). */
  values: Record<number, number>
  numInputChannels: number
  numOutputChannels: number
  /** V9: last saved binary preset (null = not yet fetched). */
  presetData?: ArrayBuffer | null
}

export interface InsertChainState {
  /** Last scan result — the palette of installed plugins. */
  available: VstPluginInfo[]
  scanning: boolean
  scanError: string | null
  /** Last error from addInsert/removeInsert/moveInsert (null = no error). */
  insertError: string | null
  /** Whether the running addon was built with the VST host (build:vst). */
  vstAvailable: boolean

  /** Ordered insert lists keyed by targetKey(target). */
  chains: Record<string, InsertSlot[]>

  /** @deprecated V1 kludge replaced by per-channel chains in V6. */
  activeInputTarget: InsertTarget | null

  /** Default processing format new plugins are loaded with. */
  sampleRate: number
  maxBlockSize: number
  setFormat(sampleRate: number, maxBlockSize: number): void

  scan(paths?: string[]): Promise<void>
  addInsert(target: InsertTarget, plugin: { path: string; uid?: string }): Promise<InsertSlot | null>
  removeInsert(target: InsertTarget, index: number): Promise<void>
  moveInsert(target: InsertTarget, from: number, to: number): Promise<void>
  setBypass(target: InsertTarget, index: number, bypass: boolean): void
  setParam(target: InsertTarget, index: number, paramId: number, value: number): Promise<void>
  /** V4: open/close the plugin's native editor window. */
  openEditor(target: InsertTarget, index: number): Promise<boolean>
  closeEditor(target: InsertTarget, index: number): Promise<void>
  /** V9: fetch and cache the binary preset of a slot; returns null on failure. */
  capturePluginState(target: InsertTarget, index: number): Promise<ArrayBuffer | null>
  /** V9: restore a slot from a previously captured preset. */
  restorePluginState(target: InsertTarget, index: number, data: ArrayBuffer): Promise<boolean>
  /** V10: re-push all 'channel' chains to the native side (call after engine respawn). */
  resyncAllChains(): Promise<void>
  /** Drop every loaded plugin (e.g. on stream teardown / engine crash). */
  clearAll(): Promise<void>

  /** @deprecated Use insertChainStore channel targets directly. No-op in V6. */
  setActiveInputTarget(target: InsertTarget | null): Promise<void>
}

export const targetKey = (t: InsertTarget): string => `${t.kind}:${t.id}`

const vst = () => (typeof window !== 'undefined' ? window.nativeAudio?.vst : undefined)

/** Push one 'channel' target's non-bypassed slots to the native per-channel chain. */
async function syncChannelChain(target: InsertTarget, chains: Record<string, InsertSlot[]>): Promise<void> {
  const v = vst()
  if (!v || target.kind !== 'channel') return
  const chIdx = parseInt(target.id, 10)
  if (!Number.isFinite(chIdx) || chIdx < 0) return
  const slots = chains[targetKey(target)] ?? []
  await v.setChannelChain(chIdx, slots.filter((s) => !s.bypass).map((s) => s.slotId))
}

/** Deterministic 31-bit integer from a string id (for native track chain map key). */
function stableIntId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) >>> 0
  return h >>> 1
}

/** I1: push one 'track' target's non-bypassed slots to the native per-track chain. */
async function syncTrackChain(target: InsertTarget, chains: Record<string, InsertSlot[]>): Promise<void> {
  const v = vst()
  if (!v || target.kind !== 'track') return
  const slots = chains[targetKey(target)] ?? []
  await v.setTrackChain(stableIntId(target.id), slots.filter((s) => !s.bypass).map((s) => s.slotId))
}

/** Sync any target kind to native. */
async function syncChain(target: InsertTarget, chains: Record<string, InsertSlot[]>): Promise<void> {
  if (target.kind === 'channel') return syncChannelChain(target, chains)
  if (target.kind === 'track') return syncTrackChain(target, chains)
}

export const useInsertChainStore = create<InsertChainState>((set, get) => ({
  available: [],
  scanning: false,
  scanError: null,
  insertError: null,
  vstAvailable: false,
  chains: {},
  activeInputTarget: null,
  sampleRate: 48000,
  maxBlockSize: 512,

  setFormat(sampleRate, maxBlockSize) {
    set({ sampleRate, maxBlockSize })
  },

  async scan(paths) {
    const v = vst()
    if (!v) { set({ vstAvailable: false, scanError: 'VST host not built' }); return }
    set({ scanning: true, scanError: null })
    const res = await v.scan(paths)
    if (res.ok) set({ available: res.plugins ?? [], vstAvailable: true, scanning: false })
    else set({ scanning: false, vstAvailable: false, scanError: res.error ?? 'scan failed' })
  },

  async addInsert(target, plugin) {
    const v = vst()
    if (!v) return null
    const { sampleRate, maxBlockSize } = get()
    const res = await v.load({
      path: plugin.path,
      classUid: plugin.uid ?? '',
      sampleRate,
      maxBlockSize,
      slotId: -1,
    })
    if (!res.ok) { set({ insertError: res.error ?? 'load failed' }); return null }

    const slot: InsertSlot = {
      slotId: res.slotId,
      uid: res.uid,
      path: plugin.path,
      name: res.name,
      vendor: res.vendor,
      type: res.type,
      bypass: false,
      params: res.params,
      values: {},
      numInputChannels: res.numInputChannels,
      numOutputChannels: res.numOutputChannels,
    }
    const key = targetKey(target)
    const newChains = { ...get().chains, [key]: [...(get().chains[key] ?? []), slot] }
    set({ chains: newChains })
    await syncChain(target, newChains)
    return slot
  },

  async removeInsert(target, index) {
    const v = vst()
    const key = targetKey(target)
    const chain = get().chains[key] ?? []
    const slot = chain[index]
    if (!slot) return
    const newChain = chain.filter((_, i) => i !== index)
    const newChains = { ...get().chains, [key]: newChain }
    set({ chains: newChains })
    // Push updated chain before unloading so the RT callback stops using the slot.
    await syncChain(target, newChains)
    if (v) await v.unload(slot.slotId)
  },

  async moveInsert(target, from, to) {
    const key = targetKey(target)
    const chain = [...(get().chains[key] ?? [])]
    if (from < 0 || from >= chain.length || to < 0 || to >= chain.length) return
    const [moved] = chain.splice(from, 1)
    chain.splice(to, 0, moved)
    const newChains = { ...get().chains, [key]: chain }
    set({ chains: newChains })
    await syncChain(target, newChains)
  },

  setBypass(target, index, bypass) {
    const key = targetKey(target)
    const chain = get().chains[key] ?? []
    if (!chain[index]) return
    const newChains = {
      ...get().chains,
      [key]: chain.map((sl, i) => (i === index ? { ...sl, bypass } : sl)),
    }
    set({ chains: newChains })
    // V6: bypass wiring — exclude bypassed slots from the native chain list.
    void syncChain(target, newChains)
  },

  async setParam(target, index, paramId, value) {
    const v = vst()
    const key = targetKey(target)
    const chain = get().chains[key] ?? []
    const slot = chain[index]
    if (!slot) return
    const clamped = value < 0 ? 0 : value > 1 ? 1 : value
    set((s) => ({
      chains: {
        ...s.chains,
        [key]: (s.chains[key] ?? []).map((sl, i) =>
          i === index ? { ...sl, values: { ...sl.values, [paramId]: clamped } } : sl,
        ),
      },
    }))
    if (v) await v.setParam(slot.slotId, paramId, clamped)
  },

  async openEditor(target, index) {
    const v = vst()
    const slot = (get().chains[targetKey(target)] ?? [])[index]
    if (!v || !slot) return false
    const res = await v.openEditor(slot.slotId)
    return !!res.ok
  },

  async closeEditor(target, index) {
    const v = vst()
    const slot = (get().chains[targetKey(target)] ?? [])[index]
    if (v && slot) await v.closeEditor(slot.slotId)
  },

  async capturePluginState(target, index) {
    const v = vst()
    const key = targetKey(target)
    const slot = (get().chains[key] ?? [])[index]
    if (!v || !slot) return null
    const res = await v.getState(slot.slotId)
    if (!res.ok || !res.data) return null
    // Cache in store
    set((s) => ({
      chains: {
        ...s.chains,
        [key]: (s.chains[key] ?? []).map((sl, i) =>
          i === index ? { ...sl, presetData: res.data } : sl,
        ),
      },
    }))
    return res.data
  },

  async restorePluginState(target, index, data) {
    const v = vst()
    const key = targetKey(target)
    const slot = (get().chains[key] ?? [])[index]
    if (!v || !slot) return false
    const res = await v.setState(slot.slotId, data)
    if (res.ok) {
      set((s) => ({
        chains: {
          ...s.chains,
          [key]: (s.chains[key] ?? []).map((sl, i) =>
            i === index ? { ...sl, presetData: data } : sl,
          ),
        },
      }))
    }
    return !!res.ok
  },

  async resyncAllChains() {
    const v = vst()
    if (!v) return
    const chains = get().chains
    for (const [key, slots] of Object.entries(chains)) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const kind = key.slice(0, sep) as InsertTargetKind
      const id   = key.slice(sep + 1)
      const activeSlots = slots.filter((s) => !s.bypass).map((s) => s.slotId)
      if (kind === 'channel') {
        const chIdx = parseInt(id, 10)
        if (!Number.isFinite(chIdx) || chIdx < 0) continue
        await v.setChannelChain(chIdx, activeSlots)
      } else if (kind === 'track') {
        await v.setTrackChain(stableIntId(id), activeSlots)
      }
    }
  },

  async clearAll() {
    const v = vst()
    const all = Object.values(get().chains).flat()
    const chains = get().chains
    set({ chains: {}, activeInputTarget: null })
    if (v) {
      // Clear all channel chains on native side first, then unload plugins.
      for (const key of Object.keys(chains)) {
        const sep = key.indexOf(':')
        if (sep < 0) continue
        if (key.slice(0, sep) === 'channel') {
          const chIdx = parseInt(key.slice(sep + 1), 10)
          if (Number.isFinite(chIdx)) await v.setChannelChain(chIdx, [])
        }
      }
      await v.setInsertChain([])
      for (const slot of all) await v.unload(slot.slotId)
    }
  },

  /** @deprecated No-op in V6 — per-channel chains are always active. */
  async setActiveInputTarget(_target) {
    // intentional no-op
  },
}))
