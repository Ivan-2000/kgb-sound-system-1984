import { debugBus } from '../bus'
import { nativeToneContext } from '../../audio/toneNativeContext'

// nativeToneContext is already a named export of toneNativeContext.ts (it has
// to be, so Tone.js can be handed a native AudioContext — see that file's
// comment) — reading it here needs zero changes to that module.
export function startWebAudioCollector(): () => void {
  const ctx = nativeToneContext
  let anchorWallMs: number | null = null
  let anchorCtxMs: number | null = null

  const poll = () => {
    debugBus.record('webaudio.baseLatencyMs', ctx.baseLatency * 1000)
    debugBus.record('webaudio.outputLatencyMs', ctx.outputLatency * 1000)
    debugBus.record('webaudio.sampleRate', ctx.sampleRate)

    const wallMs = performance.now()
    const ctxMs = ctx.currentTime * 1000
    if (ctx.state === 'running') {
      if (anchorWallMs === null) {
        anchorWallMs = wallMs
        anchorCtxMs = ctxMs
      } else {
        // Both clocks live in the same process, so this comparison is sound —
        // unlike cross-process timestamps (utility vs renderer), which is why
        // datapath.ts deliberately does NOT attempt a similar measurement.
        const expectedCtxMs = ctxMs - anchorCtxMs!
        const expectedWallMs = wallMs - anchorWallMs
        debugBus.record('webaudio.clockDriftMs', expectedCtxMs - expectedWallMs)
      }
    } else {
      anchorWallMs = null
      anchorCtxMs = null
    }

    debugBus.setStatus('webaudio', {
      available: true,
      state: ctx.state,
      sampleRate: ctx.sampleRate,
    })
  }

  const timer = setInterval(poll, 1000)
  poll()

  return () => clearInterval(timer)
}
