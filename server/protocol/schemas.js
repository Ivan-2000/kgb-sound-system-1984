const { z } = require('zod')

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)

const roomIdSchema = z.uuid()

const createRoomSchema = z.object({
  username: usernameSchema,
})

const joinRoomSchema = z.object({
  roomId: roomIdSchema,
  username: usernameSchema,
})

const joinByCodeSchema = z.object({
  shortCode: z.string().trim().length(4),
  username: usernameSchema,
})

const eventBaseSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  eventId: z.string().trim().min(1),
})

const clientEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('step_toggle'),
    payload: z.object({
      track: z.enum(['kick', 'snare', 'hat', 'crash']),
      step: z.number().int().min(0).max(15),
      value: z.boolean(),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('transport_play'),
    payload: z.object({
      step: z.number().int().min(0).max(15),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('transport_stop'),
    payload: z.object({
      step: z.number().int().min(0).max(15),
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
])

const rtcSignalSchema = z.object({
  targetSocketId: z.string().min(1),
  signal: z.unknown(),
})

module.exports = {
  createRoomSchema,
  joinRoomSchema,
  joinByCodeSchema,
  rtcSignalSchema,
  clientEventSchema,
}
