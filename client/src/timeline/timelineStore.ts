import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { PianoNote } from '../pianoRoll/pianoRollStore'

/**
 * Timeline model.
 *
 * Tracks hold clips positioned in seconds. The mixer's Record button creates a
 * track + a proxy clip; real native capture → audio data (and per-room sync of
 * the recorded file) lands later. LOCAL state for now — timeline sync follows the
 * recording model.
 *
 * One primary timeline per session: the singleton lives in `timelineSingleton.ts`
 * (`timelineStore`), imported directly by App / sync / the Mixer's Record button.
 */

export type TrackKind = 'audio' | 'midi'

export interface TimelineTrack {
  id: string
  name: string
  kind: TrackKind
  /** Source color (CSS), used to tint the track's clips. */
  color?: string
  muted?: boolean
  solo?: boolean
  /** Mixer arm key (e.g. 'local:0') — set only for locally-created audio tracks.
   *  Used by the Timeline's per-track Record button to arm/disarm the right channel. */
  armKey?: string
}

export interface TimelineClip {
  id: string
  trackId: string
  startSec: number
  durSec: number
  label: string
  kind: TrackKind
  /** True while the recorded file is not yet available (placeholder block). */
  proxy?: boolean
  /** MIDI notes stored in this clip (kind === 'midi'). PR1. */
  notes?: PianoNote[]
  /** Piano Roll bar count for this clip's editor view. */
  clipBars?: number
  /** Waveform |peak| bins (0..1, ~50/sec) — drawn over audio clips; grows live
   *  while the clip is being recorded. Local-only, not synced to peers. */
  peaks?: number[]
}

type ClipboardClip = { durSec: number; label: string; kind: TrackKind; notes?: PianoNote[]; clipBars?: number }

interface TimelineState {
  tracks: TimelineTrack[]
  clips: TimelineClip[]
  selectedIds: string[]
  clipboard: ClipboardClip | null
  loopStart: number | null
  loopEnd: number | null

  addTrack: (track: Omit<TimelineTrack, 'id'>) => string
  removeTrack: (id: string) => void
  addClip: (clip: Omit<TimelineClip, 'id'>) => string
  addClipWithId: (clip: TimelineClip) => void
  updateClip: (id: string, patch: Partial<Omit<TimelineClip, 'id' | 'trackId'>>) => void
  setClipNotes: (id: string, notes: PianoNote[], bars?: number) => void
  removeClip: (id: string) => void
  ensureTrack: (key: string, track: Omit<TimelineTrack, 'id'>) => string
  clear: () => void

  toggleTrackMute: (id: string) => void
  toggleTrackSolo: (id: string) => void
  /** Replace selection with a single clip (null clears). */
  select: (id: string | null) => void
  /** Shift-click: add to selection. */
  addSelect: (id: string) => void
  /** Ctrl/Cmd-click: toggle membership. */
  toggleSelect: (id: string) => void
  /** Rubber-band: replace selection with these ids. */
  setSelection: (ids: string[]) => void
  clearSelection: () => void
  splitClip: (id: string, atSec: number) => void
  copyClip: (id: string) => void
  pasteClip: (trackId: string, atSec: number) => string | null
  duplicateClip: (id: string) => string | null
  removeGaps: (trackId: string) => void
  moveClipToTrack: (id: string, trackId: string) => void
  addMidiClip: (atSec?: number, notes?: PianoNote[], clipBars?: number) => void

  setLoop: (start: number, end: number) => void
  clearLoop: () => void

  // ── Gap tools ──
  /** Close the single gap that `atSec` falls into (shift the next clip + rest left). */
  closeGapAt: (trackId: string, atSec: number) => void
  /** Pack all clips on a track flush, starting from the earliest clip. */
  packFromFirst: (trackId: string) => void

  // ── Undo / Redo ──
  past: Snapshot[]
  future: Snapshot[]
  /** Capture current state as one undo step (call before a mutating gesture). */
  pushHistory: () => void
  undo: () => void
  redo: () => void
}

