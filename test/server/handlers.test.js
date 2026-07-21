// N1 — socket handler authorization (AUDIT §3.1 host-gating + clip ownership).
// Uses the real RoomManager with a minimal fake Socket.IO server.
import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { RoomManager } = require('../../server/rooms/roomManager.js')
const { registerSocketHandlers } = require('../../server/socket/registerSocketHandlers.js')

function makeHarness() {
  const rm = new RoomManager()
  const emitted = []
  const sink = (room, except) => ({
    emit: (event, payload) => emitted.push({ room, except, event, payload }),
  })
  const io = {
    _connect: null,
    on(ev, cb) { if (ev === 'connection') this._connect = cb },
    to(room) { return { except: (id) => sink(room, id), emit: (event, payload) => emitted.push({ room, except: null, event, payload }) } },
    sockets: { sockets: new Map() },
  }
  registerSocketHandlers(io, rm)

  function connect(id) {
    const handlers = {}
    const socket = {
      id,
      on(ev, cb) { handlers[ev] = cb },
      join() {},
      to(room) { return sink(room, id) },
      emit(event, payload) { emitted.push({ room: id, except: null, event, payload, direct: true }) },
      disconnect() {},
    }
    io.sockets.sockets.set(id, socket)
    io._connect(socket)
    const send = (ev, payload) => new Promise((resolve) => {
      const h = handlers[ev]
      if (!h) return resolve({ ok: false, error: 'NO_HANDLER' })
      h(payload, resolve)
    })
    return { socket, send }
  }
  return { rm, emitted, connect }
}

const evt = (type, payload, id = 'e') => ({ type, payload, timestamp: 1, eventId: id })
const clip = (id) => ({
  timelineNodeId: 'tl1', trackKey: 't', trackName: 'T', trackKind: 'audio',
  clip: { id, startSec: 0, durSec: 1, label: 'x', kind: 'audio' },
})

describe('§3.1 host-gating of transport events', () => {
  let h, host, guest, roomId
  beforeEach(async () => {
    h = makeHarness()
    host = h.connect('host1')
    const res = await host.send('room:create', { username: 'Host' })
    roomId = res.roomId
    guest = h.connect('guestA')
    await guest.send('room:join', { roomId, username: 'A' })
  })

  it('rejects transport_play from a guest', async () => {
    const res = await guest.send('room:event', evt('transport_play', { step: 0 }))
    expect(res.ok).toBe(false)
    expect(res.error).toBe('HOST_AUTHORITY_REQUIRED')
  })
  it('allows transport_play from the host', async () => {
    const res = await host.send('room:event', evt('transport_play', { step: 0 }))
    expect(res.ok).toBe(true)
  })
})

describe('§3.1 clip ownership (model B)', () => {
  let h, host, guestA, guestB, roomId
  beforeEach(async () => {
    h = makeHarness()
    host = h.connect('host1')
    roomId = (await host.send('room:create', { username: 'Host' })).roomId
    guestA = h.connect('guestA')
    guestB = h.connect('guestB')
    await guestA.send('room:join', { roomId, username: 'A' })
    await guestB.send('room:join', { roomId, username: 'B' })
    await guestA.send('room:event', evt('clip_add', clip('c1'), 'e-add'))
  })

  it('lets a guest add their own clip', () => {
    expect(h.rm.getClipOwner(roomId, 'tl1', 'c1')).toBe('guestA')
  })
  it("blocks a guest from removing another guest's clip", async () => {
    const res = await guestB.send('room:event', evt('clip_remove', { timelineNodeId: 'tl1', clipId: 'c1' }, 'e-rm'))
    expect(res.ok).toBe(false)
    expect(res.error).toBe('NOT_CLIP_OWNER')
    expect(h.rm.getClipOwner(roomId, 'tl1', 'c1')).toBe('guestA') // untouched
  })
  it('lets the owner remove their own clip', async () => {
    const res = await guestA.send('room:event', evt('clip_remove', { timelineNodeId: 'tl1', clipId: 'c1' }, 'e-rm'))
    expect(res.ok).toBe(true)
    expect(h.rm.getClipOwner(roomId, 'tl1', 'c1')).toBeNull()
  })
  it('lets the host remove anyone’s clip', async () => {
    const res = await host.send('room:event', evt('clip_remove', { timelineNodeId: 'tl1', clipId: 'c1' }, 'e-rm'))
    expect(res.ok).toBe(true)
  })
})

