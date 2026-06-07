/**
 * KGB Sound node graph — public surface (G1).
 *
 * Built-in code and third-party node modules import from here.
 */
export { defineNode } from './defineNode'
export { nodeRegistry, NodeRegistryError } from './nodeRegistry'
export { controlBus } from './controlBus'
export { registerBuiltinNodes, BUILTIN_NODES } from './nodes'
export { connectGraphSync, disconnectGraphSync, hydrateGraph } from './graphSync'
export {
  useGraphStore,
  getNodeInstance,
  setSyncHook,
  setClientTag,
} from './graphStore'
export type {
  ViewMode,
  PanelView,
  GraphMutation,
  SyncHook,
  ConnectResult,
} from './graphStore'
export type {
  PortKind,
  PortDirection,
  PortDef,
  ParamType,
  ParamValue,
  ParamDef,
  NodeManifest,
  SignalPayload,
  NoteEvent,
  AudioRoutingHandle,
  NodeContext,
  NodeInstance,
  NodeDefinition,
  Edge,
  GraphNode,
} from './types'
