const { z } = require('zod')

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // §3.7: reject control chars (newlines, NUL, etc.) in display names.
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), { message: 'no control characters' })

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

// ── Timeline clip sync (T4) ──────────────────────────────────────────────────
const clipPayloadSchema = z.object({
  id: z.string().trim().min(1).max(64),
  startSec: z.number().min(0),
  durSec: z.number().min(0),
  label: z.string().max(128),
  kind: z.enum(['audio', 'midi']),
  proxy: z.boolean().optional(),
})

const clientEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('clip_add'),
    payload: z.object({
      timelineNodeId: z.string().trim().min(1).max(64),
      trackKey: z.string().trim().min(1).max(128),
      trackName: z.string().max(128),
      trackKind: z.enum(['audio', 'midi']),
      trackColor: z.string().max(64).optional(),
      clip: clipPayloadSchema,
    }),
  }),
  eventBaseSchema.extend({
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
  }),
  eventBaseSchema.extend({
    type: z.literal('clip_remove'),
    payload: z.object({
      timelineNodeId: z.string().trim().min(1).max(64),
      clipId: z.string().trim().min(1).max(64),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('step_toggle'),
    payload: z.object({
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
      stepCount: z.union([z.literal(8), z.literal(16), z.literal(32)]),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('velocity_change'),
    payload: z.object({
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
      swing: z.number().int().min(0).max(100),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('pattern_switch'),
    payload: z.object({
      patternIndex: z.number().int().min(0).max(7),
    }),
  }),
  eventBaseSchema.extend({
    type: z.literal('chain_set'),
    payload: z.object({
      chain: z.array(z.number().int().min(0).max(7)).max(32).nullable(),
    }),
  }),
])

const rtcSignalSchema = z.object({
  targetSocketId: z.string().min(1),
  // §8.B.1: opaque signaling blob (SDP offer/answer/renegotiate, ICE candidate,
  // or {_kgbAudio} native wrapper). Require an object — rejects scalars/arrays that
  // can't be a valid simple-peer signal — while preserving every key. Size is bounded
  // by io.maxHttpBufferSize; frequency by the dedicated signalLimiter in the handler.
  signal: z.record(z.string(), z.unknown()),
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

const clipFileMetaSchema = z.object({
  clipId: z.string().trim().min(1).max(64),
})

// §5.8: a client announces whether it currently has a recording in progress.
const recordStateSchema = z.object({
  recording: z.boolean(),
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
  clipFileMetaSchema,
  recordStateSchema,
}
