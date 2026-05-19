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
  'strong_beat_change',
  'sync_only_toggle',
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

export const strongBeatChangeEventSchema = syncEventBaseSchema.extend({
  type: z.literal('strong_beat_change'),
  payload: z.object({
    strongBeatIndex: z.number().int().min(0).max(15),
  }),
})

export const syncOnlyToggleEventSchema = syncEventBaseSchema.extend({
  type: z.literal('sync_only_toggle'),
  payload: z.object({
    enabled: z.boolean(),
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
  strongBeatChangeEventSchema,
  syncOnlyToggleEventSchema,
])

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
export type StrongBeatChangeEvent = z.infer<typeof strongBeatChangeEventSchema>
export type SyncOnlyToggleEvent = z.infer<typeof syncOnlyToggleEventSchema>
