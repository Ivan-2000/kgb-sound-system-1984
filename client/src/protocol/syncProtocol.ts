import { z } from 'zod'

export type StepCount = 8 | 16 | 32
export const VALID_STEP_COUNTS: StepCount[] = [8, 16, 32]

export const syncEventTypeSchema = z.enum([
  'step_toggle',
  'transport_play',
  'transport_stop',
  'bpm_change',
  'mic_toggle',
  'camera_toggle',
  'step_count_change',
  'velocity_change',
  'time_signature_change',
  'metronome_toggle',
  'swing_change',
  'pattern_switch',
  'chain_set',
  'channel_meta',
  'graph_node_add',
  'graph_node_remove',
  'graph_edge_connect',
  'graph_edge_disconnect',
  'graph_param_change',
  'graph_node_move',
  'graph_node_resize',
])

export const drumTrackSchema = z.enum(['kick', 'snare', 'hat', 'crash'])

// Per-node drum routing: which Drum Machine instance an event targets. OPTIONAL
// for back-compat — a missing nodeId means the primary/singleton drum
// ('drum-machine'). Added 2026-06-02 for drum duplication.
const drumNodeIdSchema = z.string().trim().min(1).max(64).optional()

export const syncEventBaseSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  eventId: z.string().trim().min(1),
  // Injected by server when relaying — never sent by client
  senderId: z.string().optional(),
})

export const stepToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('step_toggle'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    track: drumTrackSchema,
    step: z.number().int().min(0).max(31),
    value: z.boolean(),
  }),
})

export const transportPlayEventSchema = syncEventBaseSchema.extend({
  type: z.literal('transport_play'),
  payload: z.object({
    step: z.number().int().min(0).max(31),
  }),
})

export const transportStopEventSchema = syncEventBaseSchema.extend({
  type: z.literal('transport_stop'),
  payload: z.object({
    step: z.number().int().min(0).max(31),
  }),
})

export const bpmChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('bpm_change'),
  payload: z.object({
    bpm: z.number().int().min(60).max(240),
  }),
})

export const micToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('mic_toggle'),
  payload: z.object({
    enabled: z.boolean(),
  }),
})

export const cameraToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('camera_toggle'),
  payload: z.object({
    enabled: z.boolean(),
  }),
})

export const stepCountChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('step_count_change'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    stepCount: z.union([z.literal(8), z.literal(16), z.literal(32)]),
  }),
})

export const velocityChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('velocity_change'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    track: drumTrackSchema,
    step: z.number().int().min(0).max(31),
    velocity: z.number().int().min(1).max(127),
  }),
})

export const timeSignatureChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('time_signature_change'),
  payload: z.object({
    beats: z.number().int().min(1).max(16),
    division: z.union([z.literal(4), z.literal(8), z.literal(16)]),
  }),
})

export const metronomeToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('metronome_toggle'),
  payload: z.object({
    enabled: z.boolean(),
  }),
})

export const swingChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('swing_change'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    swing: z.number().int().min(0).max(100),
  }),
})

export const patternSwitchEventSchema = syncEventBaseSchema.extend({
  type: z.literal('pattern_switch'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    patternIndex: z.number().int().min(0).max(7),
  }),
})

export const chainSetEventSchema = syncEventBaseSchema.extend({
  type: z.literal('chain_set'),
  payload: z.object({
    nodeId: drumNodeIdSchema,
    chain: z.array(z.number().int().min(0).max(7)).max(32).nullable(),
  }),
})

// ── Node graph events (G2) ──────────────────────────────────────────────────
// Shared topology + params + positions. Each client runs its own copy of the
// graph; only these mutations are synced (not runtime signals). See TASKS_UI.md.

export const paramValueSchema = z.union([z.number(), z.string(), z.boolean()])
const vec2Schema = z.object({ x: z.number(), y: z.number() })
const sizeSchema = z.object({ w: z.number(), h: z.number() })
const portRefSchema = z.object({
  nodeId: z.string().trim().min(1).max(64),
  portId: z.string().trim().min(1).max(64),
})

export const graphNodeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.string().trim().min(1).max(128),
  params: z.record(z.string().max(64), paramValueSchema),
  panelPos: vec2Schema,
  canvasPos: vec2Schema,
  size: sizeSchema,
  zIndex: z.number(),
  isMinimized: z.boolean(),
})

export const graphEdgeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  from: portRefSchema,
  to: portRefSchema,
})

