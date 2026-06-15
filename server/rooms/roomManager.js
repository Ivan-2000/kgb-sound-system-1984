const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto')

const DEFAULT_STEP_COUNT = 16
const MAX_PATTERNS = 8
const DEFAULT_VELOCITY = 100
// Cap clips per timeline to bound room-state growth (AUDIT §3.4).
const MAX_CLIPS_PER_TIMELINE = 1000

// Constant-time room-password check (AUDIT §3.5: avoid timing side-channel).
// Passwords are ephemeral in-memory only — not persisted, not hashed.
function passwordMatches(stored, provided) {
  if (stored === null) return true
  const a = Buffer.from(String(stored))
  const b = Buffer.from(String(provided ?? ''))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

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

function createEmptyPattern(stepCount = DEFAULT_STEP_COUNT) {
  return {
    kick: Array(stepCount).fill(false),
    snare: Array(stepCount).fill(false),
    hat: Array(stepCount).fill(false),
    crash: Array(stepCount).fill(false),
  }
}

function createDefaultVelocity(stepCount = DEFAULT_STEP_COUNT) {
  return {
    kick: Array(stepCount).fill(DEFAULT_VELOCITY),
    snare: Array(stepCount).fill(DEFAULT_VELOCITY),
    hat: Array(stepCount).fill(DEFAULT_VELOCITY),
    crash: Array(stepCount).fill(DEFAULT_VELOCITY),
  }
}

function createEmptySlot(stepCount = DEFAULT_STEP_COUNT) {
  return {
    pattern: createEmptyPattern(stepCount),
    velocity: createDefaultVelocity(stepCount),
    stepCount,
  }
}

// Drum Machine state (single instance per room, stored in s.drum).
function createDrumState() {
  return {
    activePatternIndex: 0,
    swing: 0,
    chain: null,
    patternBank: Array.from({ length: MAX_PATTERNS }, () => createEmptySlot()),
  }
}

function createInitialSyncState() {
  return {
    bpm: 120,
    isPlaying: false,
    currentStep: 0,
    metronomeEnabled: false,
    timeSignature: { beats: 4, division: 4 },
    // Single drum machine state (one per room).
    drum: createDrumState(),
    // Timeline clips (T4): per-timeline clip state for late joiners.
    // { [timelineNodeId]: { [clipId]: { id, trackKey, trackName, trackKind, trackColor, startSec, durSec, label, kind, proxy } } }
    timelineClips: {},
  }
}

function cloneSlot(slot) {
  return {
    pattern: {
      kick: [...slot.pattern.kick],
      snare: [...slot.pattern.snare],
      hat: [...slot.pattern.hat],
      crash: [...slot.pattern.crash],
    },
    velocity: {
      kick: [...slot.velocity.kick],
      snare: [...slot.velocity.snare],
      hat: [...slot.velocity.hat],
      crash: [...slot.velocity.crash],
    },
    stepCount: slot.stepCount,
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
      if (!this.shortCodeToRoomId.has(code)) return code
    }
    return randomUUID().slice(0, 6).toUpperCase()
  }

  createRoom(hostSocketId, username, { password = null, maxParticipants = 8 } = {}) {
    // Repeated room:create from the same socket would orphan the previous room
    // (AUDIT §3.3 memory leak). Detach first — reassigns host or deletes if empty.
    if (this.socketToRoom.has(hostSocketId)) this.leaveRoom(hostSocketId)
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
      syncState: createInitialSyncState(),
    }

    room.participants.set(hostSocketId, {
      socketId: hostSocketId,
      username,
      joinedAt: Date.now(),
      isHost: true,
      muted: false,
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
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' }
    if (room.participants.has(socketId)) return { ok: true, room }
    if (!passwordMatches(room.password, password)) return { ok: false, error: 'WRONG_PASSWORD' }
    if (room.participants.size >= room.maxParticipants) return { ok: false, error: 'ROOM_FULL' }

    room.participants.set(socketId, {
      socketId, username, joinedAt: Date.now(), isHost: socketId === room.hostSocketId, muted: false,
    })
    this.socketToRoom.set(socketId, roomId)
    return { ok: true, room }
  }

  leaveRoom(socketId) {
    const roomId = this.socketToRoom.get(socketId)
    if (!roomId) return null

    const room = this.rooms.get(roomId)
    if (!room) { this.socketToRoom.delete(socketId); return null }

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

  getRoom(roomId) { return this.rooms.get(roomId) }
  getRoomIdBySocket(socketId) { return this.socketToRoom.get(socketId) || null }

  toggleMuted(roomId, socketId) {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const p = room.participants.get(socketId)
    if (!p) return null
    p.muted = !p.muted
    return p.muted
  }

  getParticipants(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return []
    return Array.from(room.participants.values()).map((p) => ({
      socketId: p.socketId, username: p.username, isHost: p.isHost, muted: p.muted,
    }))
  }

  getSyncState(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const s = room.syncState
    const drum = s.drum
    return {
      bpm: s.bpm,
      isPlaying: s.isPlaying,
      currentStep: s.currentStep,
      activePatternIndex: drum.activePatternIndex,
      swing: drum.swing,
      patternBank: drum.patternBank.map(cloneSlot),
      chain: drum.chain ? [...drum.chain] : null,
      metronomeEnabled: s.metronomeEnabled,
      timeSignature: { ...s.timeSignature },
      timelineClips: Object.fromEntries(
        Object.entries(s.timelineClips).map(([tid, clips]) => [
          tid,
          Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, { ...c }])),
        ]),
      ),
    }
  }

  applySyncEvent(roomId, event) {
    const room = this.rooms.get(roomId)
    if (!room) return
    const s = room.syncState

    if (event.type === 'step_toggle') {
      const d = s.drum
      d.patternBank[d.activePatternIndex].pattern[event.payload.track][event.payload.step] = event.payload.value
      return
    }

    if (event.type === 'bpm_change') { s.bpm = event.payload.bpm; return }

    if (event.type === 'transport_play') {
      s.isPlaying = true; s.currentStep = event.payload.step; return
    }

    if (event.type === 'transport_stop') {
      s.isPlaying = false; s.currentStep = event.payload.step; return
    }

    if (event.type === 'step_count_change') {
      const d = s.drum
      const activeSlot = d.patternBank[d.activePatternIndex]
      const next = event.payload.stepCount
      const tracks = ['kick', 'snare', 'hat', 'crash']
      for (const track of tracks) {
        const p = activeSlot.pattern[track]
        activeSlot.pattern[track] = Array.from({ length: next }, (_, i) => p[i] ?? false)
        const v = activeSlot.velocity[track]
        activeSlot.velocity[track] = Array.from({ length: next }, (_, i) => v[i] ?? DEFAULT_VELOCITY)
      }
      activeSlot.stepCount = next
      s.currentStep = 0
      return
    }

    if (event.type === 'velocity_change') {
      const d = s.drum
      d.patternBank[d.activePatternIndex].velocity[event.payload.track][event.payload.step] = event.payload.velocity
      return
    }

    if (event.type === 'time_signature_change') {
      s.timeSignature = { beats: event.payload.beats, division: event.payload.division }
      return
    }

    if (event.type === 'metronome_toggle') { s.metronomeEnabled = event.payload.enabled; return }

    if (event.type === 'swing_change') {
      s.drum.swing = event.payload.swing
      return
    }

    if (event.type === 'pattern_switch') {
      const idx = event.payload.patternIndex
      if (idx >= 0 && idx < MAX_PATTERNS) {
        s.drum.activePatternIndex = idx
        s.currentStep = 0
      }
      return
    }

    if (event.type === 'chain_set') {
      s.drum.chain = event.payload.chain
      return
    }

    // ── Timeline clip sync (T4) ──────────────────────────────────────────────
    if (event.type === 'clip_add') {
      const { timelineNodeId, trackKey, trackName, trackKind, trackColor, clip } = event.payload
      if (!s.timelineClips[timelineNodeId]) s.timelineClips[timelineNodeId] = {}
      const tl = s.timelineClips[timelineNodeId]
      // Bound growth: ignore new clip ids past the cap (updates to existing ids pass).
      if (!(clip.id in tl) && Object.keys(tl).length >= MAX_CLIPS_PER_TIMELINE) return
      tl[clip.id] = { ...clip, trackKey, trackName, trackKind, trackColor }
      return
    }

    if (event.type === 'clip_update') {
      const { timelineNodeId, clipId, patch } = event.payload
      const c = s.timelineClips[timelineNodeId]?.[clipId]
      if (c) Object.assign(c, patch)
      return
    }

    if (event.type === 'clip_remove') {
      const { timelineNodeId, clipId } = event.payload
      if (s.timelineClips[timelineNodeId]) delete s.timelineClips[timelineNodeId][clipId]
    }
  }
}

module.exports = { RoomManager }
