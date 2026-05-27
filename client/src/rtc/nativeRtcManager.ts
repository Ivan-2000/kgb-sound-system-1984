// Required for P2P through NAT — identical config to peerManager.ts
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
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

// pendingCandidates: ICE candidates that arrived before setRemoteDescription
// resolved. Flushed immediately after the remote description is set so they
// are never permanently lost (trickle-ICE race fix).
type PeerData = {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  pendingCandidates: RTCIceCandidateInit[]
}
type SignalFn = (targetSocketId: string, signal: unknown) => void

// Header layout (13 bytes):
//   0:    channelIndex  (Uint8)
//   1–4:  sequence      (Uint32 big-endian)
//   5–8:  timestampHi   (Uint32 big-endian — upper 32 bits of timestampUs)
//   9–12: timestampLo   (Uint32 big-endian — lower 32 bits of timestampUs)
//   13+:  Opus payload
function encodePacket(msg: OpusOutMessage): ArrayBuffer {
  const payloadBytes = new Uint8Array(msg.payload)
  const buf = new ArrayBuffer(13 + payloadBytes.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, msg.channelIndex)
  view.setUint32(1, msg.sequence, false)
  const hi = Number(msg.timestampUs >> 32n)
  const lo = Number(msg.timestampUs & 0xFFFFFFFFn)
  view.setUint32(5, hi, false)
  view.setUint32(9, lo, false)
  new Uint8Array(buf).set(payloadBytes, 13)
  return buf
}

function decodePacket(buf: ArrayBuffer, fromPeerId: string): InboundOpusPacket {
  const view = new DataView(buf)
  const channelIndex = view.getUint8(0)
  const sequence = view.getUint32(1, false)
  const hi = view.getUint32(5, false)
  const lo = view.getUint32(9, false)
  const timestampUs = (BigInt(hi) << 32n) | BigInt(lo)
  const payload = buf.slice(13)
  // channelId = String(channelIndex) matches the key used by the addon decoder
  return { peerId: fromPeerId, channelId: String(channelIndex), sequence, timestampUs, payload }
}

class NativeRtcManager {
  private peers = new Map<string, PeerData>()
  private sendSignalFn: SignalFn | null = null
  private onOpusUnsub: (() => void) | null = null
  private active = false

  setSendSignal(fn: SignalFn): void {
    this.sendSignalFn = fn
  }

  setActive(active: boolean): void {
    this.active = active
    if (active) {
      if (!window.nativeAudio || this.onOpusUnsub) return
      this.onOpusUnsub = window.nativeAudio.onOpusPacket((msg) => {
        this.broadcastOpusPacket(msg)
      })
    } else {
      this.onOpusUnsub?.()
      this.onOpusUnsub = null
    }
  }

  addPeer(socketId: string, initiator: boolean): void {
    if (this.peers.has(socketId)) return

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const entry: PeerData = { pc, channel: null, pendingCandidates: [] }
    this.peers.set(socketId, entry)

    if (initiator) {
      try {
        const ch = pc.createDataChannel('kgb-opus', { ordered: false, maxRetransmits: 0 })
        entry.channel = ch
        this.wireChannel(socketId, ch)
      } catch (e) {
        console.error('[nativeRtc] createDataChannel failed', e)
      }
    } else {
      pc.ondatachannel = (e) => {
        entry.channel = e.channel
        this.wireChannel(socketId, e.channel)
      }
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return
      this.sendSignal(socketId, { candidate: e.candidate.toJSON() })
    }

    pc.onconnectionstatechange = () => {
      console.log('[nativeRtc] peer', socketId, 'state:', pc.connectionState)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.cleanupPeer(socketId)
      }
    }

    if (initiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          const desc = pc.localDescription
          if (desc) this.sendSignal(socketId, { type: desc.type, sdp: desc.sdp })
        })
        .catch((e) => { console.error('[nativeRtc] createOffer failed', e) })
    }
  }

  handleSignal(fromSocketId: string, rawSignal: unknown): void {
    const signal = rawSignal as {
      _kgbAudio?: boolean
      type?: string
      sdp?: string
      candidate?: RTCIceCandidateInit
    }
    if (!signal._kgbAudio) return

    if (signal.type === 'offer' && signal.sdp) {
      if (!this.peers.has(fromSocketId)) this.addPeer(fromSocketId, false)
      const entry = this.peers.get(fromSocketId)
      if (!entry) return
      entry.pc
        .setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        .then(() => {
          // Flush ICE candidates that arrived before the remote description was set
          this.flushPendingCandidates(entry)
          return entry.pc.createAnswer()
        })
        .then((answer) => entry.pc.setLocalDescription(answer))
        .then(() => {
          const desc = entry.pc.localDescription
          if (desc) this.sendSignal(fromSocketId, { type: desc.type, sdp: desc.sdp })
        })
        .catch((e) => { console.error('[nativeRtc] handle offer failed', e) })
      return
    }

    if (signal.type === 'answer' && signal.sdp) {
      const entry = this.peers.get(fromSocketId)
      if (!entry) return
      entry.pc
        .setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        .then(() => {
          // Flush ICE candidates that arrived before the remote description was set
          this.flushPendingCandidates(entry)
        })
        .catch((e) => { console.error('[nativeRtc] setRemoteDescription answer failed', e) })
      return
    }

    if (signal.candidate) {
      const entry = this.peers.get(fromSocketId)
      if (!entry) return
      // Queue the candidate if remote description is not yet set (trickle-ICE race).
      // flushPendingCandidates is called once setRemoteDescription resolves.
      if (!entry.pc.remoteDescription) {
        entry.pendingCandidates.push(signal.candidate)
      } else {
        entry.pc
          .addIceCandidate(signal.candidate)
          .catch((e) => { console.error('[nativeRtc] addIceCandidate failed', e) })
      }
    }
  }

  removePeer(socketId: string): void {
    this.cleanupPeer(socketId)
  }

  removeAllPeers(): void {
    for (const socketId of [...this.peers.keys()]) {
      this.cleanupPeer(socketId)
    }
  }

  private flushPendingCandidates(entry: PeerData): void {
    for (const c of entry.pendingCandidates) {
      entry.pc
        .addIceCandidate(c)
        .catch((e) => { console.error('[nativeRtc] addIceCandidate (queued) failed', e) })
    }
    entry.pendingCandidates = []
  }

  private cleanupPeer(socketId: string): void {
    const entry = this.peers.get(socketId)
    if (!entry) return
    try { entry.pc.close() } catch { /* ignored */ }
    this.peers.delete(socketId)
  }

  private wireChannel(socketId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (e) => {
      if (!window.nativeAudio || !this.active) return
      window.nativeAudio.pushInboundOpus(decodePacket(e.data as ArrayBuffer, socketId))
    }
    channel.onopen = () => {
      console.log('[nativeRtc] peer', socketId, 'datachannel open')
    }
  }

  private broadcastOpusPacket(msg: OpusOutMessage): void {
    let count = 0
    for (const entry of this.peers.values()) {
      if (entry.channel?.readyState === 'open') {
        entry.channel.send(encodePacket(msg))
        count++
      }
    }
    if (count > 0) {
      console.log(`[nativeRtc] sending opus ch=${msg.channelIndex} seq=${msg.sequence} to ${count} peer(s)`)
    }
  }

  private sendSignal(targetSocketId: string, signal: object): void {
    this.sendSignalFn?.(targetSocketId, { _kgbAudio: true, ...signal })
  }
}

export const nativeRtcManager = new NativeRtcManager()
