import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  useInsertChainStore,
  targetKey,
  type InsertTargetKind,
  type InsertSlot,
} from '../audio/insertChainStore'

/**
 * TEMPORARY VST loader (E5 testing aid, not the final V7 UI).
 *
 * A Reaper-style FX-chain popup attached to any insert target (a mixer input
 * channel or a timeline track). Lets you scan, load, reorder, bypass, open the
 * native editor window, and tweak parameters of VST3 plugins for testing.
 *
 * Built entirely on the existing `insertChainStore` + `window.nativeAudio.vst.*`
 * contract — no native changes. Remove once N4 (V5/V7) lands the real UI.
 */

const EMPTY: InsertSlot[] = []

type Props = {
  targetKind: InsertTargetKind
  targetId: string
  label: string
  /** Compact styling for the timeline track header. */
  compact?: boolean
}

export function FxChainButton({ targetKind, targetId, label, compact }: Props) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  // Bug #2: extra scan-path manager state.
  const [showPaths, setShowPaths] = useState(false)
  const [extraPaths, setExtraPaths] = useState<string[]>([])
  const scannedRef = useRef(false)

  const target = useMemo(() => ({ kind: targetKind, id: targetId }), [targetKind, targetId])
  const key = targetKey(target)

  const chain = useInsertChainStore((s) => s.chains[key]) ?? EMPTY
  const available = useInsertChainStore((s) => s.available)
  const scanning = useInsertChainStore((s) => s.scanning)
  const scanError = useInsertChainStore((s) => s.scanError)
  const vstAvailable = useInsertChainStore((s) => s.vstAvailable)
  const insertError = useInsertChainStore((s) => s.insertError)

  const scan = useInsertChainStore((s) => s.scan)
  const addInsert = useInsertChainStore((s) => s.addInsert)
  const removeInsert = useInsertChainStore((s) => s.removeInsert)
  const moveInsert = useInsertChainStore((s) => s.moveInsert)
  const setBypass = useInsertChainStore((s) => s.setBypass)
  const setParam = useInsertChainStore((s) => s.setParam)
  const openEditor = useInsertChainStore((s) => s.openEditor)

  // Scan the plugin folders once, the first time the popup opens.
  useEffect(() => {
    if (open && !scannedRef.current && !scanning) {
      scannedRef.current = true
      if (available.length === 0) void scan()
    }
  }, [open, scanning, available.length, scan])

  // Bug #2: load persisted extra scan paths whenever the popup opens.
  useEffect(() => {
    if (!open) return
    void window.nativeAudio?.vst?.getExtraScanPaths().then((saved) => {
      if (Array.isArray(saved)) setExtraPaths(saved)
    })
  }, [open])

  const handleAddFolder = async () => {
    const picked = await window.nativeAudio?.vst?.pickScanFolder()
    if (!picked) return
    const next = [...extraPaths, picked].filter((p, i, a) => a.indexOf(p) === i)
    setExtraPaths(next)
    await window.nativeAudio?.vst?.setExtraScanPaths(next)
  }

  const handleRemovePath = async (idx: number) => {
    const next = extraPaths.filter((_, i) => i !== idx)
    setExtraPaths(next)
    await window.nativeAudio?.vst?.setExtraScanPaths(next)
  }

  // Esc closes the popup.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const count = chain.length
  const q = filter.trim().toLowerCase()
  const filtered = q
    ? available.filter((p) => `${p.name} ${p.vendor}`.toLowerCase().includes(q))
    : available

  const doAdd = async (path: string, uid: string) => {
    setBusy(true)
    try { await addInsert(target, { path, uid }) } finally { setBusy(false) }
    setAdding(false)
  }

  const handleEditor = async (i: number) => {
    const ok = await openEditor(target, i)
    if (!ok) setExpanded(i) // headless plugin → fall back to the generic params list
  }

  const overlay = open ? createPortal(
    <div style={S.overlay} onMouseDown={() => setOpen(false)}>
      <div style={S.win} onMouseDown={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <strong style={{ flex: 1 }}>FX — {label}</strong>
          <span style={S.dim}>{targetKind}:{targetId}</span>
          <button type="button" style={S.x} onClick={() => setOpen(false)} aria-label="Close">×</button>
        </div>

        {!vstAvailable && !scanning && (
          <div style={S.note}>
            VST host not available — rebuild the addon with <code>npm run build:vst</code>.
            {scanError ? <div style={{ color: '#e07060', marginTop: 4 }}>{scanError}</div> : null}
          </div>
        )}

        <div style={S.chain}>
          {chain.length === 0 && <div style={S.empty}>No inserts — click “+ Add FX”.</div>}
          {chain.map((slot, i) => (
            <div key={slot.slotId} style={rowStyle(slot.bypass)}>
              <div style={S.rowMain}>
                <span style={S.rowName} title={`${slot.name} · ${slot.vendor}`}>
                  {i + 1}. {slot.name} <span style={S.dim}>· {slot.vendor}</span>
                </span>
                <button type="button" style={S.mini} title="Move up" disabled={i === 0}
                  onClick={() => void moveInsert(target, i, i - 1)}>↑</button>
                <button type="button" style={S.mini} title="Move down" disabled={i === chain.length - 1}
                  onClick={() => void moveInsert(target, i, i + 1)}>↓</button>
                <button type="button" style={{ ...S.mini, ...(slot.bypass ? S.miniOn : {}) }} title="Bypass"
                  onClick={() => setBypass(target, i, !slot.bypass)}>⏻</button>
                <button type="button" style={S.mini} title="Open plugin editor window"
                  onClick={() => void handleEditor(i)}>🪟</button>
                <button type="button" style={{ ...S.mini, ...(expanded === i ? S.miniOn : {}) }} title="Parameters"
                  onClick={() => setExpanded(expanded === i ? null : i)}>⚙</button>
                <button type="button" style={{ ...S.mini, color: '#e07060' }} title="Remove"
                  onClick={() => void removeInsert(target, i)}>×</button>
              </div>
              {expanded === i && (
                <div style={S.params}>
                  {slot.params.length === 0 && <div style={S.dim}>No parameters.</div>}
                  {slot.params.slice(0, 200).map((p) => {
                    const val = slot.values[p.id] ?? p.defaultNormalized
                    return (
                      <label key={p.id} style={S.paramRow}>
                        <span style={S.paramName} title={p.title}>{p.title}</span>
                        <input type="range" min={0} max={1} step={0.001} value={val} style={{ flex: 1 }}
                          onChange={(e) => void setParam(target, i, p.id, Number(e.target.value))} />
                        <span style={S.paramVal}>{val.toFixed(2)}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {insertError && <div style={S.err}>{insertError}</div>}

        <div style={S.foot}>
          {!adding ? (
            <button type="button" style={S.add} disabled={!vstAvailable || busy}
              onClick={() => setAdding(true)}>+ Add FX</button>
          ) : (
            <div>
              <div style={S.addBar}>
                <input autoFocus placeholder="Filter plugins…" value={filter} style={S.filter}
                  onChange={(e) => setFilter(e.target.value)} />
                <button type="button" style={S.mini} title="Rescan" disabled={scanning}
                  onClick={() => void scan()}>{scanning ? '…' : '⟳'}</button>
                <button type="button" style={S.mini} onClick={() => setAdding(false)}>Cancel</button>
              </div>
              <div style={S.list}>
                {scanning && <div style={S.empty}>Scanning…</div>}
                {!scanning && filtered.length === 0 && <div style={S.empty}>No plugins found.</div>}
                {filtered.map((p) => (
                  <button key={p.uid + p.path} type="button" style={S.plug} disabled={busy}
                    onClick={() => void doAdd(p.path, p.uid)}>
                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={S.dim}>{p.vendor} · {p.type}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bug #2: extra VST3 scan-path manager ─────────────────────── */}
        <div style={S.pathsSection}>
          <button type="button" style={S.pathsToggle}
            onClick={() => setShowPaths(!showPaths)}>
            📁 Scan paths{extraPaths.length > 0 ? ` (${extraPaths.length} custom)` : ''} {showPaths ? '▲' : '▼'}
          </button>
          {showPaths && (
            <div style={{ marginTop: 4 }}>
              {extraPaths.length === 0
                ? <div style={{ ...S.empty, fontSize: 11 }}>No custom paths — OS defaults are always scanned.</div>
                : extraPaths.map((p, i) => (
                    <div key={p} style={S.pathRow}>
                      <span style={S.pathStr} title={p}>{p}</span>
                      <button type="button" style={{ ...S.mini, color: '#e07060', fontSize: 11 }}
                        onClick={() => void handleRemovePath(i)}>×</button>
                    </div>
                  ))
              }
              <button type="button" style={S.pathAdd}
                onClick={() => void handleAddFolder()}>
                + Add folder…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        type="button"
        className={compact ? 'tl-tbtn' : 'mfx-btn'}
        onClick={() => setOpen(true)}
        title="FX chain (temporary VST loader)"
        style={count ? { color: 'var(--gold, #c8a84b)', fontWeight: 700 } : undefined}
      >
        FX{count ? ` ${count}` : ''}
      </button>
      {overlay}
    </>
  )
}

// ── Inline styles (this is a temporary tool — kept self-contained) ──────────
const rowStyle = (bypass: boolean): CSSProperties => ({
  border: '1px solid rgba(255,255,255,.08)', borderRadius: 6, marginBottom: 6,
  padding: 6, opacity: bypass ? 0.45 : 1, background: 'rgba(255,255,255,.03)',
})

const S: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(0,0,0,.55)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  win: {
    width: 460, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    background: 'var(--graphite, #1b1d22)', color: 'var(--crystal, #e8f4f8)',
    border: '1px solid rgba(200,168,75,.4)', borderRadius: 8,
    boxShadow: '0 12px 40px rgba(0,0,0,.6)', fontSize: 13,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,.1)',
  },
  dim: { opacity: 0.55, fontSize: 11 },
  x: { background: 'none', border: 'none', color: 'inherit', fontSize: 20, cursor: 'pointer', lineHeight: 1 },
  note: { padding: '8px 12px', fontSize: 12, opacity: 0.85, borderBottom: '1px solid rgba(255,255,255,.08)' },
  chain: { overflowY: 'auto', padding: 6, flex: 1, minHeight: 60 },
  empty: { opacity: 0.5, padding: 8, fontSize: 12 },
  rowMain: { display: 'flex', alignItems: 'center', gap: 4 },
  rowName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mini: {
    background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)',
    color: 'inherit', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', fontSize: 12,
  },
  miniOn: { background: 'var(--gold, #c8a84b)', color: '#1b1d22', borderColor: 'var(--gold, #c8a84b)' },
  params: { marginTop: 6, paddingTop: 6, borderTop: '1px dashed rgba(255,255,255,.12)', maxHeight: 180, overflowY: 'auto' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 },
  paramName: { width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 },
  paramVal: { width: 38, textAlign: 'right', fontSize: 11, opacity: 0.7 },
  err: { color: '#e07060', padding: '4px 12px', fontSize: 11 },
  foot: { padding: 10, borderTop: '1px solid rgba(255,255,255,.1)' },
  add: {
    width: '100%', padding: '8px', background: 'rgba(200,168,75,.15)',
    border: '1px solid rgba(200,168,75,.4)', color: 'var(--gold, #c8a84b)',
    borderRadius: 6, cursor: 'pointer', fontWeight: 600,
  },
  addBar: { display: 'flex', gap: 6, marginBottom: 6 },
  filter: {
    flex: 1, padding: '4px 8px', background: 'rgba(0,0,0,.3)',
    border: '1px solid rgba(255,255,255,.15)', color: 'inherit', borderRadius: 4,
  },
  list: { maxHeight: 220, overflowY: 'auto', border: '1px solid rgba(255,255,255,.08)', borderRadius: 4 },
  plug: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px',
    background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,.06)',
    color: 'inherit', cursor: 'pointer', fontSize: 12,
  },
  // Bug #2: scan-path manager styles
  pathsSection: {
    borderTop: '1px solid rgba(255,255,255,.06)', padding: '6px 10px',
  },
  pathsToggle: {
    background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
    fontSize: 12, opacity: 0.65, width: '100%', textAlign: 'left' as const, padding: '2px 0',
  },
  pathRow: {
    display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3,
  },
  pathStr: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    fontSize: 11, opacity: 0.8,
  },
  pathAdd: {
    marginTop: 6, background: 'rgba(200,168,75,.1)',
    border: '1px solid rgba(200,168,75,.3)', color: 'var(--gold, #c8a84b)',
    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
  },
}
