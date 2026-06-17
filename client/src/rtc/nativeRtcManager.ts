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
  ctrl: RTCDataChannel | null
  pendingCandidates: RTCIceCandidateInit[]
  isInitiator: boolean
  rttMs: number | null
  pingTimer: ReturnType<typeof setInterval> | null
  stalenessTimer: ReturnType<typeof setTimeout> | null
}
type CtrlMsg = { type: 'ping'; t: number } | { type: 'pong'; t: number }
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

// §4.2: maximum valid input channel index (must match MAX_INPUT_CH in addon.cc).
const MAX_INPUT_CH = 64

class NativeRtcManager {
  private peers = new Map<string, PeerData>()
  private sendSignalFn: SignalFn | null = null
  private onOpusUnsub: (() => void) | null = null
  private active = false
  private rttListeners = new Set<(peerId: string, rttMs: number | null) => void>()
  private sendEnabled = new Set<number>()
  /** §4.1: our own socket ID — set by App once the socket connects. */
  private mySocketId: string | null = null

  setSendSignal(fn: SignalFn): void {
    this.sendSignalFn = fn
  }

  setSendEnabled(channelIndex: number, enabled: boolean): void {
    if (enabled) this.sendEnabled.add(channelIndex)
    else this.sendEnabled.delete(channelIndex)
  }

  clearSendChannels(): void {
    this.sendEnabled.clear()
  }

  /** §4.1: pass mySocketId when activating so glare tie-break knows our own ID. */
  setActive(active: boolean, mySocketId?: string): void {
    this.active = active
    if (active) {
      if (mySocketId !== undefined) this.mySocketId = mySocketId
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
    const entry: PeerData = { pc, channel: null, ctrl: null, pendingCandidates: [], isInitiator: initiator, rttMs: null, pingTimer: null, stalenessTimer: null }
    this.peers.set(socketId, entry)

    if (initiator) {
      try {
        const ch = pc.createDataChannel('kgb-opus', { ordered: false, maxRetransmits: 0 })
        entry.channel = ch
        this.wireChannel(socketId, ch)
        const ctrl = pc.createDataChannel('kgb-ctrl', { ordered: true })
        entry.ctrl = ctrl
        this.wireCtrl(socketId, ctrl)
      } catch (e) {
        console.error('[nativeRtc] createDataChannel failed', e)
      }
    } else {
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'kgb-ctrl') {
          entry.ctrl = e.channel
          this.wireCtrl(socketId, e.channel)
        } else {
          entry.channel = e.channel
          this.wireChannel(socketId, e.channel)
        }
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
      } else if (pc.connectionState === 'disconnected') {
        // §4.5: 'disconnected' is transient — the browser will try to recover.
        // If it doesn't recover within 10 s, clean up to avoid the leak described
        // in AUDIT §4.5 (RTCPeerConnection + ping timer living forever).
        setTimeout(() => {
          const e = this.peers.get(socketId)
          if (e && e.pc === pc && pc.connectionState === 'disconnected') {
            console.warn('[nativeRtc] peer', socketId, 'still disconnected after 10 s — cleaning up')
            this.cleanupPeer(socketId)
          }
        }, 10000)
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

      // §4.1: Glare (simultaneous offer) resolution via lexicographic tie-break.
      // The peer with the LOWER socket ID is "polite": it rolls back its own pending
      // offer and accepts the remote one. The "impolite" peer (higher ID) ignores
      // the collision and keeps its offer — the polite peer will answer it.
      const collision = entry.pc.signalingState !== 'stable'
      if (collision) {
        const weArePolite = this.mySocketId !== null && this.mySocketId < fromSocketId
        if (!weArePolite) {
          // Impolite: ignore remote offer, our offer takes precedence.
          return
        }
        // Polite: rollback must complete before setRemoteDescription — they share
        // the same RTCPeerConnection state machine and cannot run concurrently.
        entry.pc
          .setLocalDescription({ type: 'rollback' })
          .then(() => entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp }))
          .then(() => {
            this.flushPendingCandidates(entry)
            return entry.pc.createAnswer()
          })
          .then((answer) => entry.pc.setLocalDescription(answer))
          .then(() => {
            const desc = entry.pc.localDescription
            if (desc) this.sendSignal(fromSocketId, { type: desc.type, sdp: desc.sdp })
          })
          .catch((e) => { console.error('[nativeRtc] handle offer (polite rollback) failed', e) })
        return
      }

