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

type RttEvent = { socketId: string; rtt: number }
type RttListener = (event: RttEvent) => void

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
  private roomPassword: string | null = null

  private stateListeners = new Set<RoomStateListener>()
  private syncListeners = new Set<SyncListener>()
  private participantListeners = new Set<ParticipantListener>()
  private rtcSignalListeners = new Set<RtcSignalListener>()
  private rttListeners = new Set<RttListener>()
  private pingInterval: ReturnType<typeof setInterval> | null = null

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
      this.startPingInterval()

      // Auto-rejoin room after socket reconnect
      if (this.pendingRejoin && this.state.roomId && this.state.username) {
        this.pendingRejoin = false
        void this.joinRoom(this.state.roomId, this.state.username, this.roomPassword ?? undefined).catch(() => {
          // Room no longer exists on server — clear local room state
          this.state.roomId = null
          this.state.isHost = false
          this.state.hostSocketId = null
          this.emitState()
        })
      }
    })

    this.socket.on('disconnect', () => {
      this.stopPingInterval()
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

    this.socket.on('participant:rtt', (event: RttEvent) => {
      this.rttListeners.forEach((l) => l(event))
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

  subscribeRtt(listener: RttListener) {
    this.rttListeners.add(listener)
    return () => { this.rttListeners.delete(listener) }
  }

  getState() {
    return { ...this.state }
  }

  async createRoom(username: string, options: { password?: string; maxParticipants?: number } = {}) {
    const response = await this.emitWithAck('room:create', {
      username,
      password: options.password,
      maxParticipants: options.maxParticipants,
    })
    if (!response.ok || !response.roomId) {
      throw new Error(response.error || 'FAILED_TO_CREATE_ROOM')
    }

    this.state.roomId = response.roomId
    this.state.shortCode = response.shortCode ?? null
    this.state.username = username
    this.state.isHost = true
    this.state.hostSocketId = this.socket.id || null
    this.roomPassword = options.password ?? null
    this.emitState()

    return {
      roomId: response.roomId,
      shortCode: response.shortCode ?? null,
      inviteLink: response.inviteLink || null,
      syncState: response.syncState || null,
      participants: response.participants || [],
    }
  }

  async joinByCode(shortCode: string, username: string, password?: string) {
    const code = shortCode.trim().toUpperCase()
    const response = await this.emitWithAck('room:join-by-code', { shortCode: code, username, password })
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
    this.roomPassword = password ?? null
    this.emitState()

    return {
      roomId: response.roomId,
      syncState: response.syncState || null,
      participants,
    }
  }

  async joinRoom(roomId: string, username: string, password?: string) {
    const response = await this.emitWithAck('room:join', { roomId, username, password })
    if (!response.ok) {
      throw new Error(response.error || 'FAILED_TO_JOIN_ROOM')
    }

    const participants = response.participants || []
    const hostSocketId = participants.find((p) => p.isHost)?.socketId

    this.state.roomId = roomId
    this.state.username = username
    this.state.hostSocketId = hostSocketId || null
    this.state.isHost = Boolean(hostSocketId && hostSocketId === this.socket.id)
    this.roomPassword = password ?? null
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

  private startPingInterval() {
    this.stopPingInterval()
    this.pingInterval = setInterval(() => { void this.sendPing() }, 2000)
  }

  private stopPingInterval() {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private sendPing() {
    return new Promise<void>((resolve) => {
      const t1 = Date.now()
      this.socket.emit('ping', { t1 }, () => {
        const rtt = Date.now() - t1
        if (this.state.roomId) {
          this.socket.emit('participant:rtt', { rtt })
        }
        resolve()
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
