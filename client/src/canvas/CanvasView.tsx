import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useReactFlow,
  type Node as RFNode,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../graph/graphStore'
import { nodeRegistry } from '../graph/nodeRegistry'
import type { GraphNode } from '../graph/types'
import { PanelNode } from './PanelNode'
import { PanelContentContext, type PanelContentFn } from './panelContent'

// G4f-1/2 (pivot 2026-06-06): CableEdge and Handle connectors are frozen.
// CableEdge.tsx stays in the repo but is not rendered — edges are not passed
// to <ReactFlow>. Restore by re-importing CableEdge and passing rfEdges below.

/**
 * Canvas view (G4) — the "advanced" lens over the SAME graph the Panels view
 * renders. Nodes come from `graphStore` (positioned by `canvasPos`); typed ports
 * are connectable handles; dragging a cable validates through `canConnect` and
 * commits a real edge. Lazy-loaded (default export) so React Flow stays out of
 * the startup bundle — Panels users never pay for it.
 */

const nodeTypes: NodeTypes = { panel: PanelNode }

const buildNodes = (nodes: Record<string, GraphNode>): RFNode[] =>
  Object.values(nodes).map((n) => ({
    id: n.id,
    type: 'panel',
    position: n.canvasPos,
    data: { type: n.type },
    style: { width: n.size.w },
    deletable: false, // nodes are removed via the panel close / "+" menu, not the canvas Delete key
  }))

interface CanvasViewProps {
  panelContents: Record<string, PanelContentFn>
}

type CanvasMenu = { x: number; y: number; nodeId: string | null }

function CanvasInner({ panelContents }: CanvasViewProps) {
  const storeNodes = useGraphStore((s) => s.nodes)
  const { screenToFlowPosition } = useReactFlow()

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([])
  const [menu, setMenu] = useState<CanvasMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Mirror the shared graph into React Flow's local model. Positions are pushed
  // back to the store on drag-stop (below), so this never fights live dragging.
  useEffect(() => { setRfNodes(buildNodes(storeNodes)) }, [storeNodes, setRfNodes])

  // G4f-2: edges are NOT mirrored into ReactFlow — cables are frozen (pivot 2026-06-06).

  const onNodeDragStop = useCallback((_: unknown, node: RFNode) => {
    useGraphStore.getState().moveNode(node.id, 'canvas', { x: node.position.x, y: node.position.y })
  }, [])

  // ── Right-click menus: node ops + add-on-canvas ──────────────────────────
  const onNodeContextMenu = useCallback((e: ReactMouseEvent, node: RFNode) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
  }, [])
  const onPaneContextMenu = useCallback((e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, nodeId: null })
  }, [])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Can't duplicate a singleton UNLESS it opts in with `duplicable` (Drum Machine).
  const cannotDuplicate = (nodeId: string): boolean => {
    const n = useGraphStore.getState().nodes[nodeId]
    const m = n && nodeRegistry.get(n.type)?.manifest
    return !!(m && m.singleton && !m.duplicable)
  }
  const addNodeAt = (type: string, sx: number, sy: number) => {
    const g = useGraphStore.getState()
    const countBefore = Object.keys(g.nodes).length
    const id = g.openNodeByType(type)
    // Only relocate if a NEW node was created (don't yank an existing singleton to the cursor).
    if (id && Object.keys(useGraphStore.getState().nodes).length > countBefore) {
      const p = screenToFlowPosition({ x: sx, y: sy })
      g.moveNode(id, 'canvas', { x: p.x, y: p.y })
    }
  }

  const contentValue = useMemo(() => panelContents, [panelContents])

  return (
    <PanelContentContext.Provider value={contentValue}>
      <div className="cv-root">
        <ReactFlow
          nodes={rfNodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2a2a2a" />
          <MiniMap pannable zoomable nodeColor="#c8a84b" maskColor="rgba(0,0,0,0.6)" />
          <Controls />
        </ReactFlow>
        <div className="cv-hint" aria-hidden="true">
          Canvas — расстановка нод; функциональные связи отключены · ПКМ — меню
        </div>

        {menu && (
          <div ref={menuRef} className="cv-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {menu.nodeId ? (
              <>
                <button
                  type="button"
                  className="cv-menu-item"
                  role="menuitem"
                  disabled={cannotDuplicate(menu.nodeId)}
                  title={cannotDuplicate(menu.nodeId) ? 'Singleton — одна на комнату, дублировать нельзя' : undefined}
                  onClick={() => { useGraphStore.getState().duplicateNode(menu.nodeId!); setMenu(null) }}
                >
                  ⧉ Дублировать{cannotDuplicate(menu.nodeId) ? ' (singleton)' : ''}
                </button>
                <div className="cv-menu-sep" />
                <button
                  type="button"
                  className="cv-menu-item cv-menu-item--del"
                  role="menuitem"
                  onClick={() => { useGraphStore.getState().removeNode(menu.nodeId!); setMenu(null) }}
                >
                  🗑 Удалить ноду
                </button>
              </>
            ) : (
              <>
                <div className="cv-menu-head">Добавить ноду</div>
                {nodeRegistry.list().map((m) => (
                  <button
                    key={m.type}
                    type="button"
                    className="cv-menu-item"
                    role="menuitem"
                    onClick={() => { addNodeAt(m.type, menu.x, menu.y); setMenu(null) }}
                  >
                    <span className="cv-menu-icon" aria-hidden="true">{m.icon}</span> {m.label}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </PanelContentContext.Provider>
  )
}

export default function CanvasView(props: CanvasViewProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