export const graphNodeAddEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_node_add'),
  payload: z.object({ node: graphNodeSchema }),
})

export const graphNodeRemoveEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_node_remove'),
  payload: z.object({ nodeId: z.string().trim().min(1).max(64) }),
})

export const graphEdgeConnectEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_edge_connect'),
  payload: z.object({ edge: graphEdgeSchema }),
})

export const graphEdgeDisconnectEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_edge_disconnect'),
  payload: z.object({ edgeId: z.string().trim().min(1).max(64) }),
})

export const graphParamChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_param_change'),
  payload: z.object({
    nodeId: z.string().trim().min(1).max(64),
    paramId: z.string().trim().min(1).max(64),
    value: paramValueSchema,
  }),
})

export const graphNodeMoveEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_node_move'),
  payload: z.object({
    nodeId: z.string().trim().min(1).max(64),
    view: z.enum(['panel', 'canvas']),
    pos: vec2Schema,
  }),
})

export const graphNodeResizeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('graph_node_resize'),
  payload: z.object({
    nodeId: z.string().trim().min(1).max(64),
    size: sizeSchema,
  }),
})

export const syncEventSchema = z.discriminatedUnion('type', [
  stepToggleEventSchema,
  transportPlayEventSchema,
  transportStopEventSchema,
  bpmChangeEventSchema,
  micToggleEventSchema,
  cameraToggleEventSchema,
  stepCountChangeEventSchema,
  velocityChangeEventSchema,
  timeSignatureChangeEventSchema,
  metronomeToggleEventSchema,
  swingChangeEventSchema,
  patternSwitchEventSchema,
  chainSetEventSchema,
  graphNodeAddEventSchema,
  graphNodeRemoveEventSchema,
  graphEdgeConnectEventSchema,
  graphEdgeDisconnectEventSchema,
  graphParamChangeEventSchema,
  graphNodeMoveEventSchema,
  graphNodeResizeEventSchema,
])

// channel_meta travels via sync:channel_meta — NOT through room:event/syncEventSchema.
// senderId is absent when sending, injected by server before broadcast.
export const channelMetaSchema = z.object({
  channelCount: z.number().int().min(0).max(32),
  channelNames: z.array(z.string().max(64)).max(32),
  senderId: z.string().optional(),
})
export type ChannelMeta = z.infer<typeof channelMetaSchema>
export type ChannelMetaWithSender = ChannelMeta & { senderId: string }

export type SyncEvent = z.infer<typeof syncEventSchema>
export type StepToggleEvent = z.infer<typeof stepToggleEventSchema>
export type TransportPlayEvent = z.infer<typeof transportPlayEventSchema>
export type TransportStopEvent = z.infer<typeof transportStopEventSchema>
export type BpmChangeEvent = z.infer<typeof bpmChangeEventSchema>
export type MicToggleEvent = z.infer<typeof micToggleEventSchema>
export type CameraToggleEvent = z.infer<typeof cameraToggleEventSchema>
export type StepCountChangeEvent = z.infer<typeof stepCountChangeEventSchema>
export type VelocityChangeEvent = z.infer<typeof velocityChangeEventSchema>
export type TimeSignatureChangeEvent = z.infer<typeof timeSignatureChangeEventSchema>
export type MetronomeToggleEvent = z.infer<typeof metronomeToggleEventSchema>
export type SwingChangeEvent = z.infer<typeof swingChangeEventSchema>
export type PatternSwitchEvent = z.infer<typeof patternSwitchEventSchema>
export type ChainSetEvent = z.infer<typeof chainSetEventSchema>
export type GraphSyncNode = z.infer<typeof graphNodeSchema>
export type GraphSyncEdge = z.infer<typeof graphEdgeSchema>
export type GraphNodeAddEvent = z.infer<typeof graphNodeAddEventSchema>
export type GraphNodeRemoveEvent = z.infer<typeof graphNodeRemoveEventSchema>
export type GraphEdgeConnectEvent = z.infer<typeof graphEdgeConnectEventSchema>
export type GraphEdgeDisconnectEvent = z.infer<typeof graphEdgeDisconnectEventSchema>
export type GraphParamChangeEvent = z.infer<typeof graphParamChangeEventSchema>
export type GraphNodeMoveEvent = z.infer<typeof graphNodeMoveEventSchema>
export type GraphNodeResizeEvent = z.infer<typeof graphNodeResizeEventSchema>
