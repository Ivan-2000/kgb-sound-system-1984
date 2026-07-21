// N1 — Zod validation of socket payloads (AUDIT §3.2, §3.7, §8.B.1).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  createRoomSchema,
  rtcSignalSchema,
  clientEventSchema,
  clipFileMetaSchema,
} = require('../../server/protocol/schemas.js')

describe('createRoomSchema', () => {
  it('accepts a valid username', () => {
    expect(createRoomSchema.safeParse({ username: 'Ivan' }).success).toBe(true)
  })
  it('rejects empty / whitespace-only username', () => {
    expect(createRoomSchema.safeParse({ username: '' }).success).toBe(false)
    expect(createRoomSchema.safeParse({ username: '   ' }).success).toBe(false)
  })
  it('rejects username longer than 32 chars', () => {
    expect(createRoomSchema.safeParse({ username: 'x'.repeat(33) }).success).toBe(false)
  })
  it('§3.7 rejects control characters in username, keeps emoji', () => {
    expect(createRoomSchema.safeParse({ username: 'Iv\nan' }).success).toBe(false)
    expect(createRoomSchema.safeParse({ username: 'Ivan\u{1F3B8}' }).success).toBe(true)
  })
  it('clamps maxParticipants to 2..8', () => {
    expect(createRoomSchema.safeParse({ username: 'a', maxParticipants: 1 }).success).toBe(false)
    expect(createRoomSchema.safeParse({ username: 'a', maxParticipants: 9 }).success).toBe(false)
    expect(createRoomSchema.safeParse({ username: 'a', maxParticipants: 8 }).success).toBe(true)
  })
})

describe('clientEventSchema (clip_add)', () => {
  const validClipAdd = {
    type: 'clip_add',
    timestamp: 1,
    eventId: 'e1',
    payload: {
      timelineNodeId: 'tl1',
      trackKey: 'track-1',
      trackName: 'Track 1',
      trackKind: 'audio',
      clip: { id: 'c1', startSec: 0, durSec: 1, label: 'x', kind: 'audio' },
    },
  }
  it('accepts a valid clip_add', () => {
    expect(clientEventSchema.safeParse(validClipAdd).success).toBe(true)
  })
  it('rejects negative durSec', () => {
    const bad = structuredClone(validClipAdd)
    bad.payload.clip.durSec = -1
    expect(clientEventSchema.safeParse(bad).success).toBe(false)
  })
  it('rejects clip id longer than 64 chars', () => {
    const bad = structuredClone(validClipAdd)
    bad.payload.clip.id = 'x'.repeat(65)
    expect(clientEventSchema.safeParse(bad).success).toBe(false)
  })
  it('rejects an unknown event type', () => {
    expect(clientEventSchema.safeParse({ type: 'nope', timestamp: 1, eventId: 'e' }).success).toBe(false)
  })
})

describe('§8.B.1 rtcSignalSchema narrowing', () => {
  it('accepts an object signal and preserves all keys', () => {
    const r = rtcSignalSchema.safeParse({ targetSocketId: 'x', signal: { type: 'answer', sdp: 'abc', candidate: 'c' } })
    expect(r.success).toBe(true)
    expect(r.data.signal).toEqual({ type: 'answer', sdp: 'abc', candidate: 'c' })
  })
  it('accepts the native _kgbAudio wrapper', () => {
    expect(rtcSignalSchema.safeParse({ targetSocketId: 'x', signal: { _kgbAudio: true } }).success).toBe(true)
  })
  it('rejects scalar / array / null signals', () => {
    expect(rtcSignalSchema.safeParse({ targetSocketId: 'x', signal: 'pwn' }).success).toBe(false)
    expect(rtcSignalSchema.safeParse({ targetSocketId: 'x', signal: [1, 2] }).success).toBe(false)
    expect(rtcSignalSchema.safeParse({ targetSocketId: 'x', signal: null }).success).toBe(false)
  })
})

describe('clipFileMetaSchema', () => {
  it('accepts a valid clipId', () => {
    expect(clipFileMetaSchema.safeParse({ clipId: 'c1' }).success).toBe(true)
  })
  it('rejects empty / oversized clipId', () => {
    expect(clipFileMetaSchema.safeParse({ clipId: '' }).success).toBe(false)
    expect(clipFileMetaSchema.safeParse({ clipId: 'x'.repeat(65) }).success).toBe(false)
  })
})
