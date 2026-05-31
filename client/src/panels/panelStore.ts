import { create } from 'zustand'

export type PanelType = 'mixer' | 'drum-machine' | 'chat' | 'video' | 'metronome' | 'settings'

export interface PanelState {
  id: string
  type: PanelType
  position: { x: number; y: number }
  size: { w: number; h: number }
  zIndex: number
  isOpen: boolean
  isMinimized: boolean
}

export type ViewMode = 'panels' | 'canvas'

interface PanelStore {
  panels: PanelState[]
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  openPanel: (type: PanelType) => void
  /** Create a panel entry in closed state — mounts component (preserves subscriptions) without showing the UI */
  preloadPanel: (type: PanelType) => void
  closePanel: (id: string) => void
  focusPanel: (id: string) => void
  movePanel: (id: string, pos: { x: number; y: number }) => void
  resizePanel: (id: string, size: { w: number; h: number }) => void
  minimizePanel: (id: string) => void
}

const SINGLETON_TYPES = new Set<PanelType>(['mixer', 'drum-machine', 'chat', 'video', 'metronome', 'settings'])

const DEFAULT_POSITIONS: Record<PanelType, { x: number; y: number }> = {
  mixer:          { x: 20,  y: 60 },
  'drum-machine': { x: 260, y: 60 },
  chat:           { x: 800, y: 60 },
  video:          { x: 20,  y: 200 },
  metronome:      { x: 320, y: 300 },
  settings:       { x: 420, y: 100 },
}

const DEFAULT_SIZES: Record<PanelType, { w: number; h: number }> = {
  mixer:          { w: 320, h: 480 },
  'drum-machine': { w: 520, h: 340 },
  chat:           { w: 300, h: 400 },
  video:          { w: 420, h: 300 },
  metronome:      { w: 280, h: 200 },
  settings:       { w: 420, h: 520 },
}

const BASE_Z = 100
let idCounter = 0
const nextId = (): string => `panel-${(++idCounter).toString()}`

export const usePanelStore = create<PanelStore>((set, get) => ({
  panels: [],
  viewMode: 'panels',

  setViewMode(mode) {
    set({ viewMode: mode })
  },

  preloadPanel(type) {
    if (get().panels.some((p) => p.type === type)) return
    const maxZ = get().panels.reduce((m, p) => Math.max(m, p.zIndex), BASE_Z)
    set((s) => ({
      panels: [...s.panels, {
        id: nextId(),
        type,
        position: DEFAULT_POSITIONS[type],
        size: DEFAULT_SIZES[type],
        zIndex: maxZ + 1,
        isOpen: false,
        isMinimized: false,
      }],
    }))
  },

  openPanel(type) {
    const { panels } = get()

    if (SINGLETON_TYPES.has(type)) {
      const existing = panels.find((p) => p.type === type)
      if (existing) {
        if (!existing.isOpen) {
          set((s) => ({
            panels: s.panels.map((p) =>
              p.id === existing.id ? { ...p, isOpen: true, isMinimized: false } : p,
            ),
          }))
        }
        get().focusPanel(existing.id)
        return
      }
    }

    const maxZ = panels.reduce((m, p) => Math.max(m, p.zIndex), BASE_Z)
    const panel: PanelState = {
      id: nextId(),
      type,
      position: DEFAULT_POSITIONS[type],
      size: DEFAULT_SIZES[type],
      zIndex: maxZ + 1,
      isOpen: true,
      isMinimized: false,
    }
    set((s) => ({ panels: [...s.panels, panel] }))
  },

  closePanel(id) {
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, isOpen: false } : p)),
    }))
  },

  focusPanel(id) {
    const maxZ = get().panels.reduce((m, p) => Math.max(m, p.zIndex), BASE_Z)
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, zIndex: maxZ + 1 } : p)),
    }))
  },

  movePanel(id, pos) {
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, position: pos } : p)),
    }))
  },

  resizePanel(id, size) {
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, size } : p)),
    }))
  },

  minimizePanel(id) {
    set((s) => ({
      panels: s.panels.map((p) =>
        p.id === id ? { ...p, isMinimized: !p.isMinimized } : p,
      ),
    }))
  },
}))
