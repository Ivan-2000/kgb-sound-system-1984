import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import type { NodeContext, NoteEvent } from '../graph/types'
import { usePianoRollStore, STEPS_PER_BAR, DEFAULT_VELOCITY, type PianoNote } from './pianoRollStore'
import type { PianoTransport } from './pianoTransport'

const ROW_H = 14
const STEP_W = 18
const PITCH_HI = 72 // C5 (top row)
const PITCH_LO = 36 // C2 (bottom row) — GM kick lives here
const ROWS = PITCH_HI - PITCH_LO + 1

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12)
const noteName = (pitch: number) => `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`

type Drag =
  | { mode: 'move'; id: string; x0: number; y0: number; start0: number; pitch0: number }
  | { mode: 'resize'; id: string; x0: number; len0: number }

interface PianoRollPanelProps {
  ctx: NodeContext
  /** The node's own playback clock (independent of the project transport). */
  transport: PianoTransport
}

export function PianoRollPanel({ ctx, transport }: PianoRollPanelProps) {
  const notes = usePianoRollStore((s) => s.notes)
  const bars = usePianoRollStore((s) => s.bars)
  const selectedId = usePianoRollStore((s) => s.selectedId)
  const st = usePianoRollStore.getState

  const totalSteps = bars * STEPS_PER_BAR
  const gridW = totalSteps * STEP_W
  const gridH = ROWS * ROW_H

  const gridRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const moved = useRef(false)
  const [playStep, setPlayStep] = useState(0)
  const [playing, setPlaying] = useState(transport.isPlaying)

  // Playhead — driven by THIS node's own clock (not the project transport).
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setPlayStep(transport.getStep())
      setPlaying(transport.isPlaying)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [transport])

  const onPlayToggle = () => { void transport.toggle().then(() => setPlaying(transport.isPlaying)) }

  // Drag (move / resize) handled on window so capture survives leaving the note.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      moved.current = true
      if (d.mode === 'move') {
        const dStep = Math.round((e.clientX - d.x0) / STEP_W)
        const dPitch = -Math.round((e.clientY - d.y0) / ROW_H)
        st().moveNote(d.id, d.start0 + dStep, d.pitch0 + dPitch)
      } else {
        const dLen = Math.round((e.clientX - d.x0) / STEP_W)
        st().resizeNote(d.id, d.len0 + dLen)
      }
    }
    const onUp = () => { drag.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [st])

  // Delete key removes the selected note (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && st().selectedId) {
        e.preventDefault()
        st().removeNote(st().selectedId!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [st])

  const cellFromEvent = (clientX: number, clientY: number): { step: number; pitch: number } | null => {
    const el = gridRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const step = Math.floor((clientX - r.left) / STEP_W)
    const row = Math.floor((clientY - r.top) / ROW_H)
    if (step < 0 || step >= totalSteps || row < 0 || row >= ROWS) return null
    return { step, pitch: PITCH_HI - row }
  }

  /** Click empty grid → add a 1-step note and begin dragging it. */
  const onGridDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const cell = cellFromEvent(e.clientX, e.clientY)
    if (!cell) return
    const id = st().addNote({ pitch: cell.pitch, startStep: cell.step, lengthSteps: 1, velocity: DEFAULT_VELOCITY })
    moved.current = false
    drag.current = { mode: 'move', id, x0: e.clientX, y0: e.clientY, start0: cell.step, pitch0: cell.pitch }
    // Audible preview through whatever the notesOut port feeds.
    ctx.emit('notesOut', { pitch: cell.pitch, velocity: DEFAULT_VELOCITY, durationBeats: 0.25, id } satisfies NoteEvent)
  }

  const onNoteDown = (e: RPointerEvent<HTMLDivElement>, n: PianoNote) => {
    if (e.button !== 0) return
    e.stopPropagation()
    st().select(n.id)
    moved.current = false
    drag.current = { mode: 'move', id: n.id, x0: e.clientX, y0: e.clientY, start0: n.startStep, pitch0: n.pitch }
  }

  const onResizeDown = (e: RPointerEvent<HTMLDivElement>, n: PianoNote) => {
    if (e.button !== 0) return
    e.stopPropagation()
    st().select(n.id)
    moved.current = false
    drag.current = { mode: 'resize', id: n.id, x0: e.clientX, len0: n.lengthSteps }
  }

  const onNoteContext = (e: RPointerEvent<HTMLDivElement>, n: PianoNote) => {
    e.preventDefault()
    e.stopPropagation()
    const v = Number(window.prompt(`Velocity for ${noteName(n.pitch)} (1–127)`, String(n.velocity)))
    if (!Number.isNaN(v)) st().setVelocity(n.id, v)
  }

  return (
    <div className="pr">
      <div className="pr-toolbar">
        <button
          type="button"
          className={['pr-tb-btn', 'pr-tb-play', playing ? 'pr-tb-play--on' : ''].filter(Boolean).join(' ')}
          onClick={onPlayToggle}
          title={playing ? 'Stop (свой плей)' : 'Play (свой плей)'}
        >
          {playing ? '■ Stop' : '▶ Play'}
        </button>

        <label className="pr-tb-field">
          <span>Bars</span>
          <select aria-label="Bars" value={bars} onChange={(e) => st().setBars(Number(e.target.value))}>
            {[1, 2, 4].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>

        <span className="pr-tb-sep" />
        <button
          type="button"
          className="pr-tb-btn"
          onClick={() => st().clear()}
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
              onDoubleClick={(e) => { e.stopPropagation(); st().removeNote(n.id) }}
              title={`${noteName(n.pitch)} · vel ${n.velocity}`}
            >
              <span className="pr-note-resize" onPointerDown={(e) => onResizeDown(e, n)} />
            </div>
          ))}

          <div className="pr-playhead" style={{ left: playStep * STEP_W }} />
        </div>
      </div>
    </div>
  )
}
