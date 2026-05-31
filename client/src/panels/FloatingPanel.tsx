import type { ReactNode } from 'react'
import { Rnd } from 'react-rnd'
import { usePanelStore } from './panelStore'
import './panels.css'

interface FloatingPanelProps {
  id: string
  title: string
  icon?: string
  children: ReactNode
  /** Keep children mounted (display:none) when panel is closed — preserves subscriptions */
  keepMounted?: boolean
}

export function FloatingPanel({ id, title, icon, children, keepMounted = false }: FloatingPanelProps) {
  const panel = usePanelStore((s) => s.panels.find((p) => p.id === id))
  // Methods are stable store references — access imperatively to avoid extra subscriptions
  const { closePanel, focusPanel, movePanel, resizePanel, minimizePanel } = usePanelStore.getState()

  if (!panel) return null

  if (!panel.isOpen) {
    if (keepMounted) {
      return <div style={{ display: 'none' }}>{children}</div>
    }
    return null
  }

  const displayH = panel.isMinimized ? 36 : panel.size.h

  return (
    <Rnd
      className="fp-rnd"
      position={{ x: panel.position.x, y: panel.position.y }}
      size={{ width: panel.size.w, height: displayH }}
      onDragStop={(_e, d) => movePanel(id, { x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        resizePanel(id, { w: ref.offsetWidth, h: ref.offsetHeight })
        movePanel(id, { x: pos.x, y: pos.y })
      }}
      dragHandleClassName="fp-titlebar"
      enableResizing={!panel.isMinimized}
      minWidth={160}
      minHeight={36}
      bounds="window"
      style={{ zIndex: panel.zIndex }}
      onMouseDown={() => focusPanel(id)}
    >
      <div className="fp-root">
        <div className="fp-titlebar">
          <div className="fp-dots">
            <button
              type="button"
              className="fp-dot fp-dot--red"
              onClick={(e) => { e.stopPropagation(); closePanel(id) }}
              aria-label="Close panel"
            />
            <button
              type="button"
              className="fp-dot fp-dot--yellow"
              onClick={(e) => { e.stopPropagation(); minimizePanel(id) }}
              aria-label="Minimize panel"
            />
            <span className="fp-dot fp-dot--green" aria-hidden="true" />
          </div>
          <span className="fp-title">
            {icon && <span className="fp-icon" aria-hidden="true">{icon}</span>}
            {title}
          </span>
        </div>
        {!panel.isMinimized && (
          <div className="fp-content">
            {children}
          </div>
        )}
      </div>
    </Rnd>
  )
}
