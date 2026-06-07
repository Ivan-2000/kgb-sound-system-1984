import type { ReactNode } from 'react'
import { useGraphStore, getNodeInstance, nodeRegistry } from '../graph'
import { FloatingPanel } from './FloatingPanel'

/** Node types whose panel stays mounted while closed (preserves subscriptions). */
const KEEP_MOUNTED = new Set<string>(['chat'])

/** Render function receives node id so content can wire close callbacks. */
export type PanelContentFn = (nodeId: string) => ReactNode

export interface PanelsViewProps {
  /** Built-in UI keyed by node type. Third-party nodes fall back to their own render(). */
  panelContents: Record<string, PanelContentFn>
}

export function PanelsView({ panelContents }: PanelsViewProps) {
  const nodes = useGraphStore((s) => s.nodes)

  return (
    <div className="panels-layer">
      {Object.values(nodes).map((node) => {
        const manifest = nodeRegistry.get(node.type)?.manifest
        const contentFn = panelContents[node.type]
        const content = contentFn ? contentFn(node.id) : getNodeInstance(node.id)?.render() ?? null
        return (
          <FloatingPanel
            key={node.id}
            id={node.id}
            title={manifest?.label ?? node.type}
            icon={manifest?.icon}
            keepMounted={KEEP_MOUNTED.has(node.type)}
          >
            {content}
          </FloatingPanel>
        )
      })}
    </div>
  )
}
