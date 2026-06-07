import * as Tone from 'tone'
import { audioEngine } from '../audio/audioEngine'
import type { NoteEvent } from '../graph/types'
import { STEPS_PER_BAR, type PianoNote } from './pianoRollStore'

type Model = { notes: PianoNote[]; bars: number }

/**
 * Per-instance playback clock for a Piano Roll node.
 *
 * Independent of the project transport (`Tone.Transport` / the global Play
 * button) — each Piano Roll runs its OWN `Tone.Clock`, started/stopped by its
 * own play button, looping over its own bars. Tempo still follows the shared
 * BPM (`audioEngine`). One instance per node (created in the node's `create()`),
 * so duplicated Piano Rolls each play their own pattern.
 */
export class PianoTransport {
  private clock: Tone.Clock
  private step = 0
  private current = 0
  isPlaying = false

  constructor(
    private readonly emit: (n: NoteEvent) => void,
    private readonly getModel: () => Model,
  ) {
    this.clock = new Tone.Clock(() => this.onTick(), this.freq())
  }

  /** Sixteenth-notes per second at the current shared BPM. */
  private freq(): number {
    return (audioEngine.getBpm() / 60) * 4
  }

  private onTick(): void {
    this.clock.frequency.value = this.freq() // follow live BPM changes
    const { notes, bars } = this.getModel()
    const total = Math.max(1, bars * STEPS_PER_BAR)
    const s = this.step % total
    this.current = s
    for (const n of notes) {
      if (n.startStep === s) {
        this.emit({ pitch: n.pitch, velocity: n.velocity, durationBeats: n.lengthSteps / 4, id: n.id })
      }
    }
    this.step = (s + 1) % total
  }

  async play(): Promise<void> {
    await Tone.start()
    this.step = 0
    this.current = 0
    this.clock.frequency.value = this.freq()
    this.clock.start()
    this.isPlaying = true
  }

  stop(): void {
    this.clock.stop()
    this.isPlaying = false
    this.step = 0
    this.current = 0
  }

  async toggle(): Promise<void> {
    if (this.isPlaying) this.stop()
    else await this.play()
  }

  /** Current 16th-step for the playhead (0 when stopped). */
  getStep(): number {
    return this.isPlaying ? this.current : 0
  }

  dispose(): void {
    try { this.clock.stop(); this.clock.dispose() } catch { /* already disposed */ }
  }
}
