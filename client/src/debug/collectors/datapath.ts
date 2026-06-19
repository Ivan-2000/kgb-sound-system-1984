import { debugBus } from '../bus'

// onPcm/onOpusPacket are Set-backed pub/sub (see preload.js) — adding our own
// subscriber here is additive and never displaces the app's own handlers.
// We deliberately do NOT touch window.nativeAudio.pushInboundOpus/pushSoftmix:
// contextBridge deep-freezes the exposed object, so reassigning those would
// throw; counting inbound traffic instead happens in rtc.ts via getStats()
// on the RTCDataChannel, which needs no wrapping at all.
export function startDatapathCollector(): () => void {
  if (!window.nativeAudio) return () => {}

  let pcmMsgs = 0
  let pcmBytes = 0
  let opusMsgs = 0
  let opusBytes = 0
  let windowStart = performance.now()

  const flush = () => {
    const now = performance.now()
    const dtSec = Math.max((now - windowStart) / 1000, 0.001)
    debugBus.record('datapath.pcmMsgsPerSec', pcmMsgs / dtSec)
    debugBus.record('datapath.pcmBytesPerSec', pcmBytes / dtSec)
    debugBus.record('datapath.opusMsgsPerSec', opusMsgs / dtSec)
    debugBus.record('datapath.opusBytesPerSec', opusBytes / dtSec)
    pcmMsgs = 0
    pcmBytes = 0
    opusMsgs = 0
    opusBytes = 0
    windowStart = now
  }

  const unsubPcm = window.nativeAudio.onPcm((msg) => {
    pcmMsgs++
    pcmBytes += msg.payload.byteLength
  })
  const unsubOpus = window.nativeAudio.onOpusPacket((msg) => {
    opusMsgs++
    opusBytes += msg.payload.byteLength
  })

  const timer = setInterval(flush, 1000)

  return () => {
    clearInterval(timer)
    unsubPcm()
    unsubOpus()
  }
}
