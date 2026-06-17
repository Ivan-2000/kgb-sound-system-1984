import { create } from 'zustand'

/**
 * insertChainStore — runtime data model for VST3 insert chains (V3).
 *
 * Logic only, no UI (Engine track owns this file; nik's InsertChain panel —
 * V5/V7 — reads this store and calls its actions). It mirrors the native host:
 * each insert is a plugin loaded into an addon "slot", and a target (mixer
 * channel or timeline track) owns an ordered list of slots.
 *
 * Contract surface (agreed with nik, see AGENTS.md): this store's shape +
 * `window.nativeAudio.vst.*`. Persisted plugin identity is the class `uid`
 * (binary preset state is V9); a missing plugin on another machine surfaces as
 * an "unavailable" insert (warning), not a crash.
 *
 * NOTE on routing: the V1/V3 native host applies ONE global input-side chain
 * (`vst.setInsertChain`). Per-target routing (a chain per channel / per track,
 * applied at distinct points in the RT callback) is V6/E2. Until then the store
 * tracks every target's chain but only the `activeInputTarget` is pushed to the
 * engine. Switching the active target re-pushes that target's slot order.
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
}

export interface InsertChainState {
  /** Last scan result — the palette of installed plugins. */
  available: VstPluginInfo[]
  scanning: boolean
  scanError: string | null
  /** Whether the running addon was built with the VST host (build:vst). */
  vstAvailable: boolean

  /** Ordered insert lists keyed by targetKey(target). */
  chains: Record<string, InsertSlot[]>
  /** The target whose chain is currently applied to the native input path. */
  activeInputTarget: InsertTarget | null

  /** Default processing format new plugins are loaded with. Kept in sync with
   *  the open audio stream by nativeAudioController (Engine track). */
  sampleRate: number
  maxBlockSize: number
  setFormat(sampleRate: number, maxBlockSize: number): void

  scan(paths?: string[]): Promise<void>
  addInsert(target: InsertTarget, plugin: { path: string; uid?: string }): Promise<InsertSlot | null>
  removeInsert(target: InsertTarget, index: number): Promise<void>
  moveInsert(target: InsertTarget, from: number, to: number): Promise<void>
  setBypass(target: InsertTarget, index: number, bypass: boolean): void
  setParam(target: InsertTarget, index: number, paramId: number, value: number): Promise<void>
  setActiveInputTarget(target: InsertTarget | null): Promise<void>
  /** Drop every loaded plugin (e.g. on stream teardown / engine crash). */
  clearAll(): Promise<void>
}

export const targetKey = (t: InsertTarget): string => `${t.kind}:${t.id}`

const vst = () => (typeof window !== 'undefined' ? window.nativeAudio?.vst : undefined)

export const useInsertChainStore = create<InsertChainState>((set, get) => {
  /** Push the active target's non-bypassed... (bypass is handled natively per
   *  slot, so push every loaded slotId in order) to the engine. */
  const syncActiveChain = async (): Promise<void> => {
    const v = vst()
    if (!v) return
    const t = get().activeInputTarget
    const slots = t ? (get().chains[targetKey(t)] ?? []) : []
    await v.setInsertChain(slots.map((s) => s.slotId))
  }

  return {
    available: [],
    scanning: false,
    scanError: null,
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
      if (!res.ok) { set({ scanError: res.error ?? 'load failed' }); return null }

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
      set((s) => ({ chains: { ...s.chains, [key]: [...(s.chains[key] ?? []), slot] } }))
      await syncActiveChain()
      return slot
    },

    async removeInsert(target, index) {
      const v = vst()
      const key = targetKey(target)
      const chain = get().chains[key] ?? []
      const slot = chain[index]
      if (!slot) return
      set((s) => ({ chains: { ...s.chains, [key]: chain.filter((_, i) => i !== index) } }))
      await syncActiveChain()          // stop referencing the slot before unloading
      if (v) await v.unload(slot.slotId)
    },

    async moveInsert(target, from, to) {
      const key = targetKey(target)
      const chain = [...(get().chains[key] ?? [])]
      if (from < 0 || from >= chain.length || to < 0 || to >= chain.length) return
      const [moved] = chain.splice(from, 1)
      chain.splice(to, 0, moved)
      set((s) => ({ chains: { ...s.chains, [key]: chain } }))
      await syncActiveChain()
    },

    setBypass(target, index, bypass) {
      const key = targetKey(target)
      const chain = get().chains[key] ?? []
      if (!chain[index]) return
      // Native per-slot bypass is wired in V6; for now bypass is reflected in the
      // model and (V6) will toggle the slot in the native chain.
      set((s) => ({
        chains: {
          ...s.chains,
          [key]: chain.map((sl, i) => (i === index ? { ...sl, bypass } : sl)),
        },
      }))
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
          [key]: chain.map((sl, i) =>
            i === index ? { ...sl, values: { ...sl.values, [paramId]: clamped } } : sl,
          ),
        },
      }))
      if (v) await v.setParam(slot.slotId, paramId, clamped)
    },

    async setActiveInputTarget(target) {
      set({ activeInputTarget: target })
      await syncActiveChain()
    },

    async clearAll() {
      const v = vst()
      const all = Object.values(get().chains).flat()
      set({ chains: {}, activeInputTarget: null })
      if (v) {
        await v.setInsertChain([])
        for (const slot of all) await v.unload(slot.slotId)
      }
    },
  }
})
