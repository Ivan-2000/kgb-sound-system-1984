import { create } from 'zustand'
import { controlBus } from './controlBus'
import { nodeRegistry } from './nodeRegistry'
import type { Edge, GraphNode, NodeContext, NodeInstance, ParamValue } from './types'

/**
 * Graph store (G1) — the single source of truth for the node graph.
 *
 * Holds the SHARED topology (nodes, edges, params, positions) and the LOCAL view
 * state (viewMode, focus). Every shared change goes through one funnel,
 * `applyMutation`, which:
 *   1. updates store state,
 *   2. runs runtime side effects (instantiate/dispose nodes, refresh the bus),
 *   3. if the change originated locally, forwards it to the sync hook.
 *
 * The sync hook is wired to `roomSyncClient` in a later step (G2/G3); until then
 * it is null and the graph behaves as a local-only model. Remote changes arrive
 * via `applyRemote`, which runs the same funnel WITHOUT re-broadcasting.
 *
 * Live node instances (imperative objects with their own UI + engine resources)
 * are kept in a non-reactive module map, keyed by node id; views read them with
 * `getNodeInstance`.
 */

export type ViewMode = 'panels' | 'canvas'
export type PanelView = 'panel' | 'canvas'

/** A shared, syncable change to the graph. View/focus changes are NOT mutations. */
export type GraphMutation =
  | { kind: 'node_add'; node: GraphNode }
  | { kind: 'node_remove'; nodeId: string }
  | { kind: 'edge_connect'; edge: Edge }
  | { kind: 'edge_disconnect'; edgeId: string }
  | { kind: 'param_change'; nodeId: string; paramId: string; value: ParamValue }
  | { kind: 'node_move'; nodeId: string; view: PanelView; pos: { x: number; y: number } }
  | { kind: 'node_resize'; nodeId: string; size: { w: number; h: number } }

export type SyncHook = (mutation: GraphMutation) => void

export type ConnectResult =
  | { ok: true; edgeId: string }
  | { ok: false; reason: string }

// ── runtime (non-reactive) ──────────────────────────────────────────────────

interface RuntimeNode {
  instance: NodeInstance
  ctx: NodeContext
}

const instances = new Map<string, RuntimeNode>()
const paramSubs = new Map<string, Set<(value: ParamValue) => void>>()

let syncHook: SyncHook | null = null
let clientTag = 'local'
let nodeCounter = 0
let edgeCounter = 0

const paramKey = (nodeId: string, paramId: string): string => `${nodeId} ${paramId}`
const nextNodeId = (): string => `${clientTag}-n${(++nodeCounter).toString()}`
const nextEdgeId = (): string => `${clientTag}-e${(++edgeCounter).toString()}`

/** Live instance for a node id (UI lives here). Undefined if its type is unknown. */
export function getNodeInstance(nodeId: string): NodeInstance | undefined {
  return instances.get(nodeId)?.instance
}

/** Wire the graph to the room sync layer (G2/G3). Pass null to detach. */
export function setSyncHook(hook: SyncHook | null): void {
  syncHook = hook
}

/** Tag local ids so they stay unique across peers once topology is synced. */
export function setClientTag(tag: string): void {
  clientTag = tag || 'local'
}

// ── store ─────────────────────────────────────────────────────────────────

interface GraphState {
  nodes: Record<string, GraphNode>
  edges: Edge[]
  viewMode: ViewMode      // LOCAL — personal, never synced
  focusedId: string | null // LOCAL
  /** Node ids currently shown as panels — LOCAL (which nodes I view), never synced. */
  openNodes: string[]

  // local-origin actions (may forward to sync hook)
  addNode: (type: string) => string | null
  removeNode: (nodeId: string) => void
  /** Clone a node (params + offset position). Returns null for singletons / unknown types. */
  duplicateNode: (nodeId: string) => string | null
  connect: (from: Edge['from'], to: Edge['to']) => ConnectResult
  disconnect: (edgeId: string) => void
  setParam: (nodeId: string, paramId: string, value: ParamValue) => void
  moveNode: (nodeId: string, view: PanelView, pos: { x: number; y: number }) => void
  resizeNode: (nodeId: string, size: { w: number; h: number }) => void

  // local-only view state (never synced)
  focusNode: (nodeId: string) => void
  setViewMode: (mode: ViewMode) => void
  /** Ensure a node of this type exists (shared) and show it as a panel (local). */
  openNodeByType: (type: string) => string | null
  /** Ensure a node of this type exists (shared) WITHOUT opening it (keeps it mounted). */
  preloadNodeByType: (type: string) => string | null
  /** Hide a node's panel locally; the node stays in the graph. */
  closeNode: (nodeId: string) => void
  /** Toggle a node's minimized state (local view). */
  toggleMinimize: (nodeId: string) => void

