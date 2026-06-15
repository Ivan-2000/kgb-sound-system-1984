import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { usePanelStore, type PanelId } from './panelStore'
import './panels.css'

interface FloatingPanelProps {
  id: PanelId
  title: string
  icon?: string
  children: ReactNode
  /** Keep children mounted (display:none) when panel is closed — preserves subscriptions */
  keepMounted?: boolean
}

export function FloatingPanel({ id, title, icon, children, keepMounted = false }: FloatingPanelProps) {
  const panel = usePanelStore((s) => s.panels[id])
  // Stable store references — no extra subscriptions
  const { close, focus, move, resize, toggleMinimize } = usePanelStore.getState()

  // Local pos/size drive rendering; synced from store on open/reopen
  const [pos,  setPos]  = useState(panel.pos)
  const [size, setSize] = useState(panel.size)

  useEffect(() => {
    if (!panel.open) return
    const stored = usePanelStore.getState().panels[id]
    setPos(stored.pos)
    setSize(stored.size)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, panel.open])

  // Drag state stored in a ref — no re-renders during motion
  const drag   = useRef<{ ox: number; oy: number; mx: number; my: number } | null>(null)
  const rsz    = useRef<{ ox: number; oy: number; ow: number; oh: number } | null>(null)

  if (!panel.open) {
    if (keepMounted) return <div style={{ display: 'none' }}>{children}</div>
    return null
  }

  // Never let the panel overflow the viewport bottom
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 9999
  const maxH = Math.max(36, viewportH - pos.y - 8)
  const displayH = panel.minimized ? 36 : Math.min(size.h, maxH)

  // ── Drag handlers ────────────────────────────────────────────────
  function onTitleDown(e: RPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button')) return   // let dot-buttons work
    e.currentTarget.setPointerCapture(e.pointerId)           // keep events even off-element
    drag.current = { ox: pos.x, oy: pos.y, mx: e.clientX, my: e.clientY }
    focus(id)
  }
  function onTitleMove(e: RPointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    const { ox, oy, mx, my } = drag.current
    setPos({ x: ox + e.clientX - mx, y: oy + e.clientY - my })
  }
  function onTitleUp(e: RPointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    const { ox, oy, mx, my } = drag.current
    const newPos = { x: ox + e.clientX - mx, y: oy + e.clientY - my }
    setPos(newPos)
    move(id, newPos)
    drag.current = null
  }

  // ── Resize handlers ──────────────────────────────────────────────
  function onResizeDown(e: RPointerEvent<HTMLDivElement>) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    rsz.current = { ox: e.clientX, oy: e.clientY, ow: size.w, oh: size.h }
  }
  function onResizeMove(e: RPointerEvent<HTMLDivElement>) {
    if (!rsz.current) return
    const { ox, oy, ow, oh } = rsz.current
    const maxPanelH = Math.max(60, window.innerHeight - pos.y - 8)
    setSize({
      w: Math.max(160, ow + e.clientX - ox),
      h: Math.min(maxPanelH, Math.max(60, oh + e.clientY - oy)),
    })
  }
  function onResizeUp(e: RPointerEvent<HTMLDivElement>) {
    if (!rsz.current) return
    const { ox, oy, ow, oh } = rsz.current
    const maxPanelH = Math.max(60, window.innerHeight - pos.y - 8)
    const newSize = {
      w: Math.max(160, ow + e.clientX - ox),
      h: Math.min(maxPanelH, Math.max(60, oh + e.clientY - oy)),
    }
    setSize(newSize)
    resize(id, newSize)
    rsz.current = null
  }

  return (
    <div
      className="fp-wrapper"
      style={{ left: pos.x, top: pos.y, width: size.w, height: displayH, zIndex: panel.z }}
      onPointerDown={() => focus(id)}
    >
      <div className="fp-root">
        <div
          className="fp-titlebar"
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
        >
          <div className="fp-dots">
            <button
              type="button"
              className="fp-dot fp-dot--red"
              onClick={(e) => { e.stopPropagation(); close(id) }}
              aria-label="Close panel"
            />
            <button
              type="button"
              className="fp-dot fp-dot--yellow"
              onClick={(e) => { e.stopPropagation(); toggleMinimize(id) }}
              aria-label="Minimize panel"
            />
            <span className="fp-dot fp-dot--green" aria-hidden="true" />
          </div>
          <span className="fp-title">
            {icon && <span className="fp-icon" aria-hidden="true">{icon}</span>}
            {title}
          </span>
        </div>

        {!panel.minimized && (
          <div className="fp-content">
            {children}
          </div>
        )}
      </div>

      {!panel.minimized && (
        <div
          className="fp-resize-handle"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
      )}
    </div>
  )
}
