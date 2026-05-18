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
} = require('../protocol/schemas')

const RATE_WINDOW_MS = 60_000
const MAX_EVENTS_PER_WINDOW = 240

function buildInviteLink(shortCode) {
  const baseUrl = process.env.INVITE_BASE_URL || ''
  return baseUrl ? `${baseUrl}/join/${shortCode}` : null
}

function createRateLimiter() {
  const map = new Map()

  return {
    consume(socketId) {
      const now = Date.now()
      const current = map.get(socketId)

      if (!current || now >= current.resetAt) {
        map.set(socketId, {
          count: 1,
          resetAt: now + RATE_WINDOW_MS,
        })
        return true
      }

      if (current.count >= MAX_EVENTS_PER_WINDOW) {
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

  io.on('connection', (socket) => {
    socket.on('room:create', (rawPayload, ack) => {
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

      roomManager.applySyncEvent(roomId, parsed.data)

      io.to(roomId).except(socket.id).emit('room:event', {
        ...parsed.data,
        senderId: socket.id,
      })

      ack?.({ ok: true })
    })

    // Relay WebRTC signaling data between peers in the same room
    socket.on('rtc:signal', (rawPayload, ack) => {
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

    socket.on('participant:rtt', (rawPayload) => {
      const parsed = participantRttSchema.safeParse(rawPayload)
      if (!parsed.success) return

      const roomId = roomManager.getRoomIdBySocket(socket.id)
      if (!roomId) return

      io.to(roomId).emit('participant:rtt', {
        socketId: socket.id,
        rtt: parsed.data.rtt,
      })
    })

    socket.on('disconnect', () => {
      const leaveResult = roomManager.leaveRoom(socket.id)
      rateLimiter.clear(socket.id)

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
