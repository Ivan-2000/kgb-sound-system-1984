import { debugBus } from '../bus'
import type { PeerStats } from '../types'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// getStats() reports are read-only telemetry the browser already tracks for
// every RTCPeerConnection — polling them needs no instrumentation of
// send()/onmessage at all, so simple-peer's video connections (peerManager.ts)
// and the native audio data-channel peers (nativeRtcManager.ts) are both
// covered by the same collector without touching either file.
export function startRtcCollector(): () => void {
  const Original = window.RTCPeerConnection
  if (!Original) {
    debugBus.setStatus('rtc', { available: false, peers: [] satisfies PeerStats[] })
    return () => {}
  }

  const registry = new Set<RTCPeerConnection>()
  let peerCounter = 0
  const peerIds = new WeakMap<RTCPeerConnection, string>()
  const idFor = (pc: RTCPeerConnection): string => {
    let id = peerIds.get(pc)
    if (!id) {
      id = `peer-${++peerCounter}`
      peerIds.set(pc, id)
    }
    return id
  }

  class TappedRTCPeerConnection extends Original {
    constructor(config?: RTCConfiguration) {
      super(config)
      registry.add(this)
      const pc = this
      this.addEventListener('connectionstatechange', () => {
        debugBus.log('rtc', 'info', `${idFor(pc)} connection -> ${pc.connectionState}`)
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') registry.delete(pc)
      })
    }
  }

  // Intentional global monkey-patch — the whole point of this collector is to
  // see every RTCPeerConnection the app creates without editing peerManager.ts
  // or nativeRtcManager.ts. Anything constructed before this runs is invisible;
  // install.ts loads before any peer connection exists (page hasn't joined a
  // room yet), so this is not a practical limitation.
  window.RTCPeerConnection = TappedRTCPeerConnection as unknown as typeof RTCPeerConnection

  async function readPeer(pc: RTCPeerConnection): Promise<PeerStats | null> {
    if (pc.connectionState === 'closed') return null
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      return null
    }

    let rttMs: number | null = null
    let outgoingBitrateKbps: number | null = null
    const channels: PeerStats['channels'] = []
    let video: PeerStats['video']

    for (const stat of report.values() as IterableIterator<unknown>) {
      if (!isRecord(stat)) continue
      const type = stat.type
      if (type === 'candidate-pair' && stat.state === 'succeeded') {
        if (typeof stat.currentRoundTripTime === 'number') rttMs = stat.currentRoundTripTime * 1000
        if (typeof stat.availableOutgoingBitrate === 'number') outgoingBitrateKbps = stat.availableOutgoingBitrate / 1000
      } else if (type === 'data-channel') {
        channels.push({
          label: typeof stat.label === 'string' ? stat.label : '?',
          state: (stat.state as RTCDataChannelState) ?? 'closed',
          bytesSent: typeof stat.bytesSent === 'number' ? stat.bytesSent : 0,
          bytesReceived: typeof stat.bytesReceived === 'number' ? stat.bytesReceived : 0,
          messagesSent: typeof stat.messagesSent === 'number' ? stat.messagesSent : 0,
          messagesReceived: typeof stat.messagesReceived === 'number' ? stat.messagesReceived : 0,
        })
      } else if (type === 'inbound-rtp' && stat.kind === 'video') {
        video = {
          packetsLost: typeof stat.packetsLost === 'number' ? stat.packetsLost : 0,
          jitterMs: typeof stat.jitter === 'number' ? stat.jitter * 1000 : 0,
          framesPerSecond: typeof stat.framesPerSecond === 'number' ? stat.framesPerSecond : null,
        }
      }
    }

    return {
      peerId: idFor(pc),
      connectionState: pc.connectionState,
      iceState: pc.iceConnectionState,
      rttMs,
      outgoingBitrateKbps,
      channels,
      video,
    }
  }

  const poll = async () => {
    const peers = (await Promise.all([...registry].map(readPeer))).filter((p): p is PeerStats => p !== null)
    debugBus.setStatus('rtc', { available: true, peers })
    for (const peer of peers) {
      if (peer.rttMs != null) debugBus.record(`rtc.${peer.peerId}.rttMs`, peer.rttMs)
      for (const ch of peer.channels) {
        debugBus.record(`rtc.${peer.peerId}.${ch.label}.bytesSent`, ch.bytesSent)
        debugBus.record(`rtc.${peer.peerId}.${ch.label}.bytesReceived`, ch.bytesReceived)
      }
    }
  }

  const timer = setInterval(poll, 1000)

  return () => {
    clearInterval(timer)
    window.RTCPeerConnection = Original
  }
}
