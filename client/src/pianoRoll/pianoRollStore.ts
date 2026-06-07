import { create } from 'zustand'

/**
 * Piano Roll model — FL-style note editor (node #5).
 *
 * The Piano Roll is a STANDALONE MIDI source: it holds a grid of notes and, on
 * transport playback, emits {@link NoteEvent}s on its `notesOut` port (wired in
 * `pianoRollNode`). It carries no voice of its own — cable `notesOut` into any
 * `midi`-in (Drum Kit, Sampler, …) to hear it. LOCAL state for now (per-room
 * sync follows the timeline/graph sync work). See [[node-spec]].
 *
 * Time is measured in 16th-note STEPS. `stepsPerBar` is 16 (4/4); `bars` sets
 * the loop length. Playback derives the current step from the shared transport
 * clock, so every client stays phase-aligned from the same BPM.
 */

export interface PianoNote {
  id: string
  /** MIDI pitch 0–127. */
  pitch: number
  /** Start position in 16th-note steps from the loop origin. */
  startStep: number
  /** Length in 16th-note steps (≥ 1). */
  lengthSteps: number
  /** Velocity 1–127. */
  velocity: number
}

export const STEPS_PER_BAR = 16 // 4/4, sixteenth-note grid
export const DEFAULT_VELOCITY = 100

interface PianoRollState {
  notes: PianoNote[]
  bars: number
  selectedId: string | null

  addNote: (note: Omit<PianoNote, 'id'>) => string
  moveNote: (id: string, startStep: number, pitch: number) => void
  resizeNote: (id: string, lengthSteps: number) => void
  setVelocity: (id: string, velocity: number) => void
  removeNote: (id: string) => void
  select: (id: string | null) => void
  setBars: (bars: number) => void
  clear: () => void
}

let counter = 0
const nextId = (): string => `pn-${(++counter).toString(36)}`

export const usePianoRollStore = create<PianoRollState>((set) => ({
  notes: [],
  bars: 1,
  selectedId: null,

  addNote(note) {
    const id = nextId()
    set((s) => ({ notes: [...s.notes, { ...note, id }], selectedId: id }))
    return id
  },

  moveNote(id, startStep, pitch) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === id
          ? { ...n, startStep: Math.max(0, Math.round(startStep)), pitch: Math.min(127, Math.max(0, Math.round(pitch))) }
          : n,
      ),
    }))
  },

  resizeNote(id, lengthSteps) {
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, lengthSteps: Math.max(1, Math.round(lengthSteps)) } : n)),
    }))
  },

  setVelocity(id, velocity) {
    const v = Math.min(127, Math.max(1, Math.round(velocity)))
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, velocity: v } : n)) }))
  },

  removeNote(id) {
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
  },

  select(id) {
    set({ selectedId: id })
  },

  setBars(bars) {
    set({ bars: Math.min(8, Math.max(1, Math.round(bars))) })
  },

  clear() {
    set({ notes: [], selectedId: null })
  },
}))
