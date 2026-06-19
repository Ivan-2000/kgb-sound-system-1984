import { debugBus } from '../bus'

// performance.memory is a non-standard Chromium API (no DOM lib typing) —
// declared locally rather than touching the shared electron.d.ts.
interface ChromeMemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export function startMemCollector(): () => void {
  const perf = performance as Performance & { memory?: ChromeMemoryInfo }
  if (!perf.memory) {
    debugBus.setStatus('mem', { available: false })
    return () => {}
  }

  const poll = () => {
    const mem = perf.memory
    if (!mem) return
    debugBus.record('mem.usedHeapMB', mem.usedJSHeapSize / 1_048_576)
    debugBus.record('mem.totalHeapMB', mem.totalJSHeapSize / 1_048_576)
    debugBus.setStatus('mem', {
      available: true,
      limitMB: mem.jsHeapSizeLimit / 1_048_576,
    })
  }

  const timer = setInterval(poll, 2000)
  poll()

  return () => clearInterval(timer)
}
