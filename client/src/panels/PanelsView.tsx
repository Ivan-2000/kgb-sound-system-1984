import type { ReactNode } from 'react'
import { usePanelStore, PANEL_IDS, PANEL_META, type PanelId } from './panelStore'
import { FloatingPanel } from './FloatingPanel'

/** Panel ids whose content stays mounted while closed (preserves subscriptions). */
const KEEP_MOUNTED = new Set<PanelId>(['chat'])

/**
 * Render function for a panel's content. Keyed by PanelId (a string), so App's
 * existing string-keyed map assigns без приведения типов.
 */
export type PanelContentFn = (id: string) => ReactNode

export interface PanelsViewProps {
  /** UI keyed by panel id. Missing entry → panel is not rendered. */
  panelContents: Record<string, PanelContentFn>
}

export function PanelsView({ panelContents }: PanelsViewProps) {
  const panels = usePanelStore((s) => s.panels)

  return (
    <div className="panels-layer">
      {PANEL_IDS.map((id) => {
        const p = panels[id]
        const keep = KEEP_MOUNTED.has(id)
        // Render only open panels (FloatingPanel handles the keepMounted hide).
        if (!p.open && !keep) return null
        const contentFn = panelContents[id]
        if (!contentFn) return null
        return (
          <FloatingPanel
            key={id}
            id={id}
            title={PANEL_META[id].label}
            icon={PANEL_META[id].icon}
            keepMounted={keep}
          >
            {contentFn(id)}
          </FloatingPanel>
        )
      })}
    </div>
  )
}
