// N1 — RoomManager state integrity (AUDIT §3.3, §3.4, §3.5, §3.1 ownership).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { RoomManager } = require('../../server/rooms/roomManager.js')

const clipAdd = (id, sender, extra = {}) => ({
  type: 'clip_add',
  payload: {
    timelineNodeId: 'tl1', trackKey: 't', trackName: 'T', trackKind: 'audio',
    clip: { id, startSec: 0, durSec: 1, label: 'x', kind: 'audio' },
    ...extra,
  },
  _sender: sender,
})

describe('§3.3 room lifecycle', () => {
  it('re-creating from the same socket does not orphan the old room', () => {
    const rm = new RoomManager()
    const a = rm.createRoom('host1', 'H')
    const b = rm.createRoom('host1', 'H')
    expect(a.id).not.toBe(b.id)
    expect(rm.getRoom(a.id)).toBeUndefined() // old room cleaned up
    expect(rm.getRoom(b.id)).toBeTruthy()
  })

  it('deletes the room when the last participant leaves', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    const res = rm.leaveRoom('host1')
    expect(res.cleaned).toBe(true)
    expect(rm.getRoom(room.id)).toBeUndefined()
  })

  it('reassigns host when the host leaves but others remain', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    rm.joinRoom(room.id, 'guest1', 'G')
    rm.leaveRoom('host1')
    expect(rm.getRoom(room.id).hostSocketId).toBe('guest1')
  })
})

describe('§3.5 password (constant-time)', () => {
  it('accepts the correct password and rejects the wrong one', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H', { password: 'secret' })
    expect(rm.joinRoom(room.id, 'g1', 'G', 'secret').ok).toBe(true)
    expect(rm.joinRoom(room.id, 'g2', 'G', 'nope').ok).toBe(false)
  })
  it('an open room ignores any supplied password', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    expect(rm.joinRoom(room.id, 'g1', 'G', 'whatever').ok).toBe(true)
  })
})

describe('§3.4 growth caps', () => {
  it('rejects joins past maxParticipants', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H', { maxParticipants: 2 })
    expect(rm.joinRoom(room.id, 'g1', 'G').ok).toBe(true)
    expect(rm.joinRoom(room.id, 'g2', 'G').ok).toBe(false) // full
  })

  it('ignores new clips past MAX_CLIPS_PER_TIMELINE but still updates existing', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    for (let i = 0; i < 1000; i++) rm.applySyncEvent(room.id, clipAdd(`c${i}`, 'host1'), 'host1')
    rm.applySyncEvent(room.id, clipAdd('overflow', 'host1'), 'host1')
    expect(rm.getClipOwner(room.id, 'tl1', 'overflow')).toBeNull() // dropped
    // existing clip still updatable
    rm.applySyncEvent(room.id, {
      type: 'clip_update', payload: { timelineNodeId: 'tl1', clipId: 'c0', patch: { startSec: 5 } },
    }, 'host1')
    const ss = rm.getSyncState(room.id)
    expect(ss.timelineClips.tl1.c0.startSec).toBe(5)
  })
})

describe('generateShortCode', () => {
  it('produces 4 chars from the safe alphabet, no lookalikes', () => {
    const rm = new RoomManager()
    for (let i = 0; i < 200; i++) {
      const room = rm.createRoom(`h${i}`, 'H')
      expect(room.shortCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/)
      rm.leaveRoom(`h${i}`)
    }
  })
})

describe('§3.1 clip ownership (model B)', () => {
  it('records the first writer as owner and keeps it across re-adds', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    rm.joinRoom(room.id, 'guestA', 'A')
    rm.joinRoom(room.id, 'guestB', 'B')
    rm.applySyncEvent(room.id, clipAdd('c1', 'guestA'), 'guestA')
    expect(rm.getClipOwner(room.id, 'tl1', 'c1')).toBe('guestA')
    // re-add by a different sender must not steal ownership
    rm.applySyncEvent(room.id, clipAdd('c1', 'guestB'), 'guestB')
    expect(rm.getClipOwner(room.id, 'tl1', 'c1')).toBe('guestA')
  })
  it('getClipOwner is null for unknown clips', () => {
    const rm = new RoomManager()
    const room = rm.createRoom('host1', 'H')
    expect(rm.getClipOwner(room.id, 'tl1', 'nope')).toBeNull()
  })
})
