const {
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
} = require('../protocol/schemas')

const RATE_WINDOW_MS = 60_000
const MAX_EVENTS_PER_WINDOW = 240
// rtc:signal is bursty (ICE trickle, renegotiation) — its own, more generous
// budget so signaling isn't starved by the shared event limiter (AUDIT §8.B.1).
const MAX_SIGNALS_PER_WINDOW = 600
// Upper bound on a relayed clip WAV (AUDIT §3.2). Matches io maxHttpBufferSize.
const MAX_CLIP_BYTES = 16 * 1024 * 1024

function buildInviteLink(shortCode) {
  const baseUrl = process.env.INVITE_BASE_URL || ''
  return baseUrl ? `${baseUrl}/join/${shortCode}` : null
}

function createRateLimiter(maxEvents = MAX_EVENTS_PER_WINDOW, windowMs = RATE_WINDOW_MS) {
  const map = new Map()

  return {
    consume(socketId) {
      const now = Date.now()
      const current = map.get(socketId)

      if (!current || now >= current.resetAt) {
        map.set(socketId, {
          count: 1,
          resetAt: now + windowMs,
        })
        return true
      }

      if (current.count >= maxEvents) {
        return false
      }

      current.count += 1
      return true
    },
    clear(socketId) {
      map.delete(socketId)
    },
  }
}

