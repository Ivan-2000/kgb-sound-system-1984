import type { LogEntry, LogLevel, MetricPoint } from './types'

const DEFAULT_CAP = 240 // ~2 min at 2 samples/sec — enough for a HUD sparkline, not a logger

class RingBuffer {
  private buf: MetricPoint[] = []
  private readonly cap: number
  constructor(cap: number) {
    this.cap = cap
  }
  push(v: number, t: number): void {
    this.buf.push({ t, v })
    if (this.buf.length > this.cap) this.buf.shift()
  }
  series(): readonly MetricPoint[] {
    return this.buf
  }
  last(): number | null {
    return this.buf.length ? this.buf[this.buf.length - 1].v : null
  }
}

// Singleton telemetry bus. Collectors write, the HUD reads — no event
// emission on write so a burst of metric updates never triggers React
// re-renders; the HUD pulls on its own rAF cadence instead.
class DebugBus {
  private metrics = new Map<string, RingBuffer>()
  private status = new Map<string, unknown>()
  private eventLog: LogEntry[] = []
  private hudVisible = false
  private visibilityListeners = new Set<(visible: boolean) => void>()

  record(key: string, value: number, cap = DEFAULT_CAP): void {
    let buf = this.metrics.get(key)
    if (!buf) {
      buf = new RingBuffer(cap)
      this.metrics.set(key, buf)
    }
    buf.push(value, performance.now())
  }

  series(key: string): readonly MetricPoint[] {
    return this.metrics.get(key)?.series() ?? []
  }

  latest(key: string): number | null {
    return this.metrics.get(key)?.last() ?? null
  }

  setStatus<T>(stage: string, value: T): void {
    this.status.set(stage, value)
  }

  getStatus<T>(stage: string): T | undefined {
    return this.status.get(stage) as T | undefined
  }

  log(stage: string, level: LogLevel, message: string): void {
    this.eventLog.push({ t: performance.now(), stage, level, message })
    if (this.eventLog.length > 200) this.eventLog.shift()
  }

  events(): readonly LogEntry[] {
    return this.eventLog
  }

  // Collectors with a non-trivial per-frame cost (FPS sampling, fast process
  // polling) should gate themselves on this instead of running unconditionally —
  // the whole point of this tool is to not become the next §9.C "idle RAF burns
  // CPU" finding from AUDIT.md.
  setHudVisible(visible: boolean): void {
    this.hudVisible = visible
    this.visibilityListeners.forEach((fn) => fn(visible))
  }

  isHudVisible(): boolean {
    return this.hudVisible
  }

  onVisibilityChange(fn: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(fn)
    return () => this.visibilityListeners.delete(fn)
  }
}

export const debugBus = new DebugBus()