      entry.pc
        .setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        .then(() => {
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
    if (entry.pingTimer !== null) clearInterval(entry.pingTimer)
    if (entry.stalenessTimer !== null) clearTimeout(entry.stalenessTimer)
    try { entry.pc.close() } catch { /* ignored */ }
    this.peers.delete(socketId)
  }

  private wireCtrl(socketId: string, channel: RTCDataChannel): void {
    channel.onopen = () => {
      const entry = this.peers.get(socketId)
      if (!entry || !entry.isInitiator) return

      // Guard: compare the entry reference (not just socketId) so a stale
      // closure cannot corrupt a new peer that reuses the same socketId after
      // a disconnect/reconnect cycle.
      const fireStale = () => {
        if (this.peers.get(socketId) !== entry) return
        entry.rttMs = null
        entry.stalenessTimer = null
        for (const fn of this.rttListeners) fn(socketId, null)
      }

      // Arm the initial staleness guard before the first ping fires.
      // The first ping goes out 2 s from now; allow 6 s for its pong → 8 s total.
      entry.stalenessTimer = setTimeout(fireStale, 8000)

      entry.pingTimer = setInterval(() => {
        if (channel.readyState !== 'open') return
        const t = performance.now()
        channel.send(JSON.stringify({ type: 'ping', t }))
        // Reset the staleness guard: 6 s from now, if no pong arrived, null out RTT.
        if (entry.stalenessTimer !== null) clearTimeout(entry.stalenessTimer)
        entry.stalenessTimer = setTimeout(fireStale, 6000)
      }, 2000)
    }
    channel.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      let msg: CtrlMsg
      try { msg = JSON.parse(e.data) as CtrlMsg } catch { return }
      const entry = this.peers.get(socketId)
      if (!entry) return
      if (msg.type === 'ping') {
        if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'pong', t: msg.t }))
      } else if (msg.type === 'pong') {
        // Reject late pongs that arrive after the channel has already closed.
        if (channel.readyState !== 'open') return
        if (entry.stalenessTimer !== null) { clearTimeout(entry.stalenessTimer); entry.stalenessTimer = null }
        entry.rttMs = Math.round(performance.now() - msg.t)
        for (const fn of this.rttListeners) fn(socketId, entry.rttMs)
      }
    }
    channel.onclose = () => {
      const entry = this.peers.get(socketId)
      if (!entry) return
      if (entry.pingTimer !== null) { clearInterval(entry.pingTimer); entry.pingTimer = null }
      if (entry.stalenessTimer !== null) { clearTimeout(entry.stalenessTimer); entry.stalenessTimer = null }
    }
  }

  subscribeRtt(fn: (peerId: string, rttMs: number | null) => void): () => void {
    this.rttListeners.add(fn)
    return () => this.rttListeners.delete(fn)
  }

  private wireChannel(socketId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (e) => {
      if (!window.nativeAudio || !this.active) return
      const buf = e.data as ArrayBuffer
      // §4.2: reject packets that are too short to contain the 13-byte header.
      if (buf.byteLength < 14) return
      const packet = decodePacket(buf, socketId)
      // §4.2: clamp channelId to the addon's MAX_INPUT_CH range.
      // A misbehaving/malicious peer sending channelIndex ≥ 64 would exhaust all
      // 32 g_peerSlots with orphan decoders, blocking legitimate peers.
      const chIdx = parseInt(packet.channelId, 10)
      if (!Number.isInteger(chIdx) || chIdx < 0 || chIdx >= MAX_INPUT_CH) return
      window.nativeAudio.pushInboundOpus(packet)
    }
    channel.onopen = () => {
      console.log('[nativeRtc] peer', socketId, 'datachannel open')
    }
  }

  private broadcastOpusPacket(msg: OpusOutMessage): void {
    if (!this.sendEnabled.has(msg.channelIndex)) return
    // §9.A.2: encode the packet ONCE before the loop — the payload is identical
    // for all peers and encodePacket allocates a new ArrayBuffer each call.
    // At 8 participants × 2 channels this was creating 700+ extra ArrayBuffers/s.
    let encoded: ArrayBuffer | null = null
    for (const entry of this.peers.values()) {
      if (entry.channel?.readyState === 'open') {
        if (!encoded) encoded = encodePacket(msg)
        entry.channel.send(encoded)
      }
    }
  }

  private sendSignal(targetSocketId: string, signal: object): void {
    this.sendSignalFn?.(targetSocketId, { _kgbAudio: true, ...signal })
  }
}

export const nativeRtcManager = new NativeRtcManager()
