import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from 'react'
import { audioEngine } from '../audio/audioEngine'
import { STEPS_PER_BAR, DEFAULT_VELOCITY, type PianoNote } from './pianoRollStore'

const ROW_H = 14
const STEP_W = 18
const PITCH_HI = 72 // C5 (top row)
const PITCH_LO = 36 // C2 (bottom row) — GM kick lives here
const ROWS = PITCH_HI - PITCH_LO + 1

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12)
const noteName = (pitch: number) => `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`

let _noteCounter = 0
const nextNoteId = (): string => `pn-${(++_noteCounter).toString(36)}`

type Drag =
  | { mode: 'move'; id: string; x0: number; y0: number; start0: number; pitch0: number }
  | { mode: 'resize'; id: string; x0: number; len0: number }

export interface PianoRollPanelProps {
  initialNotes: PianoNote[]
  initialBars: number
  /** Called on every completed gesture (add, move-end, resize-end, delete, velocity). */
  onChange: (notes: PianoNote[], bars: number) => void
  /** Absolute transport position of the clip start — used to position the playhead. */
  clipStartSec?: number
}

export function PianoRollPanel({ initialNotes, initialBars, onChange, clipStartSec = 0 }: PianoRollPanelProps) {
  const [notes, setNotes] = useState<PianoNote[]>(() => initialNotes)
  const [bars, setBarsState] = useState(initialBars)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playStep, setPlayStep] = useState(-1)

  const totalSteps = bars * STEPS_PER_BAR
  const gridW = totalSteps * STEP_W
  const gridH = ROWS * ROW_H

  const gridRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const moved = useRef(false)
  // Live notes ref so drag handlers always see the latest notes without stale closures.
  const notesRef = useRef(notes)
  notesRef.current = notes

  // Playhead — follows the global Tone.Transport position relative to this clip.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const bpm = audioEngine.getBpm()
      const stepSec = 60 / (bpm * 4)
      const relSec = audioEngine.getTransportSeconds() - clipStartSec
      const rawStep = Math.floor(relSec / stepSec)
      setPlayStep(rawStep >= 0 && rawStep < totalSteps ? rawStep : -1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clipStartSec, totalSteps])

  // Drag handlers (window-level so capture survives leaving the note element).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      moved.current = true
      if (d.mode === 'move') {
        const dStep = Math.round((e.clientX - d.x0) / STEP_W)
        const dPitch = -Math.round((e.clientY - d.y0) / ROW_H)
        setNotes((prev) => prev.map((n) =>
          n.id === d.id
            ? { ...n, startStep: Math.max(0, Math.round(d.start0 + dStep)), pitch: Math.min(127, Math.max(0, Math.round(d.pitch0 + dPitch))) }
            : n,
        ))
      } else {
        const dLen = Math.round((e.clientX - d.x0) / STEP_W)
        setNotes((prev) => prev.map((n) =>
          n.id === d.id ? { ...n, lengthSteps: Math.max(1, Math.round(d.len0 + dLen)) } : n,
        ))
      }
    }
    const onUp = () => {
      if (drag.current) {
        // Flush final notes to parent after drag completes.
        onChange(notesRef.current, bars)
      }
      drag.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [bars, onChange])

  // Delete key removes the selected note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        setNotes((prev) => {
          const next = prev.filter((n) => n.id !== selectedId)
          onChange(next, bars)
          return next
        })
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, bars, onChange])

  const cellFromEvent = (clientX: number, clientY: number): { step: number; pitch: number } | null => {
    const el = gridRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const step = Math.floor((clientX - r.left) / STEP_W)
    const row = Math.floor((clientY - r.top) / ROW_H)
    if (step < 0 || step >= totalSteps || row < 0 || row >= ROWS) return null
    return { step, pitch: PITCH_HI - row }
  }

  const onGridDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const cell = cellFromEvent(e.clientX, e.clientY)
    if (!cell) return
    const id = nextNoteId()
    const newNote: PianoNote = { id, pitch: cell.pitch, startStep: cell.step, lengthSteps: 1, velocity: DEFAULT_VELOCITY }
    setNotes((prev) => {
      const next = [...prev, newNote]
      onChange(next, bars)
      return next
    })
    setSelectedId(id)
    moved.current = false
    drag.current = { mode: 'move', id, x0: e.clientX, y0: e.clientY, start0: cell.step, pitch0: cell.pitch }
  }

  const onNoteDown = (e: RPointerEvent<HTMLDivElement>, n: PianoNote) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(n.id)
    moved.current = false
    drag.current = { mode: 'move', id: n.id, x0: e.clientX, y0: e.clientY, start0: n.startStep, pitch0: n.pitch }
  }

  const onResizeDown = (e: RPointerEvent<Element>, n: PianoNote) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(n.id)
    moved.current = false
    drag.current = { mode: 'resize', id: n.id, x0: e.clientX, len0: n.lengthSteps }
  }

  const onNoteContext = (e: RMouseEvent<HTMLDivElement>, n: PianoNote) => {
    e.preventDefault()
    e.stopPropagation()
    const v = Number(window.prompt(`Velocity for ${noteName(n.pitch)} (1–127)`, String(n.velocity)))
    if (!Number.isNaN(v)) {
      const clamped = Math.min(127, Math.max(1, Math.round(v)))
      setNotes((prev) => {
        const next = prev.map((x) => (x.id === n.id ? { ...x, velocity: clamped } : x))
        onChange(next, bars)
        return next
      })
    }
  }

  const handleBarsChange = (next: number) => {
    setBarsState(next)
    onChange(notes, next)
  }

  const handleClear = () => {
    setNotes([])
    setSelectedId(null)
    onChange([], bars)
  }

  return (
    <div className="pr">
      <div className="pr-toolbar">
        <label className="pr-tb-field">
          <span>Bars</span>
          <select aria-label="Bars" value={bars} onChange={(e) => handleBarsChange(Number(e.target.value))}>
            {[1, 2, 4].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>

        <span className="pr-tb-sep" />
        <button
          type="button"
          className="pr-tb-btn"
          onClick={handleClear}
          disabled={notes.length === 0}
          title="Clear all notes"
        >
          🗑 Clear
        </button>
        <span className="pr-tb-hint">click empty = add · drag = move · right-edge = length · ПКМ = velocity · Del = delete</span>
      </div>

      <div className="pr-body">
        <div className="pr-keys" style={{ height: gridH }}>
          {Array.from({ length: ROWS }, (_, row) => {
            const pitch = PITCH_HI - row
            return (
              <div
                key={pitch}
                className={['pr-key', isBlackKey(pitch) ? 'pr-key--black' : '', pitch % 12 === 0 ? 'pr-key--c' : ''].filter(Boolean).join(' ')}
              >
                {pitch % 12 === 0 || !isBlackKey(pitch) ? noteName(pitch) : ''}
              </div>
            )
          })}
        </div>

        <div
          ref={gridRef}
          className="pr-grid"
          style={{ width: gridW, height: gridH }}
          onPointerDown={onGridDown}
        >
          {Array.from({ length: ROWS }, (_, row) => {
            const pitch = PITCH_HI - row
            return <div key={pitch} className={['pr-rowline', isBlackKey(pitch) ? 'pr-rowline--black' : ''].filter(Boolean).join(' ')} style={{ top: row * ROW_H }} />
          })}
          {Array.from({ length: totalSteps + 1 }, (_, s) => (
            <div
              key={s}
              className={['pr-collline', s % STEPS_PER_BAR === 0 ? 'pr-collline--bar' : s % 4 === 0 ? 'pr-collline--beat' : ''].filter(Boolean).join(' ')}
              style={{ left: s * STEP_W }}
            />
          ))}

          {notes.map((n) => (
            <div
              key={n.id}
              className={['pr-note', n.id === selectedId ? 'pr-note--sel' : ''].filter(Boolean).join(' ')}
              style={{
                left: n.startStep * STEP_W,
                top: (PITCH_HI - n.pitch) * ROW_H,
                width: n.lengthSteps * STEP_W,
                height: ROW_H,
                opacity: 0.45 + 0.55 * (n.velocity / 127),
              }}
              onPointerDown={(e) => onNoteDown(e, n)}
              onContextMenu={(e) => onNoteContext(e, n)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setNotes((prev) => {
                  const next = prev.filter((x) => x.id !== n.id)
                  onChange(next, bars)
                  return next
                })
                setSelectedId(null)
              }}
              title={`${noteName(n.pitch)} · vel ${n.velocity}`}
            >
              <span className="pr-note-resize" onPointerDown={(e) => onResizeDown(e, n)} />
            </div>
          ))}

          {playStep >= 0 && <div className="pr-playhead" style={{ left: playStep * STEP_W }} />}
        </div>
      </div>
    </div>
  )
}
