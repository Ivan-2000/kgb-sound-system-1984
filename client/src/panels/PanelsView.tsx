import type { ReactNode } from 'react'
import { usePanelStore } from './panelStore'
import type { PanelType } from './panelStore'
import { FloatingPanel } from './FloatingPanel'

const PANEL_TITLES: Record<PanelType, string> = {
  mixer:          'Mixer',
  'drum-machine': 'Drum Machine',
  chat:           'Chat',
  video:          'Video',
  metronome:      'Metronome',
  settings:       'Settings',
}

const PANEL_ICONS: Record<PanelType, string> = {
  mixer:          '🎚',
  'drum-machine': '🥁',
  chat:           '💬',
  video:          '📹',
  metronome:      '🎵',
  settings:       '⚙',
}

/** Render function receives panel id so content can wire close callbacks */
export type PanelContentFn = (panelId: string) => ReactNode

export interface PanelsViewProps {
  panelContents: Partial<Record<PanelType, PanelContentFn>>
}

export function PanelsView({ panelContents }: PanelsViewProps) {
  const panels = usePanelStore((s) => s.panels)

  return (
    <div className="panels-layer">
      {panels.map((panel) => {
        const contentFn = panelContents[panel.type]
        return (
          <FloatingPanel
            key={panel.id}
            id={panel.id}
            title={PANEL_TITLES[panel.type]}
            icon={PANEL_ICONS[panel.type]}
            keepMounted={panel.type === 'chat'}
          >
            {contentFn ? contentFn(panel.id) : null}
          </FloatingPanel>
        )
      })}
    </div>
  )
}
