const { z } = require('zod')

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)

const roomIdSchema = z.uuid()

const passwordSchema = z.string().max(64).optional()

const createRoomSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  maxParticipants: z.number().int().min(2).max(8).optional(),
})

const joinRoomSchema = z.object({
  roomId: roomIdSchema,
  username: usernameSchema,
  password: passwordSchema,
})

const joinByCodeSchema = z.object({
  shortCode: z.string().trim().length(4),
  username: usernameSchema,
  password: passwordSchema,
})

const eventBaseSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  eventId: z.string().trim().min(1),
})

// Per-node drum routing (optional, back-compat): missing → primary 'drum-machine'.
const drumNodeIdSchema = z.string().trim().min(1).max(64).optional()

// Node graph (G2) — shared topology/params/positions
const paramValueSchema = z.union([z.number(), z.string(), z.boolean()])
const vec2Schema = z.object({ x: z.number(), y: z.number() })
const sizeSchema = z.object({ w: z.number(), h: z.number() })
const portRefSchema = z.object({
  nodeId: z.string().trim().min(1).max(64),
  portId: z.string().trim().min(1).max(64),
})
const graphNodeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.string().trim().min(1).max(128),
  params: z.record(z.string().max(64), paramValueSchema),
  panelPos: vec2Schema,
  canvasPos: vec2Schema,
  size: sizeSchema,
  zIndex: z.number(),
  isMinimized: z.boolean(),
})
const graphEdgeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  from: portRefSchema,
  to: portRefSchema,
})

const clientEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('graph_node_add'),
    payload: z.object({ node: graphNodeSchema }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_node_remove'),
    payload: z.object({ nodeId: z.string().trim().min(1).max(64) }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_edge_connect'),
    payload: z.object({ edge: graphEdgeSchema }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_edge_disconnect'),
    payload: z.object({ edgeId: z.string().trim().min(1).max(64) }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_param_change'),
    payload: z.object({
      nodeId: z.string().trim().min(1).max(64),
      paramId: z.string().trim().min(1).max(64),
      value: paramValueSchema,
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_node_move'),
    payload: z.object({
      nodeId: z.string().trim().min(1).max(64),
      view: z.enum(['panel', 'canvas']),
      pos: vec2Schema,
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('graph_node_resize'),
    payload: z.object({
      nodeId: z.string().trim().min(1).max(64),
      size: sizeSchema,
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('step_toggle'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      track: z.enum(['kick', 'snare', 'hat', 'crash']),
      step: z.number().int().min(0).max(31),
      value: z.boolean(),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('transport_play'),
    payload: z.object({
      step: z.number().int().min(0).max(31),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('transport_stop'),
    payload: z.object({
      step: z.number().int().min(0).max(31),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('bpm_change'),
    payload: z.object({
      bpm: z.number().int().min(60).max(240),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('mic_toggle'),
    payload: z.object({
      enabled: z.boolean(),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('camera_toggle'),
    payload: z.object({
      enabled: z.boolean(),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('step_count_change'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      stepCount: z.union([z.literal(8), z.literal(16), z.literal(32)]),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('velocity_change'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      track: z.enum(['kick', 'snare', 'hat', 'crash']),
      step: z.number().int().min(0).max(31),
      velocity: z.number().int().min(1).max(127),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('time_signature_change'),
    payload: z.object({
      beats: z.number().int().min(1).max(16),
      division: z.union([z.literal(4), z.literal(8), z.literal(16)]),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('metronome_toggle'),
    payload: z.object({
      enabled: z.boolean(),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('swing_change'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      swing: z.number().int().min(0).max(100),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('pattern_switch'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      patternIndex: z.number().int().min(0).max(7),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('chain_set'),
    payload: z.object({
      nodeId: drumNodeIdSchema,
      chain: z.array(z.number().int().min(0).max(7)).max(32).nullable(),
    }),
  }),
])

const rtcSignalSchema = z.object({
  targetSocketId: z.string().min(1),
  signal: z.unknown(),
})

const pingSchema = z.object({
  t1: z.number().nonnegative(),
})

const participantRttSchema = z.object({
  rtt: z.number().int().nonnegative().max(60_000),
})

const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(500),
})

const hostTargetSchema = z.object({
  targetSocketId: z.string().min(1),
})

const channelMetaSchema = z.object({
  channelCount: z.number().int().min(0).max(32),
  channelNames: z.array(z.string().max(64)).max(32),
})

module.exports = {
  createRoomSchema,
  joinRoomSchema,
  joinByCodeSchema,
  rtcSignalSchema,
  clientEventSchema,
  pingSchema,
  participantRttSchema,
  chatMessageSchema,
  hostTargetSchema,
  channelMetaSchema,
}
