import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from 'react'
import { audioEngine } from '../audio/audioEngine'
import { metronome } from '../audio/metronome'
import { type TimelineClip, type TimelineStoreApi } from '../timeline/timelineStore'
import { exportClipFile, type ExportCodec } from '../timeline/exportClip'
import { clipAudio } from '../audio/recorder'
import { PianoRollPanel } from '../pianoRoll/PianoRollPanel'
import type { PianoNote } from '../pianoRoll/pianoRollStore'
import { FxChainButton } from './FxChainButton'
import { useInsertChainStore, targetKey } from '../audio/insertChainStore'

const PX_PER_SEC = 40
const LANE_H = 48
const RULER_H = 22

type Tool = 'select' | 'split' | 'gaps'
type GroupItem = { id: string; startSec: number }
type ClipDrag = { id: string; trackId: string; mode: 'move' | 'trim-l' | 'trim-r'; startX: number; startY: number; startSec: number; durSec: number; group: GroupItem[]; pushed: boolean }
type Menu = { x: number; y: number; trackId: string | null; clipId: string | null; atSec: number }
type ExportTarget = { clipId: string; label: string; durSec: number; hasAudio?: boolean }
type Marquee = { x: number; y: number; w: number; h: number }

interface TimelinePanelProps {
  store: TimelineStoreApi
  /** Current transport play state — passed from App.tsx for toolbar play button. */
  isPlaying?: boolean
  /** True while preroll / transport start is in progress. */
  isStarting?: boolean
  /** Called when the timeline's play/stop button is clicked. */
  onPlayStop?: () => void
  /** Set of currently armed channel keys (e.g. 'local:0'). */
  armed?: ReadonlySet<string>
  /** Called when the per-track record button is clicked. */
  onToggleArm?: (armKey: string) => void
  /** Room BPM — passed from App so the grid re-renders when BPM changes. */
  bpm?: number
  /** Room time signature — same reactivity reason as bpm. */
  timeSignature?: { beats: number; division: number }
}

/** Static/live waveform drawn over an audio clip from its peak bins. */
function ClipWave({ peaks, w, h }: { peaks: number[]; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const width = Math.max(1, Math.floor(w))
    cv.width = width
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, h)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const n = peaks.length
    if (n === 0) return
    for (let x = 0; x < width; x++) {
      const p = peaks[Math.min(n - 1, Math.floor((x / width) * n))] ?? 0
      const bh = Math.max(1, p * (h - 6))
      ctx.fillRect(x, (h - bh) / 2, 1, bh)
    }
  }, [peaks, w, h])
  return <canvas ref={ref} className="tl-clip-wave" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-hidden="true" />
}

