import { debugBus } from '../bus'

// Longtask observation is native-browser-tracked and cheap regardless of
// whether anyone is looking — keep it always-on. The rAF FPS sampler is the
// opposite (a per-frame JS callback), so it only runs while the HUD is open;
// AUDIT.md §9.C already flags this codebase for ungated RAF loops, and this
// debug tool would be a bad example to follow if it added another one.
export function startJankCollector(): () => void {
  let longtaskCount = 0
  let longtaskBusyMs = 0
  let observer: PerformanceObserver | null = null

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longtaskCount++
        longtaskBusyMs += entry.duration
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    debugBus.log('jank', 'warn', 'longtask PerformanceObserver unsupported')
  }

  const flushTimer = setInterval(() => {
    debugBus.record('jank.longtaskCountPerSec', longtaskCount)
    debugBus.record('jank.longtaskBusyMsPerSec', longtaskBusyMs)
    longtaskCount = 0
    longtaskBusyMs = 0
  }, 1000)

  let rafHandle: number | null = null
  let lastFrameMs = 0
  let frameCount = 0
  let windowStart = 0

  const frame = (nowMs: number) => {
    if (lastFrameMs > 0) {
      const delta = nowMs - lastFrameMs
      debugBus.record('jank.frameDeltaMs', delta)
      frameCount++
      if (nowMs - windowStart >= 1000) {
        debugBus.record('jank.fps', (frameCount * 1000) / (nowMs - windowStart))
        frameCount = 0
        windowStart = nowMs
      }
    } else {
      windowStart = nowMs
    }
    lastFrameMs = nowMs
    rafHandle = requestAnimationFrame(frame)
  }

  const startFps = () => {
    if (rafHandle !== null) return
    lastFrameMs = 0
    frameCount = 0
    rafHandle = requestAnimationFrame(frame)
  }
  const stopFps = () => {
    if (rafHandle === null) return
    cancelAnimationFrame(rafHandle)
    rafHandle = null
  }

  if (debugBus.isHudVisible()) startFps()
  const unsubVisibility = debugBus.onVisibilityChange((visible) => {
    if (visible) startFps()
    else stopFps()
  })

  return () => {
    clearInterval(flushTimer)
    observer?.disconnect()
    stopFps()
    unsubVisibility()
  }
}