  // remote-origin (from sync layer; no re-broadcast)
  applyRemote: (mutation: GraphMutation) => void
  /** Replace the whole graph from a room snapshot (late-joiner hydration). */
  hydrate: (graph: { nodes: Record<string, GraphNode>; edges: Edge[] }) => void

  // param subscription for NodeContext.onParam
  subscribeParam: (nodeId: string, paramId: string, handler: (value: ParamValue) => void) => () => void

  // teardown (e.g. on leaving a room)
  reset: () => void
}

const BASE_Z = 100

export const useGraphStore = create<GraphState>((set, get) => {
  // ── helpers bound to this store instance ──

  const maxZ = (): number =>
    Object.values(get().nodes).reduce((m, n) => Math.max(m, n.zIndex), BASE_Z)

  const paramDefault = (type: string, paramId: string): ParamValue | undefined =>
    nodeRegistry.get(type)?.manifest.params.find((p) => p.id === paramId)?.default

  const notifyParam = (nodeId: string, paramId: string, value: ParamValue): void => {
    const subs = paramSubs.get(paramKey(nodeId, paramId))
    if (!subs) return
    for (const handler of subs) handler(value)
  }

  const makeContext = (nodeId: string): NodeContext => ({
    nodeId,
    emit: (portId, payload) => { controlBus.emit(nodeId, portId, payload) },
    onInput: (portId, handler) => controlBus.subscribe(nodeId, portId, handler),
    getParam: <T extends ParamValue = ParamValue>(paramId: string): T => {
      const node = get().nodes[nodeId]
      const value = node?.params[paramId] ?? (node ? paramDefault(node.type, paramId) : undefined)
      return value as T
    },
    setParam: (paramId, value) => { get().setParam(nodeId, paramId, value) },
    onParam: (paramId, handler) => get().subscribeParam(nodeId, paramId, handler),
    audio: undefined, // populated in G5
  })

  const instantiateNode = (node: GraphNode): void => {
    const def = nodeRegistry.get(node.type)
    if (!def) {
      console.warn(`[graph] no registered node type "${node.type}" — keeping topology, no instance`)
      return
    }
    const ctx = makeContext(node.id)
    try {
      const instance = def.create(ctx)
      instances.set(node.id, { instance, ctx })
    } catch (err) {
      console.error(`[graph] node "${node.type}" failed to create:`, err)
    }
  }

  const disposeNode = (nodeId: string): void => {
    const runtime = instances.get(nodeId)
    if (runtime) {
      try { runtime.instance.dispose() } catch (err) {
        console.error(`[graph] dispose failed for "${nodeId}":`, err)
      }
      instances.delete(nodeId)
    }
    for (const key of Array.from(paramSubs.keys())) {
      if (key.startsWith(`${nodeId} `)) paramSubs.delete(key)
    }
  }

  /**
   * G4f-3 (pivot 2026-06-06): ControlBus routing is disabled — cables are
   * frozen. Always flush the bus with an empty edge list so that controlBus.emit
   * delivers nothing (no routes). The function is kept so call sites compile
   * unchanged; restore by uncommenting the signal-edge filter below.
   */
  const refreshBus = (): void => {
    controlBus.setEdges([])
    // const { edges, nodes } = get()
    // const signalEdges = edges.filter((e) => {
    //   const port = nodeRegistry.getPort(nodes[e.from.nodeId]?.type ?? '', e.from.portId)
    //   return port ? port.kind !== 'audio' : false
    // })
    // controlBus.setEdges(signalEdges)
  }

  const canConnect = (from: Edge['from'], to: Edge['to']): ConnectResult => {
    const { nodes, edges } = get()
    const fromNode = nodes[from.nodeId]
    const toNode = nodes[to.nodeId]
    if (!fromNode || !toNode) return { ok: false, reason: 'unknown node' }

    const fromPort = nodeRegistry.getPort(fromNode.type, from.portId)
    const toPort = nodeRegistry.getPort(toNode.type, to.portId)
    if (!fromPort || !toPort) return { ok: false, reason: 'unknown port' }
    if (fromPort.direction !== 'out') return { ok: false, reason: 'source must be an output port' }
    if (toPort.direction !== 'in') return { ok: false, reason: 'target must be an input port' }
    if (fromPort.kind !== toPort.kind) {
      return { ok: false, reason: `port kind mismatch: ${fromPort.kind} → ${toPort.kind}` }
    }
    if (edges.some((e) =>
      e.from.nodeId === from.nodeId && e.from.portId === from.portId &&
      e.to.nodeId === to.nodeId && e.to.portId === to.portId
    )) {
      return { ok: false, reason: 'already connected' }
    }
    if (!toPort.multiple && edges.some((e) => e.to.nodeId === to.nodeId && e.to.portId === to.portId)) {
      return { ok: false, reason: 'input port already has a connection' }
    }
    return { ok: true, edgeId: '' }
  }

  const isLocalType = (type: string | undefined): boolean =>
    type ? nodeRegistry.get(type)?.manifest.local === true : false

  /** The one funnel every shared change flows through. */
  const applyMutation = (m: GraphMutation, origin: 'local' | 'remote'): void => {
    // Capture node locality BEFORE mutating (the node may be gone after node_remove).
    let localNode = false
    switch (m.kind) {
      case 'node_add': localNode = isLocalType(m.node.type); break
      case 'node_remove':
      case 'param_change':
      case 'node_move':
      case 'node_resize': localNode = isLocalType(get().nodes[m.nodeId]?.type); break
      case 'edge_connect': localNode = isLocalType(get().nodes[m.edge.from.nodeId]?.type); break
      case 'edge_disconnect': localNode = false; break
    }

    switch (m.kind) {
      case 'node_add':
        set((s) => ({ nodes: { ...s.nodes, [m.node.id]: m.node } }))
        instantiateNode(m.node)
        refreshBus()
        break
      case 'node_remove':
        disposeNode(m.nodeId)
        set((s) => {
          const nodes = { ...s.nodes }
          delete nodes[m.nodeId]
          return {
            nodes,
            edges: s.edges.filter((e) => e.from.nodeId !== m.nodeId && e.to.nodeId !== m.nodeId),
            focusedId: s.focusedId === m.nodeId ? null : s.focusedId,
          }
        })
        refreshBus()
        break
      case 'edge_connect':
        set((s) => ({ edges: [...s.edges, m.edge] }))
        refreshBus()
        break
      case 'edge_disconnect':
        set((s) => ({ edges: s.edges.filter((e) => e.id !== m.edgeId) }))
        refreshBus()
        break
      case 'param_change':
        set((s) => {
          const node = s.nodes[m.nodeId]
          if (!node) return s
          return { nodes: { ...s.nodes, [m.nodeId]: { ...node, params: { ...node.params, [m.paramId]: m.value } } } }
        })
        notifyParam(m.nodeId, m.paramId, m.value)
        break
      case 'node_move':
        set((s) => {
          const node = s.nodes[m.nodeId]
          if (!node) return s
          const patch = m.view === 'panel' ? { panelPos: m.pos } : { canvasPos: m.pos }
          return { nodes: { ...s.nodes, [m.nodeId]: { ...node, ...patch } } }
        })
        break
      case 'node_resize':
        set((s) => {
          const node = s.nodes[m.nodeId]
          if (!node) return s
          return { nodes: { ...s.nodes, [m.nodeId]: { ...node, size: m.size } } }
        })
        break
    }
    if (origin === 'local' && syncHook && !localNode) syncHook(m)
  }

  return {
    nodes: {},
    edges: [],
    viewMode: 'panels',
    focusedId: null,
    openNodes: [],

    addNode(type) {
      const def = nodeRegistry.get(type)
      if (!def) {
        console.warn(`[graph] addNode: unknown type "${type}"`)
        return null
      }
      if (def.manifest.singleton) {
        const existing = Object.values(get().nodes).find((n) => n.type === type)
        if (existing) {
          get().focusNode(existing.id)
          return existing.id
        }
      }
      // Singletons get a deterministic id (= type) so two peers creating the same
      // builtin converge to one node under LWW instead of duplicating.
      const id = def.manifest.singleton ? type : nextNodeId()
      const params: Record<string, ParamValue> = {}
      for (const p of def.manifest.params) params[p.id] = p.default

      const d = def.manifest.defaults
      const offset = Object.keys(get().nodes).length % 6
      const node: GraphNode = {
        id,
        type,
        params,
        panelPos: d?.panelPos ?? { x: 40 + offset * 28, y: 60 + offset * 28 },
        canvasPos: d?.canvasPos ?? { x: 60 + offset * 40, y: 60 + offset * 40 },
        size: d?.size ?? { w: 320, h: 280 },
        zIndex: maxZ() + 1,
        isMinimized: false,
      }
      applyMutation({ kind: 'node_add', node }, 'local')
      get().focusNode(id)
      return id
    },

    removeNode(nodeId) {
      applyMutation({ kind: 'node_remove', nodeId }, 'local')
    },

    duplicateNode(nodeId) {
      const src = get().nodes[nodeId]
      if (!src) return null
      const def = nodeRegistry.get(src.type)
      // Singletons are one-per-room — UNLESS marked `duplicable` (the Drum
      // Machine: one auto-created primary + independent copies with fresh ids).
      if (!def || (def.manifest.singleton && !def.manifest.duplicable)) return null
      const id = nextNodeId()
      const node: GraphNode = {
        ...src,
        id,
        params: { ...src.params },
        panelPos: { x: src.panelPos.x + 28, y: src.panelPos.y + 28 },
        canvasPos: { x: src.canvasPos.x + 40, y: src.canvasPos.y + 40 },
        zIndex: maxZ() + 1,
        isMinimized: false,
      }
      applyMutation({ kind: 'node_add', node }, 'local')
      // Show the copy as a panel too (local visibility) — it already appears on
      // the canvas, which draws every node.
      set((s) => (s.openNodes.includes(id) ? s : { openNodes: [...s.openNodes, id] }))
      get().focusNode(id)
      return id
    },

    connect(from, to) {
      const check = canConnect(from, to)
      if (!check.ok) return check
      const edge: Edge = { id: nextEdgeId(), from, to }
      applyMutation({ kind: 'edge_connect', edge }, 'local')
      return { ok: true, edgeId: edge.id }
    },

    disconnect(edgeId) {
      applyMutation({ kind: 'edge_disconnect', edgeId }, 'local')
    },

    setParam(nodeId, paramId, value) {
      applyMutation({ kind: 'param_change', nodeId, paramId, value }, 'local')
    },

    moveNode(nodeId, view, pos) {
      applyMutation({ kind: 'node_move', nodeId, view, pos }, 'local')
    },

    resizeNode(nodeId, size) {
      applyMutation({ kind: 'node_resize', nodeId, size }, 'local')
    },

    focusNode(nodeId) {
      // LOCAL only — stacking is per user, never synced.
      const top = maxZ() + 1
      set((s) => {
        const node = s.nodes[nodeId]
        if (!node) return s
        return { nodes: { ...s.nodes, [nodeId]: { ...node, zIndex: top } }, focusedId: nodeId }
      })
    },

    setViewMode(mode) {
      // LOCAL only — Panels vs Canvas is a personal lens.
      set({ viewMode: mode })
    },

    openNodeByType(type) {
      const id = get().addNode(type) // create, or find existing singleton (both focus)
      if (!id) return null
      set((s) => (s.openNodes.includes(id) ? s : { openNodes: [...s.openNodes, id] }))
      return id
    },

    preloadNodeByType(type) {
      // Create the node if absent but DON'T open it — keeps it mounted (e.g. chat
      // subscription) without showing the panel.
      return get().addNode(type)
    },

    closeNode(nodeId) {
      // LOCAL — hide the panel; the node stays in the (shared) graph.
      set((s) => ({ openNodes: s.openNodes.filter((x) => x !== nodeId) }))
    },

    toggleMinimize(nodeId) {
      // LOCAL view state — not synced.
      set((s) => {
        const node = s.nodes[nodeId]
        if (!node) return s
        return { nodes: { ...s.nodes, [nodeId]: { ...node, isMinimized: !node.isMinimized } } }
      })
    },

    applyRemote(mutation) {
      applyMutation(mutation, 'remote')
    },

    hydrate(graph) {
      // Merge the room's shared nodes/edges in WITHOUT resetting — preserves local
      // view state (openNodes) and avoids racing the join auto-open effect.
      for (const node of Object.values(graph.nodes)) {
        if (!get().nodes[node.id]) applyMutation({ kind: 'node_add', node }, 'remote')
      }
      for (const edge of graph.edges) {
        if (!get().edges.some((e) => e.id === edge.id)) {
          applyMutation({ kind: 'edge_connect', edge }, 'remote')
        }
      }
    },

    subscribeParam(nodeId, paramId, handler) {
      const key = paramKey(nodeId, paramId)
      let subs = paramSubs.get(key)
      if (!subs) {
        subs = new Set()
        paramSubs.set(key, subs)
      }
      subs.add(handler)
      return () => {
        const s = paramSubs.get(key)
        if (!s) return
        s.delete(handler)
        if (s.size === 0) paramSubs.delete(key)
      }
    },

    reset() {
      for (const id of Array.from(instances.keys())) disposeNode(id)
      instances.clear()
      paramSubs.clear()
      controlBus.reset()
      set({ nodes: {}, edges: [], focusedId: null, openNodes: [] })
    },
  }
})
