import { roomSyncClient, type SyncStateSnapshot } from '../networking/roomSyncClient'
import { setSyncHook, useGraphStore } from './graphStore'
import type { GraphMutation } from './graphStore'
import type { SyncEvent } from '../protocol/syncProtocol'

/**
 * Bridge between the local graph store and the room sync layer (G2).
 *
 * `connectGraphSync` wires the store's sync hook to `roomSyncClient` so local
 * graph mutations are broadcast as `room:event`s, and subscribes to incoming
 * graph events, replaying them through `applyRemote` (no re-broadcast). It
 * reuses the SAME transport the drum machine uses — graph events are part of the
 * `syncEventSchema` union and pass server Zod validation + LWW state tracking.
 *
 * Not activated here: App.tsx calls `connectGraphSync` on room join and
 * `hydrateGraph` with the join snapshot (G3).
 */

function newEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `g-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** GraphMutation (store) → SyncEvent (wire). */
function mutationToEvent(m: GraphMutation): SyncEvent {
  const base = { timestamp: Date.now(), eventId: newEventId() }
  switch (m.kind) {
    case 'node_add':
      return { ...base, type: 'graph_node_add', payload: { node: m.node } }
    case 'node_remove':
      return { ...base, type: 'graph_node_remove', payload: { nodeId: m.nodeId } }
    case 'edge_connect':
      return { ...base, type: 'graph_edge_connect', payload: { edge: m.edge } }
    case 'edge_disconnect':
      return { ...base, type: 'graph_edge_disconnect', payload: { edgeId: m.edgeId } }
    case 'param_change':
      return { ...base, type: 'graph_param_change', payload: { nodeId: m.nodeId, paramId: m.paramId, value: m.value } }
    case 'node_move':
      return { ...base, type: 'graph_node_move', payload: { nodeId: m.nodeId, view: m.view, pos: m.pos } }
    case 'node_resize':
      return { ...base, type: 'graph_node_resize', payload: { nodeId: m.nodeId, size: m.size } }
  }
}

/** SyncEvent (wire) → GraphMutation (store), or null if not a graph event. */
function eventToMutation(e: SyncEvent): GraphMutation | null {
  switch (e.type) {
    case 'graph_node_add':
      return { kind: 'node_add', node: e.payload.node }
    case 'graph_node_remove':
      return { kind: 'node_remove', nodeId: e.payload.nodeId }
    case 'graph_edge_connect':
      return { kind: 'edge_connect', edge: e.payload.edge }
    case 'graph_edge_disconnect':
      return { kind: 'edge_disconnect', edgeId: e.payload.edgeId }
    case 'graph_param_change':
      return { kind: 'param_change', nodeId: e.payload.nodeId, paramId: e.payload.paramId, value: e.payload.value }
    case 'graph_node_move':
      return { kind: 'node_move', nodeId: e.payload.nodeId, view: e.payload.view, pos: e.payload.pos }
    case 'graph_node_resize':
      return { kind: 'node_resize', nodeId: e.payload.nodeId, size: e.payload.size }
    default:
      return null
  }
}

let unsubscribe: (() => void) | null = null

/** Start syncing the local graph with the room. Idempotent. */
export function connectGraphSync(): void {
  if (unsubscribe) return
  setSyncHook((m) => {
    roomSyncClient.sendSyncEvent(mutationToEvent(m)).catch(() => {
      /* transport handles its own retry/logging; a dropped graph event is non-fatal */
    })
  })
  unsubscribe = roomSyncClient.subscribeSyncEvents((e) => {
    const m = eventToMutation(e)
    if (m) useGraphStore.getState().applyRemote(m)
  })
}

/** Stop syncing (e.g. on leaving a room). */
export function disconnectGraphSync(): void {
  setSyncHook(null)
  unsubscribe?.()
  unsubscribe = null
}

/** Load the room's current graph from a join snapshot (late-joiner hydration). */
export function hydrateGraph(snapshot: SyncStateSnapshot | null | undefined): void {
  if (snapshot?.graph) {
    useGraphStore.getState().hydrate(snapshot.graph)
  }
}