type Snapshot = { tracks: TimelineTrack[]; clips: TimelineClip[]; selectedIds: string[] }
const HISTORY_MAX = 60
const snap = (s: { tracks: TimelineTrack[]; clips: TimelineClip[]; selectedIds: string[] }): Snapshot => ({
  tracks: s.tracks.map((t) => ({ ...t })),
  clips: s.clips.map((c) => ({ ...c, notes: c.notes ? c.notes.map((n) => ({ ...n })) : undefined })),
  selectedIds: [...s.selectedIds],
})

export type TimelineStoreApi = UseBoundStore<StoreApi<TimelineState>>

/** Create an INDEPENDENT timeline store (one per Timeline node → duplication). */
export function createTimelineStore(): TimelineStoreApi {
  // counter + keyToTrack are per-store now (were module-level when global).
  let counter = 0
  const nextId = (p: string): string => `${p}-${(++counter).toString(36)}`
  const keyToTrack = new Map<string, string>()

  return create<TimelineState>((set, get) => ({
  tracks: [],
  clips: [],
  selectedIds: [],
  clipboard: null,
  loopStart: null,
  loopEnd: null,
  past: [],
  future: [],

  addTrack(track) {
    const id = nextId('trk')
    set((s) => ({ tracks: [...s.tracks, { ...track, id }] }))
    return id
  },

  removeTrack(id) {
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      clips: s.clips.filter((c) => c.trackId !== id),
    }))
  },

  addClip(clip) {
    const id = nextId('clip')
    set((s) => ({ clips: [...s.clips, { ...clip, id }] }))
    return id
  },

  addClipWithId(clip) {
    set((s) => {
      if (s.clips.some((c) => c.id === clip.id)) return s
      return { clips: [...s.clips, clip] }
    })
  },

  updateClip(id, patch) {
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  },

  setClipNotes(id, notes, bars) {
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id
          ? { ...c, notes, ...(bars !== undefined ? { clipBars: bars } : {}) }
          : c,
      ),
    }))
  },

  removeClip(id) {
    set((s) => {
      const clips = s.clips.filter((c) => c.id !== id)
      // Auto-remove tracks left with no clips.
      const tracks = s.tracks.filter((t) => clips.some((c) => c.trackId === t.id))
      return { clips, tracks, selectedIds: s.selectedIds.filter((x) => x !== id) }
    })
  },

  ensureTrack(key, track) {
    const existing = keyToTrack.get(key)
    if (existing && get().tracks.some((t) => t.id === existing)) return existing
    // Store the arm key on the track so the Timeline's R button can arm the right channel.
    const id = get().addTrack({ ...track, armKey: key })
    keyToTrack.set(key, id)
    return id
  },

  clear() {
    keyToTrack.clear()
    set({ tracks: [], clips: [], selectedIds: [], clipboard: null, loopStart: null, loopEnd: null, past: [], future: [] })
  },

  select(id) {
    set({ selectedIds: id ? [id] : [] })
  },

  addSelect(id) {
    set((s) => (s.selectedIds.includes(id) ? s : { selectedIds: [...s.selectedIds, id] }))
  },

  toggleSelect(id) {
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    }))
  },

  setSelection(ids) {
    set({ selectedIds: ids })
  },

  clearSelection() {
    set({ selectedIds: [] })
  },

  splitClip(id, atSec) {
    const clip = get().clips.find((c) => c.id === id)
    if (!clip) return
    const min = clip.startSec + 0.05
    const max = clip.startSec + clip.durSec - 0.05
    if (atSec <= min || atSec >= max) return
    const rightId = nextId('clip')
    // MIDI clips: both halves carry a copy of all notes (user trims in editor).
    const notesCopy = clip.notes ? clip.notes.map((n) => ({ ...n })) : undefined
    set((s) => ({
      clips: [
        ...s.clips.map((c) => (c.id === id ? { ...c, durSec: atSec - c.startSec } : c)),
        { ...clip, id: rightId, startSec: atSec, durSec: clip.startSec + clip.durSec - atSec, notes: notesCopy },
      ],
    }))
  },

  copyClip(id) {
    const clip = get().clips.find((c) => c.id === id)
    if (clip) set({ clipboard: { durSec: clip.durSec, label: clip.label, kind: clip.kind, notes: clip.notes, clipBars: clip.clipBars } })
  },

  pasteClip(trackId, atSec) {
    const cb = get().clipboard
    if (!cb) return null
    return get().addClip({ trackId, startSec: Math.max(0, atSec), durSec: cb.durSec, label: cb.label, kind: cb.kind, notes: cb.notes ? cb.notes.map((n) => ({ ...n })) : undefined, clipBars: cb.clipBars })
  },

  duplicateClip(id) {
    const clip = get().clips.find((c) => c.id === id)
    if (!clip) return null
    return get().addClip({
      trackId: clip.trackId,
      startSec: clip.startSec + clip.durSec,
      durSec: clip.durSec,
      label: clip.label,
      kind: clip.kind,
      notes: clip.notes ? clip.notes.map((n) => ({ ...n })) : undefined,
      clipBars: clip.clipBars,
    })
  },

  removeGaps(trackId) {
    set((s) => {
      const ordered = s.clips
        .filter((c) => c.trackId === trackId)
        .sort((a, b) => a.startSec - b.startSec)
      let cursor = 0
      const moved = new Map<string, number>()
      for (const c of ordered) { moved.set(c.id, cursor); cursor += c.durSec }
      return { clips: s.clips.map((c) => (moved.has(c.id) ? { ...c, startSec: moved.get(c.id)! } : c)) }
    })
  },

  moveClipToTrack(id, trackId) {
    set((s) => {
      const clips = s.clips.map((c) => (c.id === id ? { ...c, trackId } : c))
      // Source track may now be empty → prune it.
      const tracks = s.tracks.filter((t) => clips.some((c) => c.trackId === t.id))
      return { clips, tracks }
    })
  },

  toggleTrackMute(id) {
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)) }))
  },

  toggleTrackSolo(id) {
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t)) }))
  },

  addMidiClip(atSec = 0, notes?: PianoNote[], clipBars?: number) {
    const trackId = get().addTrack({ name: 'MIDI', kind: 'midi', color: 'var(--crystal, #e8f4f8)' })
    get().addClip({ trackId, startSec: Math.max(0, atSec), durSec: 4, label: 'MIDI', kind: 'midi', notes: notes ?? [], clipBars: clipBars ?? 1 })
  },

  setLoop(start, end) {
    set({ loopStart: Math.max(0, Math.min(start, end)), loopEnd: Math.max(start, end) })
  },

  clearLoop() {
    set({ loopStart: null, loopEnd: null })
  },

  closeGapAt(trackId, atSec) {
    set((s) => {
      const lane = s.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startSec - b.startSec)
      const next = lane.find((c) => c.startSec > atSec)
      if (!next) return s
      const prevEnd = lane
        .filter((c) => c.startSec + c.durSec <= atSec)
        .reduce((m, c) => Math.max(m, c.startSec + c.durSec), 0)
      const shift = next.startSec - prevEnd
      if (shift <= 0.0001) return s
      return { clips: s.clips.map((c) => (c.trackId === trackId && c.startSec >= next.startSec ? { ...c, startSec: c.startSec - shift } : c)) }
    })
  },

  packFromFirst(trackId) {
    set((s) => {
      const lane = s.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startSec - b.startSec)
      if (!lane.length) return s
      let cursor = lane[0].startSec
      const moved = new Map<string, number>()
      for (const c of lane) { moved.set(c.id, cursor); cursor += c.durSec }
      return { clips: s.clips.map((c) => (moved.has(c.id) ? { ...c, startSec: moved.get(c.id)! } : c)) }
    })
  },

  pushHistory() {
    set((s) => ({ past: [...s.past.slice(-(HISTORY_MAX - 1)), snap(s)], future: [] }))
  },

  undo() {
    set((s) => {
      if (!s.past.length) return s
      const prev = s.past[s.past.length - 1]
      return { tracks: prev.tracks, clips: prev.clips, selectedIds: prev.selectedIds, past: s.past.slice(0, -1), future: [...s.future, snap(s)] }
    })
  },

  redo() {
    set((s) => {
      if (!s.future.length) return s
      const next = s.future[s.future.length - 1]
      return { tracks: next.tracks, clips: next.clips, selectedIds: next.selectedIds, future: s.future.slice(0, -1), past: [...s.past, snap(s)] }
    })
  },
  }))
}
