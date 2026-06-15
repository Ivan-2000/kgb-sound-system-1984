import { create } from 'zustand'

/**
 * panelStore — менеджер floating-окон (заменяет роль graphStore «какие панели
 * открыты + позиции/размеры/z/minimize»). ТОЛЬКО локальное состояние, без синка
 * между участниками: расстановка окон — личная.
 *
 * Никакой модели графа (ноды/порты/кабели/controlBus/реестр) здесь нет — это
 * сознательно. Граф удалён (см. REFACTOR_PLAN.md).
 */

export type PanelId =
  | 'mixer'
  | 'drum-machine'
  | 'timeline'
  | 'metronome'
  | 'chat'
  | 'video'
  | 'settings'

export interface PanelState {
  open: boolean
  pos: { x: number; y: number }
  size: { w: number; h: number }
  z: number
  minimized: boolean
}

/** Дефолтная расстановка (перенесено из старого graph/nodes/builtins.ts `defaults.panelPos/size`). */
const DEFAULTS: Record<PanelId, { pos: { x: number; y: number }; size: { w: number; h: number } }> = {
  mixer:          { pos: { x: 20,  y: 20  }, size: { w: 320, h: 360 } },
  'drum-machine': { pos: { x: 260, y: 60  }, size: { w: 520, h: 340 } },
  timeline:       { pos: { x: 40,  y: 420 }, size: { w: 560, h: 280 } },
  metronome:      { pos: { x: 320, y: 300 }, size: { w: 280, h: 200 } },
  chat:           { pos: { x: 800, y: 60  }, size: { w: 300, h: 400 } },
  video:          { pos: { x: 20,  y: 200 }, size: { w: 420, h: 300 } },
  settings:       { pos: { x: 420, y: 100 }, size: { w: 420, h: 520 } },
}

/** Метаданные заголовка панели (бывшие manifest.label / manifest.icon). */
export const PANEL_META: Record<PanelId, { label: string; icon: string }> = {
  mixer:          { label: 'Mixer',        icon: '🎚' },
  'drum-machine': { label: 'Drum Machine', icon: '🥁' },
  timeline:       { label: 'Timeline',     icon: '🎞' },
  metronome:      { label: 'Metronome',    icon: '🎵' },
  chat:           { label: 'Chat',         icon: '💬' },
  video:          { label: 'Video',        icon: '📹' },
  settings:       { label: 'Settings',     icon: '⚙' },
}

/** Порядок отрисовки / итерации панелей. */
export const PANEL_IDS = Object.keys(DEFAULTS) as PanelId[]

const BASE_Z = 100

function initialPanels(): Record<PanelId, PanelState> {
  const out = {} as Record<PanelId, PanelState>
  let z = BASE_Z
  for (const id of PANEL_IDS) {
    out[id] = {
      open: false,
      pos: { ...DEFAULTS[id].pos },
      size: { ...DEFAULTS[id].size },
      z: ++z,
      minimized: false,
    }
  }
  return out
}

const topZ = (panels: Record<PanelId, PanelState>): number =>
  Object.values(panels).reduce((m, p) => Math.max(m, p.z), BASE_Z)

interface PanelStore {
  panels: Record<PanelId, PanelState>
  focusedId: PanelId | null

  /** Показать панель (поднять наверх, снять minimize). */
  open: (id: PanelId) => void
  /** Скрыть панель (состояние позиции/размера сохраняется). */
  close: (id: PanelId) => void
  /** Открыть, если закрыта; закрыть, если открыта. */
  toggle: (id: PanelId) => void
  /** Поднять панель на передний план. */
  focus: (id: PanelId) => void
  move: (id: PanelId, pos: { x: number; y: number }) => void
  resize: (id: PanelId, size: { w: number; h: number }) => void
  toggleMinimize: (id: PanelId) => void
  /** Сброс при выходе из комнаты. */
  reset: () => void
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  panels: initialPanels(),
  focusedId: null,

  open: (id) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], open: true, minimized: false, z: topZ(s.panels) + 1 } },
      focusedId: id,
    })),

  close: (id) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], open: false } },
      focusedId: s.focusedId === id ? null : s.focusedId,
    })),

  toggle: (id) => {
    if (get().panels[id].open) get().close(id)
    else get().open(id)
  },

  focus: (id) =>
    set((s) => {
      // Уже сверху — не дёргаем состояние (избегаем лишних ре-рендеров при каждом клике).
      if (s.focusedId === id && s.panels[id].z === topZ(s.panels)) return s
      return {
        panels: { ...s.panels, [id]: { ...s.panels[id], z: topZ(s.panels) + 1 } },
        focusedId: id,
      }
    }),

  move: (id, pos) =>
    set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], pos } } })),

  resize: (id, size) =>
    set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], size } } })),

  toggleMinimize: (id) =>
    set((s) => ({ panels: { ...s.panels, [id]: { ...s.panels[id], minimized: !s.panels[id].minimized } } })),

  reset: () => set({ panels: initialPanels(), focusedId: null }),
}))
