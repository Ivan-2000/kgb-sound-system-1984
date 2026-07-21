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
  'clip_add',
  'clip_update',
  'clip_remove',
])

export const drumTrackSchema = z.enum(['kick', 'snare', 'hat', 'crash'])

export const syncEventBaseSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  eventId: z.string().trim().min(1),
  // Injected by server when relaying — never sent by client
  senderId: z.string().optional(),
})

export const stepToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('step_toggle'),
  payload: z.object({
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
    stepCount: z.union([z.literal(8), z.literal(16), z.literal(32)]),
  }),
})

export const velocityChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('velocity_change'),
  payload: z.object({
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
    swing: z.number().int().min(0).max(100),
  }),
})

export const patternSwitchEventSchema = syncEventBaseSchema.extend({
  type: z.literal('pattern_switch'),
  payload: z.object({
    patternIndex: z.number().int().min(0).max(7),
  }),
})

export const chainSetEventSchema = syncEventBaseSchema.extend({
  type: z.literal('chain_set'),
  payload: z.object({
    chain: z.array(z.number().int().min(0).max(7)).max(32).nullable(),
  }),
})

// ── Timeline clip sync (T4) ──────────────────────────────────────────────────

const clipPayloadSchema = z.object({
  id: z.string().trim().min(1).max(64),
  startSec: z.number().min(0),
  durSec: z.number().min(0),
  label: z.string().max(128),
  kind: z.enum(['audio', 'midi']),
  proxy: z.boolean().optional(),
})

export const clipAddEventSchema = syncEventBaseSchema.extend({
  type: z.literal('clip_add'),
  payload: z.object({
    timelineNodeId: z.string().trim().min(1).max(64),
    trackKey: z.string().trim().min(1).max(128),
    trackName: z.string().max(128),
    trackKind: z.enum(['audio', 'midi']),
    trackColor: z.string().max(64).optional(),
    clip: clipPayloadSchema,
  }),
})

export const clipUpdateEventSchema = syncEventBaseSchema.extend({
  type: z.literal('clip_update'),
  payload: z.object({
    timelineNodeId: z.string().trim().min(1).max(64),
    clipId: z.string().trim().min(1).max(64),
    patch: z.object({
      startSec: z.number().min(0).optional(),
      durSec: z.number().min(0).optional(),
      label: z.string().max(128).optional(),
      proxy: z.boolean().optional(),
    }),
  }),
})

export const clipRemoveEventSchema = syncEventBaseSchema.extend({
  type: z.literal('clip_remove'),
  payload: z.object({
    timelineNodeId: z.string().trim().min(1).max(64),
    clipId: z.string().trim().min(1).max(64),
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
  clipAddEventSchema,
  clipUpdateEventSchema,
  clipRemoveEventSchema,
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
export type ClipAddEvent = z.infer<typeof clipAddEventSchema>
export type ClipUpdateEvent = z.infer<typeof clipUpdateEventSchema>
export type ClipRemoveEvent = z.infer<typeof clipRemoveEventSchema>
