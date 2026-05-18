import { io, type Socket } from 'socket.io-client'
import { syncEventSchema, type SyncEvent } from '../protocol/syncProtocol'

type RoomParticipant = {
  socketId: string
  username: string
  isHost: boolean
}

type SyncStateSnapshot = {
  bpm: number
  isPlaying: boolean
  currentStep: number
  pattern: {
    kick: boolean[]
    snare: boolean[]
    hat: boolean[]
    crash: boolean[]
  }
}

type RoomState = {
  connected: boolean
  reconnecting: boolean
  socketId: string | null
  roomId: string | null
  shortCode: string | null
  isHost: boolean
  username: string | null
  hostSocketId: string | null
}

type ParticipantEvent =
  | { type: 'participant_join'; payload: { socketId: string; username: string }; timestamp: number }
  | { type: 'participant_leave'; payload: { socketId: string }; timestamp: number }

type RtcSignalEvent = {
  fromSocketId: string
  signal: unknown
}

type RoomStateListener = (state: RoomState) => void
type SyncListener = (event: SyncEvent) => void
type ParticipantListener = (event: ParticipantEvent) => void
type RtcSignalListener = (event: RtcSignalEvent) => void

type AckResponse = {
  ok: boolean
  error?: string
  roomId?: string
  shortCode?: string
  inviteLink?: string
  participants?: RoomParticipant[]
  syncState?: SyncStateSnapshot | null
}

type RtcSignalAck = {
  ok: boolean
  error?: string
}

const SERVER_URL = import.meta.env.VITE_SIGNALING_URL || 'http://127.0.0.1:3001'

class RoomSyncClient {
  private socket: Socket
  private state: RoomState = {
    connected: false,
    reconnecting: false,
    socketId: null,
    roomId: null,
    shortCode: null,
    isHost: false,
    username: null,
    hostSocketId: null,
  }

  // Set when we disconnect while in a room — triggers auto-rejoin on reconnect
  private pendingRejoin = false

  private stateListeners = new Set<RoomStateListener>()
  private syncListeners = new Set<SyncListener>()
  private participantListeners = new Set<ParticipantListener>()
  private rtcSignalListeners = new Set<RtcSignalListener>()