export function TimelinePanel({ store, isPlaying = false, isStarting = false, onPlayStop, armed, onToggleArm, bpm: bpmProp, timeSignature: timeSigProp }: TimelinePanelProps) {
  const tracks = store((s) => s.tracks)
  const clips = store((s) => s.clips)
  const selectedIds = store((s) => s.selectedIds)
  const loopStart = store((s) => s.loopStart)
  const loopEnd = store((s) => s.loopEnd)
  const hasClipboard = store((s) => s.clipboard) !== null
  const canUndo = store((s) => s.past.length > 0)
  const canRedo = store((s) => s.future.length > 0)
  const st = store.getState

  const [playSec, setPlaySec] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)
  const [dragDY, setDragDY] = useState(0)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null)
  const [codec, setCodec] = useState<ExportCodec>('wav')
  const [bitrate, setBitrate] = useState(16)
  const [tool, setTool] = useState<Tool>('select')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [snapUnit, setSnapUnit] = useState<'bar' | 'beat'>('bar')
  const [openEditorClipId, setOpenEditorClipId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const clipDrag = useRef<ClipDrag | null>(null)
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null)
  const lastY = useRef(0)
  const scrub = useRef(false)
  const loopDrag = useRef<'start' | 'end' | null>(null)

  const capture = (e: RPointerEvent<HTMLElement>) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer may be inactive */ } }

  const ls = loopStart ?? 0
  const le = loopEnd ?? 8
  const someSolo = tracks.some((t) => t.solo)
  const audible = (t: { muted?: boolean; solo?: boolean }) => !t.muted && (!someSolo || !!t.solo)
  const primary = clips.find((c) => c.id === selectedIds[0])
  const hasSel = selectedIds.length > 0

  useEffect(() => {
    let raf = 0
    const tick = () => { setPlaySec(audioEngine.getTransportSeconds()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  // Loop the transport ONLY when the user actually placed a loop region.
  // Default (loopStart/loopEnd null) must NOT loop — otherwise playback silently
  // wraps at the default 8 s marker and a longer take gets cut off. The ls/le
  // fallbacks below are for rendering the markers, not for driving the transport.
  useEffect(() => {
    if (loopStart !== null && loopEnd !== null && loopEnd > loopStart) {
      audioEngine.setLoopRegion(loopStart, loopEnd)
    } else {
      audioEngine.clearLoopRegion()
    }
  }, [loopStart, loopEnd])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey) }
  }, [menu])
  // Undo / Redo keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st().redo(); else st().undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [st])

  const endSec = clips.reduce((m, c) => Math.max(m, c.startSec + c.durSec), le)
  const totalSec = Math.max(30, Math.ceil(endSec) + 8)
  const laneW = totalSec * PX_PER_SEC

  const secFromClientX = (clientX: number): number => {
    const el = scrollRef.current
    if (!el) return 0
    return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / PX_PER_SEC)
  }
  const pointToContent = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = scrollRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top }
  }
  const trackIndexFromClientY = (clientY: number): number => {
    const el = scrollRef.current
    if (!el) return -1
    return Math.floor((clientY - el.getBoundingClientRect().top - RULER_H) / LANE_H)
  }

  const resolveStart = (trackId: string, clipId: string, dur: number, desired: number): number => {
    const others = st().clips.filter((c) => c.trackId === trackId && c.id !== clipId).sort((a, b) => a.startSec - b.startSec)
    let start = Math.max(0, desired)
    for (let pass = 0; pass <= others.length; pass++) {
      let moved = false
      for (const o of others) {
        const oEnd = o.startSec + o.durSec
        if (start < oEnd && start + dur > o.startSec) {
          const center = start + dur / 2
          const oCenter = o.startSec + o.durSec / 2
          start = center < oCenter ? Math.max(0, o.startSec - dur) : oEnd
          moved = true
        }
      }
      if (!moved) break
    }
    return start
  }

  // Remove-gaps tool: click a gap → close it; with a multi-selection → pack the whole track to its first clip.
  const removeGapAt = (trackId: string, atSec: number) => {
    st().pushHistory()
    if (st().selectedIds.length > 1) st().packFromFirst(trackId)
    else st().closeGapAt(trackId, atSec)
  }
  const deleteSelected = () => { st().pushHistory(); [...st().selectedIds].forEach((id) => st().removeClip(id)) }
  const duplicateSelected = () => { st().pushHistory(); [...st().selectedIds].forEach((id) => st().duplicateClip(id)) }

  // ── Ruler / loop ──
  function onRulerDown(e: RPointerEvent<HTMLDivElement>) {
    capture(e); scrub.current = true
    const sec = secFromClientX(e.clientX); audioEngine.seekSeconds(sec); setPlaySec(sec)
  }
  function onRulerMove(e: RPointerEvent<HTMLElement>) {
    if (loopDrag.current) {
      const sec = secFromClientX(e.clientX)
      if (loopDrag.current === 'start') st().setLoop(sec, le); else st().setLoop(ls, sec)
      return
    }
    if (!scrub.current) return
    const sec = secFromClientX(e.clientX); audioEngine.seekSeconds(sec); setPlaySec(sec)
  }
  function onRulerUp() { scrub.current = false; loopDrag.current = null }
  function onLoopDown(e: RPointerEvent<HTMLElement>, which: 'start' | 'end') {
    e.stopPropagation(); capture(e); loopDrag.current = which
  }

  // ── Lane (rubber-band, or gap tool) ──
  function onLaneDown(e: RPointerEvent<HTMLDivElement>, trackId: string) {
    if (e.button !== 0) return
    if (tool === 'gaps') { removeGapAt(trackId, secFromClientX(e.clientX)); return }
    if (tool === 'split') return
    capture(e)
    const p = pointToContent(e.clientX, e.clientY)
    marqueeRef.current = { x0: p.x, y0: p.y }
    st().clearSelection()
    setMarquee({ x: p.x, y: p.y, w: 0, h: 0 })
  }
  function onLaneMove(e: RPointerEvent<HTMLDivElement>) {
    if (!marqueeRef.current) return
    const p = pointToContent(e.clientX, e.clientY)
    const { x0, y0 } = marqueeRef.current
    const x = Math.min(x0, p.x), y = Math.min(y0, p.y), w = Math.abs(p.x - x0), h = Math.abs(p.y - y0)
    setMarquee({ x, y, w, h })
    const ids = st().clips.filter((c) => {
      const ti = tracks.findIndex((t) => t.id === c.trackId)
      if (ti < 0) return false
      const cx0 = c.startSec * PX_PER_SEC, cx1 = (c.startSec + c.durSec) * PX_PER_SEC
      const cy0 = RULER_H + ti * LANE_H, cy1 = cy0 + LANE_H
      return cx0 < x + w && cx1 > x && cy0 < y + h && cy1 > y
    }).map((c) => c.id)
    st().setSelection(ids)
  }
  function onLaneUp() { marqueeRef.current = null; setMarquee(null) }

  // ── Clip drag (tools intercept) ──
  function onClipDown(e: RPointerEvent<HTMLElement>, clip: TimelineClip, mode: ClipDrag['mode']) {
    e.stopPropagation()
    if (tool === 'split') { st().pushHistory(); st().splitClip(clip.id, secFromClientX(e.clientX)); return }
    if (tool === 'gaps') { removeGapAt(clip.trackId, secFromClientX(e.clientX)); return }
    capture(e)
    if (mode === 'move') {
      if (e.shiftKey) { st().addSelect(clip.id); clipDrag.current = null; return }
      if (e.ctrlKey || e.metaKey) { st().toggleSelect(clip.id); clipDrag.current = null; return }
      if (!st().selectedIds.includes(clip.id)) st().select(clip.id)
      const group: GroupItem[] = []
      for (const id of st().selectedIds) {
        const c = st().clips.find((x) => x.id === id)
        if (c) group.push({ id, startSec: c.startSec })
      }
      clipDrag.current = { id: clip.id, trackId: clip.trackId, mode, startX: e.clientX, startY: e.clientY, startSec: clip.startSec, durSec: clip.durSec, group, pushed: false }
      setDraggingIds(group.map((g) => g.id)); setDragDY(0)
    } else {
      st().select(clip.id)
      clipDrag.current = { id: clip.id, trackId: clip.trackId, mode, startX: e.clientX, startY: e.clientY, startSec: clip.startSec, durSec: clip.durSec, group: [], pushed: false }
    }
  }
  function onClipMove(e: RPointerEvent<HTMLElement>) {
    const d = clipDrag.current
    if (!d) return
    if (!d.pushed) { st().pushHistory(); d.pushed = true } // one undo step per drag gesture
    lastY.current = e.clientY
    const dSec = (e.clientX - d.startX) / PX_PER_SEC
    if (d.mode === 'move') {
      if (d.group.length > 1) {
        const minStart = Math.min(...d.group.map((g) => g.startSec))
        const rawDelta = Math.max(dSec, -minStart)
        // Snap the anchor clip's destination, then apply the same offset to the group.
        const anchorDesired = snapSec(Math.max(0, d.startSec + rawDelta))
        const delta = anchorDesired - d.startSec
        for (const g of d.group) st().updateClip(g.id, { startSec: Math.max(0, g.startSec + delta) })
      } else {
        const desired = snapSec(Math.max(0, d.startSec + dSec))
        st().updateClip(d.id, { startSec: resolveStart(d.trackId, d.id, d.durSec, desired) })
      }
      setDragDY(e.clientY - d.startY)
      const idx = trackIndexFromClientY(e.clientY)
      setDropTrackId(idx >= 0 && idx < tracks.length ? tracks[idx].id : null)
    } else if (d.mode === 'trim-r') {
      const snappedEnd = snapSec(d.startSec + d.durSec + dSec)
      st().updateClip(d.id, { durSec: Math.max(0.2, snappedEnd - d.startSec) })
    } else {
      const start = Math.max(0, snapSec(d.startSec + dSec))
      const originalEnd = d.startSec + d.durSec
      st().updateClip(d.id, { startSec: start, durSec: Math.max(0.2, originalEnd - start) })
    }
  }
  function onClipUp() {
    const d = clipDrag.current
    clipDrag.current = null
    setDraggingIds([]); setDropTrackId(null); setDragDY(0)
    if (!d || d.mode !== 'move' || d.group.length > 1) return
    const clip = st().clips.find((c) => c.id === d.id)
    if (!clip) return
    const idx = trackIndexFromClientY(lastY.current)
    const all = st().tracks
    let finalTrack = clip.trackId
    if (idx >= 0 && idx < all.length && all[idx].id !== clip.trackId) {
      st().moveClipToTrack(d.id, all[idx].id); finalTrack = all[idx].id
    } else if (idx >= all.length) {
      finalTrack = st().addTrack({ name: 'Track', kind: clip.kind, color: 'var(--gold)' })
      st().moveClipToTrack(d.id, finalTrack)
    }
    const cur = st().clips.find((c) => c.id === d.id)
    if (cur) {
      const snapped = resolveStart(finalTrack, d.id, cur.durSec, cur.startSec)
      if (snapped !== cur.startSec) st().updateClip(d.id, { startSec: snapped })
    }
  }

  // ── Context menu / export ──
  function openClipMenu(e: RMouseEvent, clip: TimelineClip) {
    e.preventDefault(); e.stopPropagation()
    if (!st().selectedIds.includes(clip.id)) st().select(clip.id)
    setMenu({ x: e.clientX, y: e.clientY, trackId: clip.trackId, clipId: clip.id, atSec: secFromClientX(e.clientX) })
  }
  function openLaneMenu(e: RMouseEvent, trackId: string | null) {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, trackId, clipId: null, atSec: secFromClientX(e.clientX) })
  }
  const run = (fn: () => void) => () => { fn(); setMenu(null) }
  const cmd = (fn: () => void) => () => { st().pushHistory(); fn(); setMenu(null) }
  function beginExport(clipId: string) {
    const c = st().clips.find((x) => x.id === clipId)
    if (c) setExportTarget({ clipId, label: c.label, durSec: c.durSec, hasAudio: clipAudio.has(clipId) })
    setMenu(null)
  }
  function changeCodec(next: ExportCodec) { setCodec(next); setBitrate(next === 'mp3' ? 320 : 16) }
  function doExport() {
    if (exportTarget) {
      void exportClipFile({ clipId: exportTarget.clipId, label: exportTarget.label, durSec: exportTarget.durSec, codec, bitrate })
    }
    setExportTarget(null)
  }
  const menuDelete = (clipId: string) => st().selectedIds.includes(clipId) && st().selectedIds.length > 1 ? [...st().selectedIds].forEach((id) => st().removeClip(id)) : st().removeClip(clipId)

  const ticks = Array.from({ length: totalSec + 1 }, (_, s) => s)
  const toolCls = tool === 'select' ? '' : ` tl--tool-${tool}`

  // BPM grid helpers — props (reactive: re-render on room BPM / time-signature
  // change) with engine fallback for standalone usage.
  const bpm = bpmProp ?? audioEngine.getBpm()
  const timeSig = timeSigProp ?? metronome.getState().timeSignature
  const beatSec = 60 / bpm
  const barSec = beatSec * timeSig.beats
  const snapSec = (sec: number): number => {
    if (!snapEnabled) return sec
    const unit = snapUnit === 'bar' ? barSec : beatSec
    return Math.round(sec / unit) * unit
  }
  // Grid line arrays for rendering
  const numBars = Math.ceil(totalSec / barSec) + 2
  const barLines = snapEnabled ? Array.from({ length: numBars }, (_, i) => i) : []
  const beatLines = snapEnabled && snapUnit === 'beat'
    ? Array.from({ length: numBars * timeSig.beats }, (_, i) => i).filter((i) => i % timeSig.beats !== 0)
    : []

  const handleReturnToStart = () => {
    audioEngine.seekSeconds(0)
    setPlaySec(0)
  }

  return (
    <div className={`tl${toolCls}`}>
      <div className="tl-toolbar">
        {/* ── Transport ── */}
        <button
          type="button"
          className="tl-tb"
          onClick={handleReturnToStart}
          title="В начало (Home)"
        >⏮</button>
        <button
          type="button"
          className={`tl-tb tl-tb--play${isPlaying ? ' tl-tb--on' : ''}`}
          onClick={onPlayStop}
          disabled={!onPlayStop}
          title={isPlaying ? 'Стоп' : isStarting ? 'Отменить' : 'Воспроизвести'}
        >{isStarting ? '…' : isPlaying ? '⏹' : '▶'}</button>
        {/* Global Record button — arms local:0 (first input channel).
            Visible only when nativeAudio is available (Electron with PortAudio). */}
        {window.nativeAudio !== undefined && onToggleArm && (
          <button
            type="button"
            className={`tl-tb tl-tb--rec${armed?.has('local:0') ? ' tl-tb--rec-on' : ''}`}
            onClick={() => void onToggleArm('local:0')}
            aria-pressed={armed?.has('local:0')}
            title={armed?.has('local:0') ? 'Остановить запись' : 'Начать запись (вход 1)'}
          >⏺</button>
        )}
        <span className="tl-tb-sep" />
        <button type="button" className={`tl-tb${tool === 'select' ? ' tl-tb--on' : ''}`} onClick={() => setTool('select')} title="Курсор">🖱</button>
        <button type="button" className={`tl-tb${tool === 'split' ? ' tl-tb--on' : ''}`} onClick={() => setTool('split')} title="Разрезать (инструмент)">✂</button>
        <button type="button" className={`tl-tb${tool === 'gaps' ? ' tl-tb--on' : ''}`} onClick={() => setTool('gaps')} title="Убрать пробел (инструмент)">↤</button>
        <span className="tl-tb-sep" />
        <button type="button" className="tl-tb" disabled={!primary} onClick={() => primary && st().copyClip(primary.id)} title="Копировать">⧉</button>
        <button type="button" className="tl-tb" disabled={!primary || !hasClipboard} onClick={() => { if (primary) { st().pushHistory(); st().pasteClip(primary.trackId, playSec) } }} title="Вставить (на playhead)">📋</button>
        <button type="button" className="tl-tb" disabled={!hasSel} onClick={duplicateSelected} title="Дублировать выделенные">⎘</button>
        <button type="button" className="tl-tb" disabled={!primary} onClick={() => primary && beginExport(primary.id)} title="Экспорт клипа">⤓</button>
        <button type="button" className="tl-tb tl-tb--del" disabled={!hasSel} onClick={deleteSelected} title="Удалить выделенные">🗑</button>
        <span className="tl-tb-sep" />
        <button type="button" className="tl-tb" disabled={!canUndo} onClick={() => st().undo()} title="Отменить (Ctrl+Z)">↶</button>
        <button type="button" className="tl-tb" disabled={!canRedo} onClick={() => st().redo()} title="Вернуть (Ctrl+Shift+Z)">↷</button>
        <span className="tl-tb-sep" />
        <button type="button" className="tl-midi-btn" onClick={() => { st().pushHistory(); st().addMidiClip(playSec) }} title="Создать MIDI-дорожку">＋♪</button>
        {selectedIds.length > 1 && <span className="tl-selcount">{selectedIds.length}</span>}
        <span className="tl-tb-sep" />
        <button
          type="button"
          className={`tl-tb${snapEnabled ? ' tl-tb--on' : ''}`}
          onClick={() => setSnapEnabled((v) => !v)}
          title={snapEnabled ? 'Привязка к сетке — вкл. (нажать чтобы выкл.)' : 'Привязка к сетке — выкл. (нажать чтобы вкл.)'}
        >
          ⁞⁞
        </button>
        {snapEnabled && (
          <select
            className="tl-snap-sel"
            value={snapUnit}
            onChange={(e) => setSnapUnit(e.target.value as 'bar' | 'beat')}
            title="Единица привязки"
          >
            <option value="bar">Такт</option>
            <option value="beat">Доля</option>
          </select>
        )}
      </div>

      <div className="tl-body">
        <div className="tl-left">
          <div className="tl-corner">Tracks</div>
          {tracks.map((t) => (
            <div key={t.id} className={`tl-track-head${audible(t) ? '' : ' tl-track-head--off'}`} style={{ '--track-color': t.color ?? 'var(--gold)' } as CSSProperties}>
              <div className="tl-th-top">
                <span className="tl-track-dot" />
                <span className="tl-track-name" title={`${t.name} (${t.kind})`}>{t.name}</span>
              </div>
              <div className="tl-th-btns">
                <button type="button" className={`tl-tbtn${t.muted ? ' tl-tbtn--mute' : ''}`} onClick={() => st().toggleTrackMute(t.id)} aria-pressed={t.muted} title="Mute">M</button>
                <button type="button" className={`tl-tbtn${t.solo ? ' tl-tbtn--solo' : ''}`} onClick={() => st().toggleTrackSolo(t.id)} aria-pressed={t.solo} title="Solo">S</button>
                {t.armKey && onToggleArm && (
                  <button
                    type="button"
                    className={`tl-tbtn tl-tbtn--rec${armed?.has(t.armKey) ? ' tl-tbtn--rec-on' : ''}`}
                    onClick={() => onToggleArm(t.armKey!)}
                    aria-pressed={armed?.has(t.armKey)}
                    title={armed?.has(t.armKey) ? 'Дизармировать' : 'Армировать для записи'}
                  >R</button>
                )}
                <FxChainButton targetKind="track" targetId={t.id} label={t.name} compact />
                <span className="tl-th-kind">{t.kind}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-ruler" style={{ width: laneW }} onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            {ticks.map((s) => (<span key={s} className="tl-tick" style={{ left: s * PX_PER_SEC }}>{s}s</span>))}
            {barLines.map((i) => (
              <span key={`bar-${i}`} className="tl-bar-mark" style={{ left: i * barSec * PX_PER_SEC }}>
                {i + 1}
              </span>
            ))}
            {beatLines.map((i) => (
              <span key={`beat-${i}`} className="tl-beat-mark" style={{ left: i * beatSec * PX_PER_SEC }} />
            ))}
            <span className="tl-loop tl-loop--start" style={{ left: ls * PX_PER_SEC }} onPointerDown={(e) => onLoopDown(e, 'start')} onPointerMove={onRulerMove} onPointerUp={onRulerUp} title="Начало области" />
            <span className="tl-loop tl-loop--end" style={{ left: le * PX_PER_SEC }} onPointerDown={(e) => onLoopDown(e, 'end')} onPointerMove={onRulerMove} onPointerUp={onRulerUp} title="Конец области" />
            <span className="tl-playhead-tri" style={{ left: playSec * PX_PER_SEC }} />
          </div>

          <div className="tl-loop-band" style={{ left: ls * PX_PER_SEC, width: Math.max(0, (le - ls) * PX_PER_SEC), top: RULER_H }} />

          {barLines.map((i) => (
            <div key={`gbar-${i}`} className="tl-grid-bar" style={{ left: i * barSec * PX_PER_SEC, top: RULER_H }} />
          ))}
          {beatLines.map((i) => (
            <div key={`gbeat-${i}`} className="tl-grid-beat" style={{ left: i * beatSec * PX_PER_SEC, top: RULER_H }} />
          ))}

          {tracks.map((t) => (
            <div
              key={t.id}
              className={`tl-lane${dropTrackId === t.id ? ' tl-lane--drop' : ''}`}
              style={{ width: laneW, height: LANE_H }}
              onPointerDown={(e) => onLaneDown(e, t.id)}
              onPointerMove={onLaneMove}
              onPointerUp={onLaneUp}
              onContextMenu={(e) => openLaneMenu(e, t.id)}
            >
              {clips.filter((c) => c.trackId === t.id).map((c) => {
                const style: CSSProperties = { left: c.startSec * PX_PER_SEC, width: c.durSec * PX_PER_SEC, '--track-color': t.color ?? 'var(--gold)' } as CSSProperties
                if (draggingIds.includes(c.id)) style.transform = `translateY(${dragDY - 4}px) scale(1.02)`
                return (
                  <div
                    key={c.id}
                    className={`tl-clip${c.proxy ? ' tl-clip--proxy' : ''}${c.kind === 'midi' ? ' tl-clip--midi' : ''}${selectedIds.includes(c.id) ? ' tl-clip--sel' : ''}${draggingIds.includes(c.id) ? ' tl-clip--dragging' : ''}${audible(t) ? '' : ' tl-clip--off'}`}
                    style={style}
                    onPointerDown={(e) => onClipDown(e, c, 'move')}
                    onPointerMove={onClipMove}
                    onPointerUp={onClipUp}
                    onContextMenu={(e) => openClipMenu(e, c)}
                    onDoubleClick={(e) => { if (c.kind === 'midi' && tool === 'select') { e.stopPropagation(); setOpenEditorClipId(c.id) } }}
                    title={`${c.label}${c.proxy ? ' (syncing…)' : ''}${c.kind === 'midi' ? ' · двойной клик = редактировать' : ''}`}
                  >
                    {c.kind === 'audio' && c.peaks && c.peaks.length > 0 && (
                      <ClipWave peaks={c.peaks} w={c.durSec * PX_PER_SEC} h={LANE_H - 10} />
                    )}
                    <span className="tl-clip-trim tl-clip-trim--l" onPointerDown={(e) => onClipDown(e, c, 'trim-l')} onPointerMove={onClipMove} onPointerUp={onClipUp} />
                    <span className="tl-clip-label">{c.label}</span>
                    <span className="tl-clip-trim tl-clip-trim--r" onPointerDown={(e) => onClipDown(e, c, 'trim-r')} onPointerMove={onClipMove} onPointerUp={onClipUp} />
                  </div>
                )
              })}
            </div>
          ))}

          {tracks.length === 0 && (
            <div className="tl-empty">Record на канале микшера или «＋♪» — здесь появится дорожка. Рамкой — выделить несколько, ПКМ — меню.</div>
          )}

          {marquee && <div className="tl-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} aria-hidden="true" />}
          <div className="tl-playhead" style={{ left: playSec * PX_PER_SEC }} aria-hidden="true" />
        </div>
      </div>

      {menu && (
        <ul className="tl-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.clipId && (
            <>
              {(() => { const mc = st().clips.find((c) => c.id === menu.clipId); return mc?.kind === 'midi' ? <li onClick={run(() => setOpenEditorClipId(menu.clipId!))}>✏ Редактировать ноты…</li> : null })()}
              <li onClick={cmd(() => st().splitClip(menu.clipId!, menu.atSec))}>✂ Разрезать</li>
              <li onClick={run(() => st().copyClip(menu.clipId!))}>⧉ Копировать</li>
              <li onClick={cmd(() => duplicateSelected())}>⎘ Дублировать</li>
              <li onClick={() => beginExport(menu.clipId!)}>⤓ Экспорт…</li>
              <li onClick={cmd(() => menuDelete(menu.clipId!))}>🗑 Удалить{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}</li>
              <li className="tl-menu-sep" />
            </>
          )}
          {menu.trackId && (
            <li className={hasClipboard ? '' : 'tl-menu-dis'} onClick={hasClipboard ? cmd(() => st().pasteClip(menu.trackId!, menu.atSec)) : undefined}>📋 Вставить</li>
          )}
          {menu.trackId && (<li onClick={cmd(() => st().removeGaps(menu.trackId!))}>↤ Убрать пробелы</li>)}
          <li onClick={cmd(() => st().addMidiClip(menu.atSec))}>＋ Создать MIDI</li>
        </ul>
      )}

      {openEditorClipId && (() => {
        // §5.19: a missing clip just renders nothing — never setState during
        // render (that spammed "update a component while rendering another").
        // The stale id is harmless (clip ids are unique; it can't wrongly reopen).
        const edClip = st().clips.find((c) => c.id === openEditorClipId)
        if (!edClip) return null
        const handleChange = (notes: PianoNote[], bars: number) => {
          st().setClipNotes(openEditorClipId, notes, bars)
        }
        // Bug #5: keyboard preview — find the track's non-bypassed instrument slot
        // and send noteOn/Off so clicking a key produces sound.
        const getVstInstrumentSlot = () => {
          const chains = useInsertChainStore.getState().chains
          const trackSlots = chains[targetKey({ kind: 'track', id: edClip.trackId })] ?? []
          return trackSlots.find((s) => !s.bypass && s.type === 'instrument') ?? null
        }
        const handleKeyDown = (pitch: number, velocity: number) => {
          const v = window.nativeAudio?.vst
          if (!v) return
          const slot = getVstInstrumentSlot()
          if (slot) void v.noteOn(slot.slotId, 0, pitch, velocity)
        }
        const handleKeyUp = (pitch: number) => {
          const v = window.nativeAudio?.vst
          if (!v) return
          const slot = getVstInstrumentSlot()
          if (slot) void v.noteOff(slot.slotId, 0, pitch)
        }
        return (
          <div className="tl-pr-backdrop" onPointerDown={() => setOpenEditorClipId(null)}>
            <div className="tl-pr-modal" onPointerDown={(e) => e.stopPropagation()}>
              <div className="tl-pr-header">
                <span className="tl-pr-title">Piano Roll — {edClip.label}</span>
                <button type="button" className="tl-pr-close" onClick={() => setOpenEditorClipId(null)} title="Закрыть">✕</button>
              </div>
              <PianoRollPanel
                initialNotes={edClip.notes ?? []}
                initialBars={edClip.clipBars ?? 1}
                clipStartSec={edClip.startSec}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
              />
            </div>
          </div>
        )
      })()}

      {exportTarget && (
        <div className="tl-export-backdrop" onPointerDown={() => setExportTarget(null)}>
          <div className="tl-export" onPointerDown={(e) => e.stopPropagation()}>
            <h4>Экспорт «{exportTarget.label}»</h4>
            <label className="tl-export-row">
              <span>Кодек</span>
              <select value={codec} onChange={(e) => changeCodec(e.target.value as ExportCodec)}>
                <option value="wav">WAV</option>
                <option value="mp3">MP3</option>
              </select>
            </label>
            <label className="tl-export-row">
              <span>{codec === 'mp3' ? 'Битрейт' : 'Глубина'}</span>
              <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>
                {(codec === 'mp3' ? [128, 192, 320] : [16, 24]).map((b) => (
                  <option key={b} value={b}>{codec === 'mp3' ? `${b} kbps` : `${b}-bit`}</option>
                ))}
              </select>
            </label>
            {!exportTarget?.hasAudio && (
              <p className="tl-export-note">Клип не содержит записанного аудио — экспортируется тишина-плейсхолдер.</p>
            )}
            <div className="tl-export-actions">
              <button type="button" className="ghost-action ghost-action--sm" onClick={() => setExportTarget(null)}>Отмена</button>
              <button type="button" className="ghost-action ghost-action--sm" onClick={doExport}>Экспорт</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
