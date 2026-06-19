import { debugBus } from '../bus'

// Polls the RT-core health snapshot that already exists for production
// diagnostics (nativeAudioController's own VU-meter loop uses the same
// getStats()) — purely additive reads, no new IPC surface needed for this part.
export function startCoreCollector(): () => void {
  if (!window.nativeAudio) {
    debugBus.setStatus('core', { available: false })
    return () => {}
  }

  let prevSoftmixReceived = 0
  let lastPollT = performance.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const poll = async () => {
    const slowPath = !debugBus.isHudVisible()
    if (slowPath && Math.random() > 0.34) return // ~3x slower background cadence

    const [stats, softmixDiag, streamActive] = await Promise.all([
      window.nativeAudio!.getStats(),
      Promise.resolve(window.nativeAudio!.getSoftmixDiag()),
      window.nativeAudio!.isStreamActive(),
    ])

    const now = performance.now()
    const dtSec = Math.max((now - lastPollT) / 1000, 0.001)
    lastPollT = now

    debugBus.record('core.xrunCount', stats.xrunCount)
    debugBus.record('core.dropCount', stats.dropCount)
    debugBus.record('core.bufferFillPct', stats.bufferFillPct)
    debugBus.record('core.cpuLoad', stats.cpuLoad)
    const softmixReceived = stats.softmixReceived ?? 0
    debugBus.record('core.softmixReceivedRate', (softmixReceived - prevSoftmixReceived) / dtSec)
    prevSoftmixReceived = softmixReceived
    debugBus.record('core.softmixPeak', stats.softmixPeak ?? 0)
    if (stats.pcmIntervalMsAvg != null) debugBus.record('core.pcmIntervalMsAvg', stats.pcmIntervalMsAvg)
    if (stats.pcmIntervalMsMax != null) debugBus.record('core.pcmIntervalMsMax', stats.pcmIntervalMsMax)
    if (stats.opusIntervalMsAvg != null) debugBus.record('core.opusIntervalMsAvg', stats.opusIntervalMsAvg)
    if (stats.opusIntervalMsMax != null) debugBus.record('core.opusIntervalMsMax', stats.opusIntervalMsMax)

    debugBus.setStatus('core', {
      available: true,
      streamActive,
      softmixSent: softmixDiag.sent,
      softmixFailed: softmixDiag.failed,
      hasOpusCadence: stats.pcmIntervalMsAvg != null,
    })
  }

  const unsubLatency = window.nativeAudio.onLatency((latency) => {
    debugBus.record('core.inputLatencyMs', latency.inputLatency * 1000)
    debugBus.record('core.outputLatencyMs', latency.outputLatency * 1000)
  })
  const unsubCrash = window.nativeAudio.onEngineCrashed((info) => {
    debugBus.log('core', 'error', `native audio engine crashed (code ${info.code})`)
  })

  timer = setInterval(poll, 500)
  void poll()

  return () => {
    if (timer) clearInterval(timer)
    unsubLatency()
    unsubCrash()
  }
}