  constructor() {
    this.socket = io(SERVER_URL, {
      autoConnect: true,
      transports: ['websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })

    this.socket.on('connect', () => {
      this.state.connected = true
      this.state.reconnecting = false
      this.state.socketId = this.socket.id ?? null
      this.emitState()

      // Auto-rejoin room after socket reconnect
      if (this.pendingRejoin && this.state.roomId && this.state.username) {
        this.pendingRejoin = false
        void this.joinRoom(this.state.roomId, this.state.username).catch(() => {
          // Room no longer exists on server — clear local room state
          this.state.roomId = null
          this.state.isHost = false
          this.state.hostSocketId = null
          this.emitState()
        })
      }
    })

    this.socket.on('disconnect', () => {
      if (this.state.roomId) {
        this.pendingRejoin = true
      }
      this.state.connected = false
      this.state.socketId = null
      this.emitState()
    })

    this.socket.on('reconnect_attempt', () => {
      this.state.reconnecting = true
      this.emitState()
    })

    this.socket.on('reconnect_failed', () => {
      this.state.reconnecting = false
      this.pendingRejoin = false
      this.state.roomId = null
      this.state.shortCode = null
      this.state.isHost = false
      this.state.hostSocketId = null
      this.emitState()
    })

    this.socket.on('room:event', (rawEvent) => {
      const parsed = syncEventSchema.safeParse(rawEvent)
      if (!parsed.success) return
      this.syncListeners.forEach((l) => l(parsed.data))
    })

    this.socket.on('room:host', (payload: { hostSocketId: string }) => {
      if (!payload?.hostSocketId) return
      this.state.hostSocketId = payload.hostSocketId
      this.state.isHost = payload.hostSocketId === this.socket.id
      this.emitState()
    })

    this.socket.on('participant:joined', (event: ParticipantEvent) => {
      this.participantListeners.forEach((l) => l(event))
    })

    this.socket.on('participant:left', (event: ParticipantEvent) => {
      this.participantListeners.forEach((l) => l(event))
    })

    this.socket.on('rtc:signal', (event: RtcSignalEvent) => {
      this.rtcSignalListeners.forEach((l) => l(event))
    })
  }

  subscribeRoomState(listener: RoomStateListener) {
    this.stateListeners.add(listener)
    listener({ ...this.state })
    return () => { this.stateListeners.delete(listener) }
  }

  subscribeSyncEvents(listener: SyncListener) {
    this.syncListeners.add(listener)
    return () => { this.syncListeners.delete(listener) }
  }

  subscribeParticipants(listener: ParticipantListener) {
    this.participantListeners.add(listener)
    return () => { this.participantListeners.delete(listener) }
  }

  subscribeRtcSignals(listener: RtcSignalListener) {
    this.rtcSignalListeners.add(listener)
    return () => { this.rtcSignalListeners.delete(listener) }
  }

  getState() {
    return { ...this.state }
  }

  async createRoom(username: string) {
    const response = await this.emitWithAck('room:create', { username })
    if (!response.ok || !response.roomId) {
      throw new Error(response.error || 'FAILED_TO_CREATE_ROOM')
    }

    this.state.roomId = response.roomId
    this.state.shortCode = response.shortCode ?? null
    this.state.username = username
    this.state.isHost = true
    this.state.hostSocketId = this.socket.id || null
    this.emitState()

    return {
      roomId: response.roomId,
      shortCode: response.shortCode ?? null,
      inviteLink: response.inviteLink || null,
      syncState: response.syncState || null,
      participants: response.participants || [],
    }
  }

  async joinByCode(shortCode: string, username: string) {
    const code = shortCode.trim().toUpperCase()
    const response = await this.emitWithAck('room:join-by-code', { shortCode: code, username })
    if (!response.ok || !response.roomId) {
      throw new Error(response.error || 'FAILED_TO_JOIN_ROOM')
    }

    const participants = response.participants || []
    const hostSocketId = participants.find((p) => p.isHost)?.socketId

    this.state.roomId = response.roomId
    this.state.shortCode = code
    this.state.username = username
    this.state.hostSocketId = hostSocketId || null
    this.state.isHost = Boolean(hostSocketId && hostSocketId === this.socket.id)
    this.emitState()

    return {
      roomId: response.roomId,
      syncState: response.syncState || null,
      participants,
    }
  }

  async joinRoom(roomId: string, username: string) {
    const response = await this.emitWithAck('room:join', { roomId, username })
    if (!response.ok) {
      throw new Error(response.error || 'FAILED_TO_JOIN_ROOM')
    }

    const participants = response.participants || []
    const hostSocketId = participants.find((p) => p.isHost)?.socketId

    this.state.roomId = roomId
    this.state.username = username
    this.state.hostSocketId = hostSocketId || null
    this.state.isHost = Boolean(hostSocketId && hostSocketId === this.socket.id)
    this.emitState()

    return {
      syncState: response.syncState || null,
      participants,
    }
  }

  async sendSyncEvent(event: SyncEvent) {
    const parsed = syncEventSchema.safeParse(event)
    if (!parsed.success) throw new Error('INVALID_SYNC_EVENT')

    const response = await this.emitWithAck('room:event', parsed.data)
    if (!response.ok) throw new Error(response.error || 'SYNC_EVENT_REJECTED')
  }

  async sendRtcSignal(targetSocketId: string, signal: unknown) {
    return new Promise<RtcSignalAck>((resolve) => {
      this.socket.emit('rtc:signal', { targetSocketId, signal }, (response: RtcSignalAck) => {
        resolve(response ?? { ok: false, error: 'NO_ACK' })
      })
    })
  }

  private emitState() {
    const next = { ...this.state }
    this.stateListeners.forEach((l) => l(next))
  }

  private emitWithAck<TPayload extends object>(eventName: string, payload: TPayload) {
    return new Promise<AckResponse>((resolve) => {
      this.socket.emit(eventName, payload, (response: AckResponse) => {
        resolve(response ?? { ok: false, error: 'NO_ACK' })
      })
    })
  }
}

export const roomSyncClient = new RoomSyncClient()
export type { RoomState, SyncStateSnapshot, RoomParticipant }