function registerSocketHandlers(io, roomManager) {
  const rateLimiter = createRateLimiter()
  const signalLimiter = createRateLimiter(MAX_SIGNALS_PER_WINDOW)

  io.on('connection', (socket) => {
    socket.on('room:create', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      const parsed = createRoomSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const room = roomManager.createRoom(socket.id, parsed.data.username, {
        password: parsed.data.password,
        maxParticipants: parsed.data.maxParticipants,
      })
      socket.join(room.id)

      const participants = roomManager.getParticipants(room.id)
      const syncState = roomManager.getSyncState(room.id)
      const inviteLink = buildInviteLink(room.shortCode)
      ack?.({
        ok: true,
        roomId: room.id,
        shortCode: room.shortCode,
        ...(inviteLink ? { inviteLink } : {}),
        participants,
        syncState,
      })
    })

    socket.on('room:join', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      const parsed = joinRoomSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const result = roomManager.joinRoom(parsed.data.roomId, socket.id, parsed.data.username, parsed.data.password)
      if (!result.ok) {
        ack?.({ ok: false, error: result.error })
        return
      }

      socket.join(parsed.data.roomId)
      const participants = roomManager.getParticipants(parsed.data.roomId)
      const syncState = roomManager.getSyncState(parsed.data.roomId)

      socket.to(parsed.data.roomId).emit('participant:joined', {
        type: 'participant_join',
        payload: {
          socketId: socket.id,
          username: parsed.data.username,
        },
        timestamp: Date.now(),
      })

      ack?.({ ok: true, roomId: parsed.data.roomId, participants, syncState })
    })

    // Join by 4-char short code (user-friendly alternative to UUID join)
    socket.on('room:join-by-code', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      const parsed = joinByCodeSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const room = roomManager.getRoomByShortCode(parsed.data.shortCode)
      if (!room) {
        ack?.({ ok: false, error: 'ROOM_NOT_FOUND' })
        return
      }

      const result = roomManager.joinRoom(room.id, socket.id, parsed.data.username, parsed.data.password)
      if (!result.ok) {
        ack?.({ ok: false, error: result.error })
        return
      }

      socket.join(room.id)
      const participants = roomManager.getParticipants(room.id)
      const syncState = roomManager.getSyncState(room.id)

      socket.to(room.id).emit('participant:joined', {
        type: 'participant_join',
        payload: {
          socketId: socket.id,
          username: parsed.data.username,
        },
        timestamp: Date.now(),
      })

      ack?.({ ok: true, roomId: room.id, participants, syncState })
    })

    socket.on('room:event', (rawEvent, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }

      const parsed = clientEventSchema.safeParse(rawEvent)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      const room = roomManager.getRoom(roomId)
      if (!room) {
        ack?.({ ok: false, error: 'ROOM_NOT_FOUND' })
        return
      }

      const hostOnlyTypes = new Set(['transport_play', 'transport_stop', 'bpm_change', 'step_count_change', 'time_signature_change', 'metronome_toggle', 'swing_change', 'pattern_switch', 'chain_set'])
      if (hostOnlyTypes.has(parsed.data.type) && room.hostSocketId !== socket.id) {
        ack?.({ ok: false, error: 'HOST_AUTHORITY_REQUIRED' })
        return
      }

      // §3.1 ownership (B): a guest may edit/remove only clips they created; the
      // host may touch any. clip_add is always allowed (creates its own clip).
      // Drum steps stay collaborative (single shared pattern, LWW).
      if (room.hostSocketId !== socket.id &&
          (parsed.data.type === 'clip_update' || parsed.data.type === 'clip_remove')) {
        const { timelineNodeId, clipId } = parsed.data.payload
        const owner = roomManager.getClipOwner(roomId, timelineNodeId, clipId)
        if (owner && owner !== socket.id) {
          ack?.({ ok: false, error: 'NOT_CLIP_OWNER' })
          return
        }
      }

      const applied = roomManager.applySyncEvent(roomId, parsed.data, socket.id)
      const rev = applied?.rev // §5.5: server-assigned clip revision, if any

      io.to(roomId).except(socket.id).emit('room:event', {
        ...parsed.data,
        senderId: socket.id,
        ...(rev !== undefined ? { rev } : {}),
      })

      ack?.({ ok: true, ...(rev !== undefined ? { rev } : {}) })
    })

    // Binary WAV relay (T4): sender emits { clipId, data: ArrayBuffer }, server
    // relays to all room members except sender. Not stored server-side.
    socket.on('clip:file', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      if (!rawPayload || typeof rawPayload !== 'object') {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }
      const meta = clipFileMetaSchema.safeParse({ clipId: rawPayload.clipId })
      if (!meta.success || !Buffer.isBuffer(rawPayload.data) || rawPayload.data.length > MAX_CLIP_BYTES) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }
      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }
      socket.to(roomId).emit('clip:file', { clipId: meta.data.clipId, senderId: socket.id, data: rawPayload.data })
      ack?.({ ok: true })
    })

    // Relay WebRTC signaling data between peers in the same room
    socket.on('rtc:signal', (rawPayload, ack) => {
      if (!signalLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      const parsed = rtcSignalSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      // Verify target is in the same room
      const targetRoomId = roomManager.getRoomIdBySocket(parsed.data.targetSocketId)
      if (targetRoomId !== roomId) {
        ack?.({ ok: false, error: 'TARGET_NOT_IN_ROOM' })
        return
      }

      io.to(parsed.data.targetSocketId).emit('rtc:signal', {
        fromSocketId: socket.id,
        signal: parsed.data.signal,
      })

      ack?.({ ok: true })
    })

    socket.on('ping', (rawPayload, ack) => {
      const parsed = pingSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ error: 'INVALID_PAYLOAD' })
        return
      }
      ack?.({ serverTime: Date.now() })
    })

    socket.on('chat_message', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }
      const parsed = chatMessageSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      const participants = roomManager.getParticipants(roomId)
      const sender = participants.find((p) => p.socketId === socket.id)
      const username = sender?.username ?? 'Unknown'

      io.to(roomId).emit('chat_message', {
        roomId,
        senderId: socket.id,
        username,
        text: parsed.data.text,
        ts: Date.now(),
      })

      ack?.({ ok: true })
    })

    socket.on('host_mute', (rawPayload, ack) => {
      const parsed = hostTargetSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      const room = roomManager.getRoom(roomId)
      if (!room || room.hostSocketId !== socket.id) {
        ack?.({ ok: false, error: 'HOST_AUTHORITY_REQUIRED' })
        return
      }

      const targetRoomId = roomManager.getRoomIdBySocket(parsed.data.targetSocketId)
      if (targetRoomId !== roomId) {
        ack?.({ ok: false, error: 'TARGET_NOT_IN_ROOM' })
        return
      }

      const newMuted = roomManager.toggleMuted(roomId, parsed.data.targetSocketId)
      if (newMuted === null) {
        ack?.({ ok: false, error: 'TARGET_NOT_FOUND' })
        return
      }

      io.to(roomId).emit('participant:muted', {
        socketId: parsed.data.targetSocketId,
        muted: newMuted,
      })

      ack?.({ ok: true, muted: newMuted })
    })

    socket.on('host_kick', (rawPayload, ack) => {
      const parsed = hostTargetSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      const room = roomManager.getRoom(roomId)
      if (!room || room.hostSocketId !== socket.id) {
        ack?.({ ok: false, error: 'HOST_AUTHORITY_REQUIRED' })
        return
      }

      if (parsed.data.targetSocketId === socket.id) {
        ack?.({ ok: false, error: 'CANNOT_KICK_SELF' })
        return
      }

      const targetRoomId = roomManager.getRoomIdBySocket(parsed.data.targetSocketId)
      if (targetRoomId !== roomId) {
        ack?.({ ok: false, error: 'TARGET_NOT_IN_ROOM' })
        return
      }

      const targetSocket = io.sockets.sockets.get(parsed.data.targetSocketId)
      if (targetSocket) {
        targetSocket.emit('room:kicked')
        targetSocket.disconnect(true)
      }

      ack?.({ ok: true })
    })

    socket.on('sync:channel_meta', (rawPayload, ack) => {
      if (!rateLimiter.consume(socket.id)) {
        ack?.({ ok: false, error: 'RATE_LIMITED' })
        return
      }

      const parsed = channelMetaSchema.safeParse(rawPayload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'INVALID_PAYLOAD' })
        return
      }

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) {
        ack?.({ ok: false, error: 'ROOM_REQUIRED' })
        return
      }

      io.to(roomId).except(socket.id).emit('sync:channel_meta', {
        ...parsed.data,
        senderId: socket.id,
      })

      ack?.({ ok: true })
    })

    socket.on('participant:rtt', (rawPayload) => {
      const parsed = participantRttSchema.safeParse(rawPayload)
      if (!parsed.success) return

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) return

      // §8.B.2: don't echo the sender its own RTT (N² traffic); peers only.
      socket.to(roomId).emit('participant:rtt', {
        socketId: socket.id,
        rtt: parsed.data.rtt,
      })
    })

    socket.on('disconnect', () => {
      const leaveResult = roomManager.leaveRoom(socket.id)
      rateLimiter.clear(socket.id)
      signalLimiter.clear(socket.id)

      if (!leaveResult) {
        return
      }

      if (leaveResult.cleaned) {
        return
      }

      io.to(leaveResult.roomId).emit('participant:left', {
        type: 'participant_leave',
        payload: {
          socketId: socket.id,
        },
        timestamp: Date.now(),
      })

      const room = roomManager.getRoom(leaveResult.roomId)
      if (room) {
        io.to(leaveResult.roomId).emit('room:host', {
          hostSocketId: room.hostSocketId,
        })
      }
    })
  })
}

module.exports = {
  registerSocketHandlers,
}
