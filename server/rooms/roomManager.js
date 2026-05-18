const { randomUUID, randomBytes } = require('node:crypto')

const STEP_COUNT = 16

// Safe alphabet: no 0/O/1/I to avoid visual confusion
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SHORT_CODE_LENGTH = 4
const SHORT_CODE_MAX_RETRIES = 10

function generateShortCode() {
  const bytes = randomBytes(SHORT_CODE_LENGTH)
  let code = ''
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length]
  }
  return code
}

function createEmptyPattern() {
  return {
    kick: Array(STEP_COUNT).fill(false),
    snare: Array(STEP_COUNT).fill(false),
    hat: Array(STEP_COUNT).fill(false),
    crash: Array(STEP_COUNT).fill(false),
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map()
    this.socketToRoom = new Map()
    this.shortCodeToRoomId = new Map()
  }

  _allocateShortCode() {
    for (let attempt = 0; attempt < SHORT_CODE_MAX_RETRIES; attempt++) {
      const code = generateShortCode()
      if (!this.shortCodeToRoomId.has(code)) {
        return code
      }
    }
    // Fallback: UUID prefix (should never happen in practice)
    return randomUUID().slice(0, 6).toUpperCase()
  }

  createRoom(hostSocketId, username, { password = null, maxParticipants = 8 } = {}) {
    const roomId = randomUUID()
    const shortCode = this._allocateShortCode()
    const room = {
      id: roomId,
      shortCode,
      hostSocketId,
      createdAt: Date.now(),
      password,
      maxParticipants,
      participants: new Map(),
      syncState: {
        bpm: 120,
        isPlaying: false,
        currentStep: 0,
        pattern: createEmptyPattern(),
      },
    }

    room.participants.set(hostSocketId, {
      socketId: hostSocketId,
      username,
      joinedAt: Date.now(),
      isHost: true,
    })

    this.rooms.set(roomId, room)
    this.shortCodeToRoomId.set(shortCode, roomId)
    this.socketToRoom.set(hostSocketId, roomId)
    return room
  }

  getRoomByShortCode(shortCode) {
    const roomId = this.shortCodeToRoomId.get(shortCode.toUpperCase())
    if (!roomId) return null
    return this.rooms.get(roomId) || null
  }

  joinRoom(roomId, socketId, username, password = null) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return { ok: false, error: 'ROOM_NOT_FOUND' }
    }

    if (room.participants.has(socketId)) {
      return { ok: true, room }
    }

    if (room.password !== null && room.password !== password) {
      return { ok: false, error: 'WRONG_PASSWORD' }
    }

    if (room.participants.size >= room.maxParticipants) {
      return { ok: false, error: 'ROOM_FULL' }
    }

    room.participants.set(socketId, {
      socketId,
      username,
      joinedAt: Date.now(),
      isHost: socketId === room.hostSocketId,
    })
    this.socketToRoom.set(socketId, roomId)
    return { ok: true, room }
  }

  leaveRoom(socketId) {
    const roomId = this.socketToRoom.get(socketId)
    if (!roomId) {
      return null
    }

    const room = this.rooms.get(roomId)
    if (!room) {
      this.socketToRoom.delete(socketId)
      return null
    }

    const participant = room.participants.get(socketId)
    room.participants.delete(socketId)
    this.socketToRoom.delete(socketId)

    if (room.participants.size === 0) {
      this.shortCodeToRoomId.delete(room.shortCode)
      this.rooms.delete(roomId)
      return { roomId, cleaned: true, participant }
    }

    if (room.hostSocketId === socketId) {
      const nextHost = room.participants.values().next().value
      room.hostSocketId = nextHost.socketId
      nextHost.isHost = true
    }

    return { roomId, cleaned: false, participant }
  }

  getRoom(roomId) {
    return this.rooms.get(roomId)
  }

  getRoomIdBySocket(socketId) {
    return this.socketToRoom.get(socketId) || null
  }

  getParticipants(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return []
    }

    return Array.from(room.participants.values()).map((participant) => ({
      socketId: participant.socketId,
      username: participant.username,
      isHost: participant.isHost,
    }))
  }

  getSyncState(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return null
    }

    return {
      bpm: room.syncState.bpm,
      isPlaying: room.syncState.isPlaying,
      currentStep: room.syncState.currentStep,
      pattern: {
        kick: [...room.syncState.pattern.kick],
        snare: [...room.syncState.pattern.snare],
        hat: [...room.syncState.pattern.hat],
        crash: [...room.syncState.pattern.crash],
      },
    }
  }

  applySyncEvent(roomId, event) {
    const room = this.rooms.get(roomId)
    if (!room) {
      return
    }

    if (event.type === 'step_toggle') {
      room.syncState.pattern[event.payload.track][event.payload.step] = event.payload.value
      room.syncState.currentStep = event.payload.step
      return
    }

    if (event.type === 'bpm_change') {
      room.syncState.bpm = event.payload.bpm
      return
    }

    if (event.type === 'transport_play') {
      room.syncState.isPlaying = true
      room.syncState.currentStep = event.payload.step
      return
    }

    if (event.type === 'transport_stop') {
      room.syncState.isPlaying = false
      room.syncState.currentStep = event.payload.step
    }
  }
}

module.exports = {
  RoomManager,
}
