import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../graph/graphStore'

/**
 * Canvas cable (G4). A bezier edge plus a ✕ button at its midpoint that appears
 * when the cable is selected (click it) — so disconnecting is discoverable
 * without the keyboard. Delete/Backspace also removes the selected cable
 * (wired in CanvasView via onEdgesDelete). Color comes from `style.stroke`
 * (per signal kind, set in CanvasView).
 */
export function CableEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  })

  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={['cv-edge-del', selected ? 'cv-edge-del--on' : ''].filter(Boolean).join(' ')}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(e) => { e.stopPropagation(); useGraphStore.getState().disconnect(id) }}
          title="Удалить кабель"
          aria-label="Удалить кабель"
        >
          ✕
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
