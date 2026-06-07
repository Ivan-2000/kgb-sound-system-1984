import SimplePeer from 'simple-peer'
import type { SignalData, Instance } from 'simple-peer'
import { requestAudioStream, MUSIC_AUDIO_CONSTRAINTS } from './mediaDevices'

// Required for P2P through NAT over the internet.
// Without ICE servers, connections only work on the same LAN.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // Free TURN relay — handles symmetric NAT where STUN alone fails
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

type StreamListener = (socketId: string, stream: MediaStream | null) => void
type SignalSender = (targetSocketId: string, signal: SignalData) => void

type PeerEntry = {
  peer: Instance
  stream: MediaStream | null
}

class PeerManager {
  private peers = new Map<string, PeerEntry>()
  private localStream: MediaStream | null = null
  private micEnabled = true
  private cameraEnabled = true
  private streamListeners = new Set<StreamListener>()
  private signalSender: SignalSender | null = null

  setSignalSender(sender: SignalSender) {
    this.signalSender = sender
  }

  subscribeStreams(listener: StreamListener) {
    this.streamListeners.add(listener)
    return () => {
      this.streamListeners.delete(listener)
    }
  }

  getLocalStream() {
    return this.localStream
  }

  getMicEnabled() {
    return this.micEnabled
  }

  getCameraEnabled() {
    return this.cameraEnabled
  }

  /**
   * Idempotent: returns existing stream if already started with matching video setting.
   * Restarts the stream only if video capability needs to change.
   */
  async startLocalStream(withVideo: boolean): Promise<MediaStream> {
    if (this.localStream) {
      const hasVideo = this.localStream.getVideoTracks().length > 0
      if (withVideo === hasVideo) {
        return this.localStream
      }
      // Need different track configuration — release old stream
      this.stopLocalStream()
    }

    // requestAudioStream() handles: preferred device (from Settings), fallback to
    // system default, and descriptive errors instead of raw "Requested device not found".
    const audioStream = await requestAudioStream()

    let stream: MediaStream
    if (withVideo) {
      try {
        // Combine the audio tracks we already have with a video request.
        const videoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        })
        const combined = new MediaStream([
          ...audioStream.getAudioTracks(),
          ...videoStream.getVideoTracks(),
        ])
        stream = combined
      } catch {
        // Camera not available — use audio-only stream
        stream = audioStream
      }
    } else {
      stream = audioStream
    }

    this.localStream = stream
    stream.getAudioTracks().forEach((t) => { t.enabled = this.micEnabled })
    stream.getVideoTracks().forEach((t) => { t.enabled = this.cameraEnabled })
    return stream
  }

  stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop())
      this.localStream = null
    }
  }

  setMicEnabled(enabled: boolean) {
    this.micEnabled = enabled
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => { t.enabled = enabled })
    }
  }

  setCameraEnabled(enabled: boolean) {
    this.cameraEnabled = enabled
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((t) => { t.enabled = enabled })
    }
  }

  addPeer(socketId: string, initiator: boolean) {
    if (this.peers.has(socketId)) {
      return
    }

    const peer = new SimplePeer({
      initiator,
      stream: this.localStream ?? undefined,
      trickle: true,
      config: { iceServers: ICE_SERVERS },
    })

    const entry: PeerEntry = { peer, stream: null }
    this.peers.set(socketId, entry)

    peer.on('signal', (signal: SignalData) => {
      this.signalSender?.(socketId, signal)
    })

    peer.on('stream', (stream: MediaStream) => {
      entry.stream = stream
      this.streamListeners.forEach((l) => l(socketId, stream))
    })

    peer.on('close', () => {
      this.cleanupPeer(socketId)
    })

    peer.on('error', () => {
      this.cleanupPeer(socketId)
    })
  }

  handleSignal(fromSocketId: string, signal: SignalData) {
    if (!this.peers.has(fromSocketId)) {
      this.addPeer(fromSocketId, false)
    }
    const entry = this.peers.get(fromSocketId)
    if (entry && !entry.peer.destroyed) {
      entry.peer.signal(signal)
    }
  }

  removePeer(socketId: string) {
    const entry = this.peers.get(socketId)
    if (!entry) {
      return
    }
    if (!entry.peer.destroyed) {
      entry.peer.destroy()
    }
    this.peers.delete(socketId)
    this.streamListeners.forEach((l) => l(socketId, null))
  }

  removeAllPeers() {
    for (const socketId of [...this.peers.keys()]) {
      this.removePeer(socketId)
    }
  }

  private cleanupPeer(socketId: string) {
    this.peers.delete(socketId)
    this.streamListeners.forEach((l) => l(socketId, null))
  }
}

export const peerManager = new PeerManager()
export type { SignalSender, SignalData }
