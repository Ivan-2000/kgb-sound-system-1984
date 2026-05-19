import * as Tone from 'tone'

// Minimum drift to start correcting (seconds)
const DRIFT_THRESHOLD_S = 0.1
// Maximum BPM adjustment in either direction
const MAX_BPM_CORRECTION = 2
// Seconds over which correction ramps
const CORRECTION_RAMP_S = 3

export type ClockGridEvent = {
  serverTime: number
  playStartAt: number
  bpm: number
}

class ClockSync {
  private baseBpm = 120
  private correctionActive = false

  setBaseBpm(bpm: number) {
    this.baseBpm = bpm
  }

  /**
   * Called each time the server emits a clock_grid event.
   * Uses the server's authoritative timeline to detect and gently correct
   * local Tone.Transport drift via a small BPM ramp.
   *
   * Formula: correctedBpm = baseBpm / (1 + drift / correctionWindowSec)
   * — if we're ahead, slow down; if behind, speed up.
   */
  update(event: ClockGridEvent, ownRttMs: number) {
    if (Tone.Transport.state !== 'started') return

    this.baseBpm = event.bpm

    const oneWayMs = ownRttMs / 2
    const expectedSec = (event.serverTime + oneWayMs - event.playStartAt) / 1000
    if (expectedSec <= 0) return

    const actualSec = Tone.Transport.seconds
    const driftSec = actualSec - expectedSec  // positive = we're ahead

    if (Math.abs(driftSec) < DRIFT_THRESHOLD_S) {
      if (this.correctionActive) {
        Tone.Transport.bpm.rampTo(this.baseBpm, CORRECTION_RAMP_S)
        this.correctionActive = false
      }
      return
    }

    // Target: reduce drift over a 10-second window
    // correctedBpm = baseBpm / (1 + driftSec / 10)
    // When ahead (driftSec > 0): denominator > 1 → slower ✓
    // When behind (driftSec < 0): denominator < 1 → faster ✓
    const raw = this.baseBpm / (1 + driftSec / 10)
    const correctedBpm = Math.max(
      this.baseBpm - MAX_BPM_CORRECTION,
      Math.min(this.baseBpm + MAX_BPM_CORRECTION, raw),
    )

    Tone.Transport.bpm.rampTo(correctedBpm, CORRECTION_RAMP_S)
    this.correctionActive = true
  }

  reset() {
    this.correctionActive = false
  }
}

export const clockSync = new ClockSync()
