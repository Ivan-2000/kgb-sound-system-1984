import { debugBus } from '../bus'
import type { ProcessMetric } from '../types'

// window.kgbDebug only exists if the host app applied the tiny main.js +
// preload.js shim documented in README.md. Without it this tab just reports
// unavailable — every other collector in this folder works without that shim.
export function startProcsCollector(): () => void {
  if (!window.kgbDebug) {
    debugBus.setStatus('procs', { available: false, processes: [] satisfies ProcessMetric[] })
    return () => {}
  }

  const poll = async () => {
    if (!debugBus.isHudVisible() && Math.random() > 0.2) return // slow background cadence
    let processes: ProcessMetric[]
    try {
      processes = await window.kgbDebug!.getProcessMetrics()
    } catch {
      return
    }
    debugBus.setStatus('procs', { available: true, processes })
    for (const p of processes) {
      const key = p.name ? `${p.type}:${p.name}` : `${p.type}:${p.pid}`
      debugBus.record(`procs.${key}.cpuPercent`, p.cpuPercent)
      debugBus.record(`procs.${key}.memoryMB`, p.memoryKB / 1024)
    }
  }

  const timer = setInterval(poll, 1000)
  void poll()

  return () => clearInterval(timer)
}
