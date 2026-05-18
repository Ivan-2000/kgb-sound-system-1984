import { z } from 'zod'

export const syncEventTypeSchema = z.enum([
  'step_toggle',
  'transport_play',
  'transport_stop',
  'bpm_change',
  'mic_toggle',
  'camera_toggle',
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
    step: z.number().int().min(0).max(15),
    value: z.boolean(),
  }),
})

export const transportPlayEventSchema = syncEventBaseSchema.extend({
  type: z.literal('transport_play'),
  payload: z.object({
    step: z.number().int().min(0).max(15),
  }),
})

export const transportStopEventSchema = syncEventBaseSchema.extend({
  type: z.literal('transport_stop'),
  payload: z.object({
    step: z.number().int().min(0).max(15),
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

export const syncEventSchema = z.discriminatedUnion('type', [
  stepToggleEventSchema,
  transportPlayEventSchema,
  transportStopEventSchema,
  bpmChangeEventSchema,
  micToggleEventSchema,
  cameraToggleEventSchema,
])

export type SyncEvent = z.infer<typeof syncEventSchema>
export type StepToggleEvent = z.infer<typeof stepToggleEventSchema>
export type TransportPlayEvent = z.infer<typeof transportPlayEventSchema>
export type TransportStopEvent = z.infer<typeof transportStopEventSchema>
export type BpmChangeEvent = z.infer<typeof bpmChangeEventSchema>
export type MicToggleEvent = z.infer<typeof micToggleEventSchema>
export type CameraToggleEvent = z.infer<typeof cameraToggleEventSchema>
