import { useContext } from 'react'
import { type NodeProps } from '@xyflow/react'
import { getNodeInstance } from '../graph/graphStore'
import { nodeRegistry } from '../graph/nodeRegistry'
import { PanelContentContext } from './panelContent'

/**
 * Canvas node (G4). Renders the SAME content as the Panels view — built-in UI
 * from App's content map (keyed by type), or a third-party node's own
 * `render()` — wrapped so React Flow's drag/zoom don't fight the inner controls
 * (`nodrag nowheel`).
 *
 * G4f-1 (pivot 2026-06-06): <Handle> port connectors are NOT rendered.
 * Cables are frozen — drag-to-connect is disabled. The manifest ports remain
 * in the type contract but are not exposed in the UI.
 */

export function PanelNode({ id, data }: NodeProps) {
  const type = (data as { type: string }).type
  const contents = useContext(PanelContentContext)
  const manifest = nodeRegistry.get(type)?.manifest

  const contentFn = contents[type]
  const content = contentFn ? contentFn(id) : getNodeInstance(id)?.render() ?? null

  return (
    <div className="cv-node">
      <div className="cv-node-head">
        {manifest?.icon && <span aria-hidden="true">{manifest.icon}</span>}
        <span className="cv-node-title">{manifest?.label ?? type}</span>
      </div>
      <div className="cv-node-body nodrag nowheel">{content}</div>
    </div>
  )
}