describe('§5.5 rev in ack and broadcast', () => {
  let h, host, guest, roomId
  beforeEach(async () => {
    h = makeHarness()
    host = h.connect('host1')
    roomId = (await host.send('room:create', { username: 'Host' })).roomId
    guest = h.connect('guestA')
    await guest.send('room:join', { roomId, username: 'A' })
  })

  it('acks the sender with the server-assigned rev', async () => {
    const res = await guest.send('room:event', evt('clip_add', clip('c1'), 'e1'))
    expect(res.ok).toBe(true)
    expect(res.rev).toBe(1)
  })

  it('includes rev in the relayed broadcast', async () => {
    await guest.send('room:event', evt('clip_add', clip('c1'), 'e1'))
    const relayed = h.emitted.filter((e) => e.event === 'room:event' && e.payload.type === 'clip_add')
    expect(relayed.length).toBe(1)
    expect(relayed[0].payload.rev).toBe(1)
    expect(relayed[0].except).toBe('guestA') // not echoed to sender
  })

  it('omits rev for non-clip events', async () => {
    const res = await host.send('room:event', evt('transport_play', { step: 0 }, 'e2'))
    expect(res.ok).toBe(true)
    expect(res.rev).toBeUndefined()
  })
})

describe('§5.3 late-joiner clip audio replay', () => {
  it('replays stored clip files to a newly joined socket', async () => {
    const h = makeHarness()
    const host = h.connect('host1')
    const roomId = (await host.send('room:create', { username: 'Host' })).roomId
    // host records + uploads a clip's WAV
    const up = await host.send('clip:file', { clipId: 'c1', data: Buffer.from('WAVDATA') })
    expect(up.ok).toBe(true)

    // a late joiner connects after the recording exists
    const late = h.connect('lateGuest')
    await late.send('room:join', { roomId, username: 'Late' })

    const got = h.emitted.filter((e) => e.event === 'clip:file' && e.direct && e.room === 'lateGuest')
    expect(got.length).toBe(1)
    expect(got[0].payload.clipId).toBe('c1')
    expect(Buffer.from(got[0].payload.data).toString()).toBe('WAVDATA')
  })

  it('does not replay a clip whose file was removed', async () => {
    const h = makeHarness()
    const host = h.connect('host1')
    const roomId = (await host.send('room:create', { username: 'Host' })).roomId
    await host.send('clip:file', { clipId: 'c1', data: Buffer.from('WAVDATA') })
    await host.send('room:event', evt('clip_remove', { timelineNodeId: 'tl1', clipId: 'c1' }, 'e-rm'))

    const late = h.connect('lateGuest')
    await late.send('room:join', { roomId, username: 'Late' })
    const got = h.emitted.filter((e) => e.event === 'clip:file' && e.direct && e.room === 'lateGuest')
    expect(got.length).toBe(0)
  })
})

describe('§5.8 tempo lock while recording', () => {
  let h, host, guest, roomId
  beforeEach(async () => {
    h = makeHarness()
    host = h.connect('host1')
    roomId = (await host.send('room:create', { username: 'Host' })).roomId
    guest = h.connect('guestA')
    await guest.send('room:join', { roomId, username: 'A' })
  })

  it('rejects host bpm_change while a guest is recording', async () => {
    const ack = await guest.send('record:set', { recording: true })
    expect(ack.ok).toBe(true)
    const res = await host.send('room:event', evt('bpm_change', { bpm: 140 }, 'e-bpm'))
    expect(res.ok).toBe(false)
    expect(res.error).toBe('RECORDING_IN_PROGRESS')
  })

  it('allows bpm_change once recording stops', async () => {
    await guest.send('record:set', { recording: true })
    await guest.send('record:set', { recording: false })
    const res = await host.send('room:event', evt('bpm_change', { bpm: 140 }, 'e-bpm'))
    expect(res.ok).toBe(true)
  })
})
