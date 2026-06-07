import { defineNode } from '../defineNode'
import type { NodeDefinition } from '../types'
import { drumMachineNode } from '../../drumMachine/drumMachineNode'
import { timelineNode } from '../../timeline/timelineNode'
// pianoRollNode is NOT registered (PR4, pivot 2026-06-06). Piano Roll becomes
// a per-clip editor opened from the Timeline (Phase 3 PR3), not a standalone node.
// The module stays in pianoRoll/ and is reused by PR1–PR3.

/**
 * Built-in node definitions (G2/G3).
 *
 * These wrap the existing engines (metronome, drum machine, mixer, chat, video,
 * settings). Their `create()` is thin and `render()` returns null: the actual
 * React UI for built-ins is supplied by App.tsx's panel content map (keyed by
 * type) during the migration. Third-party nodes return their own UI from
 * `render()`.
 *
 * What matters here is the MANIFEST — PORTS define the cabling vocabulary
 * (Canvas G4, audio routing G5); `defaults` carry the panel placement that used
 * to live in panelStore; `local: true` marks personal (non-synced) nodes.
 * Params stay empty for built-ins: engine state (BPM, pattern, volume…) keeps
 * its existing dedicated room-sync path (see TASKS_UI.md).
 */

const thin = () => ({ render: () => null, dispose: () => {} })
const COMMON = { version: '1.0.0', author: 'KGB Sound', singleton: true } as const

export const metronomeNode: NodeDefinition = defineNode({
  manifest: {
    ...COMMON,
    type: 'metronome',
    label: 'Metronome',
    icon: '🎵',
    description: 'Клик и тайм-сигнатура комнаты',
    ports: [
      { id: 'beat', label: 'Beat', kind: 'trigger', direction: 'out' },
      { id: 'downbeat', label: 'Downbeat', kind: 'trigger', direction: 'out' },
      { id: 'bpm', label: 'BPM', kind: 'value', direction: 'out' },
    ],
    params: [],
    defaults: { panelPos: { x: 320, y: 300 }, canvasPos: { x: 440, y: 560 }, size: { w: 280, h: 200 } },
  },
  create: thin,
})

// drumMachineNode now lives in ../../drumMachine/drumMachineNode (it owns a
// per-node DrumMachine engine + its own UI), imported above and listed below.

export const mixerNode: NodeDefinition = defineNode({
  manifest: {
    ...COMMON,
    type: 'mixer',
    label: 'Mixer',
    icon: '🎚',
    description: 'Каналы участников и уровни',
    ports: [
      { id: 'audioIn', label: 'Audio In', kind: 'audio', direction: 'in', multiple: true },
      { id: 'audioOut', label: 'Master Out', kind: 'audio', direction: 'out' },
    ],
    params: [],
    defaults: { panelPos: { x: 20, y: 20 }, canvasPos: { x: 40, y: 40 }, size: { w: 320, h: 360 } },
  },
  create: thin,
})

export const chatNode: NodeDefinition = defineNode({
  manifest: {
    ...COMMON,
    type: 'chat',
    label: 'Chat',
    icon: '💬',
    description: 'Чат комнаты',
    ports: [
      { id: 'message', label: 'Message', kind: 'value', direction: 'out' },
    ],
    params: [],
    defaults: { panelPos: { x: 800, y: 60 }, canvasPos: { x: 1540, y: 40 }, size: { w: 300, h: 400 } },
  },
  create: thin,
})

export const videoNode: NodeDefinition = defineNode({
  manifest: {
    ...COMMON,
    type: 'video',
    label: 'Video',
    icon: '📹',
    description: 'Видео участников',
    ports: [],
    params: [],
    defaults: { panelPos: { x: 20, y: 200 }, canvasPos: { x: 1540, y: 480 }, size: { w: 420, h: 300 } },
  },
  create: thin,
})

export const settingsNode: NodeDefinition = defineNode({
  manifest: {
    ...COMMON,
    type: 'settings',
    label: 'Settings',
    icon: '⚙',
    description: 'Аудиоустройство и настройки',
    // Personal: audio-device binding is local hardware — never synced to the room.
    local: true,
    ports: [],
    params: [],
    defaults: { panelPos: { x: 420, y: 100 }, canvasPos: { x: 2000, y: 40 }, size: { w: 420, h: 520 } },
  },
  create: thin,
})

// timelineNode now lives in ../../timeline/timelineNode (per-node store + UI),
// imported above and listed below.

export const BUILTIN_NODES: NodeDefinition[] = [
  mixerNode,
  drumMachineNode,
  metronomeNode,
  timelineNode,
  chatNode,
  videoNode,
  settingsNode,
]
