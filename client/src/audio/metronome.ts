import * as Tone from 'tone'

export type TimeSignature = { beats: number; division: number }

export const COMMON_TIME_SIGNATURES: TimeSignature[] = [
  { beats: 4, division: 4 },
  { beats: 3, division: 4 },
  { beats: 2, division: 4 },
  { beats: 6, division: 8 },
]

export const DEFAULT_TIME_SIGNATURE: TimeSignature = { beats: 4, division: 4 }

export type MetronomeState = {
  enabled: boolean
  currentBeat: number   // 0-based, resets each bar
  isDownbeat: boolean
  isPreroll: boolean
  timeSignature: TimeSignature
  strongBeatIndex: number  // which beat index plays the high click
}

export type MetronomeListener = (state: MetronomeState) => void

class Metronome {
  private enabled = false
  private soundEnabled = true
  private timeSignature: TimeSignature = DEFAULT_TIME_SIGNATURE
  private currentBeat = 0
  private strongBeatIndex = 0
  private isPreroll = false
  private prerollTimeouts: ReturnType<typeof setTimeout>[] = []
  private scheduleId: number | null = null
  private clickHigh: Tone.Synth | null = null
  private clickLow: Tone.Synth | null = null
  private listeners = new Set<MetronomeListener>()

  getState(): MetronomeState {
    return {
      enabled: this.enabled,
      currentBeat: this.currentBeat,
      isDownbeat: this.currentBeat === this.strongBeatIndex,
      isPreroll: this.isPreroll,
      timeSignature: { ...this.timeSignature },
      strongBeatIndex: this.strongBeatIndex,
    }
  }

  subscribe(listener: MetronomeListener) {
    this.listeners.add(listener)
    listener(this.getState())
    return () => { this.listeners.delete(listener) }
  }

  setEnabled(next: boolean) {
    this.enabled = next
    if (!next) {
      this.currentBeat = 0
    }
    this.emitChange()
  }

  setSoundEnabled(next: boolean) {
    this.soundEnabled = next
    this.emitChange()
  }

  setTimeSignature(ts: TimeSignature) {
    this.timeSignature = { ...ts }
    this.currentBeat = 0
    // Clamp strong beat to valid range for new signature
    if (this.strongBeatIndex >= ts.beats) {
      this.strongBeatIndex = 0
    }
    this.emitChange()
  }

  setStrongBeatIndex(index: number) {
    const clamped = Math.max(0, Math.min(this.timeSignature.beats - 1, index))
    this.strongBeatIndex = clamped
    this.emitChange()
  }

  // Called by drumMachine/transport on each beat tick — time is Tone audio context time
  tick(beatIndex: number, time: number) {
    const beat = beatIndex % this.timeSignature.beats
    this.currentBeat = beat

    if (this.enabled && this.soundEnabled) {
      this.playClick(beat === this.strongBeatIndex, time)
    }

    this.emitChange()
  }

  // Install repeating schedule into Tone.Transport (called when transport starts)
  start() {
    this.clearSchedule()
    this.ensureSynths()

    const beatDuration = this.beatDurationNotation()
    this.scheduleId = Tone.Transport.scheduleRepeat((time) => {
      const beat = this.currentBeat
      if (this.enabled && this.soundEnabled) {
        this.playClick(beat === this.strongBeatIndex, time)
      }
      this.currentBeat = (beat + 1) % this.timeSignature.beats
      this.emitChange()
    }, beatDuration)
  }

  // Play N bars of clicks before transport starts, then call onComplete.
  // Clicks are scheduled directly into AudioContext time (no Transport needed).
  async startPreroll(bars: number, onComplete: () => void) {
    await Tone.start()
    this.clearPreroll()
    this.ensureSynths()
    this.isPreroll = true
    this.currentBeat = 0
    this.emitChange()

    const bpm = Tone.Transport.bpm.value
    const secsPerBeat = (60 / bpm) * (4 / this.timeSignature.division)
    const totalBeats = bars * this.timeSignature.beats
    const now = Tone.now()

    for (let i = 0; i < totalBeats; i++) {
      const audioTime = now + i * secsPerBeat
      const beat = i % this.timeSignature.beats

      // UI update via setTimeout — coarse but sufficient for display
      this.prerollTimeouts.push(setTimeout(() => {
        this.currentBeat = beat
        this.emitChange()
      }, i * secsPerBeat * 1000))

      // Audio click — always fires during preroll regardless of enabled flag
      const isStrong = beat === this.strongBeatIndex
      const synth = isStrong ? this.clickHigh! : this.clickLow!
      synth.triggerAttackRelease(isStrong ? 1200 : 800, '32n', audioTime)
    }

    this.prerollTimeouts.push(setTimeout(() => {
      this.isPreroll = false
      this.currentBeat = 0
      this.emitChange()
      onComplete()
    }, totalBeats * secsPerBeat * 1000 + 20))
  }

  stop() {
    this.clearPreroll()
    this.clearSchedule()
    this.currentBeat = 0
    this.emitChange()
  }

  dispose() {
    this.clearPreroll()
    this.clearSchedule()
    this.clickHigh?.dispose()
    this.clickLow?.dispose()
    this.clickHigh = null
    this.clickLow = null
    this.listeners.clear()
  }

  private clearPreroll() {
    for (const t of this.prerollTimeouts) clearTimeout(t)
    this.prerollTimeouts = []
    this.isPreroll = false
  }

  private beatDurationNotation(): string {
    // division 4 → quarter note '4n', division 8 → eighth note '8n'
    return `${this.timeSignature.division}n`
  }

  private ensureSynths() {
    if (!this.clickHigh) {
      this.clickHigh = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
        volume: -6,
      }).toDestination()
    }
    if (!this.clickLow) {
      this.clickLow = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
        volume: -10,
      }).toDestination()
    }
  }

  private playClick(isDownbeat: boolean, time: number) {
    this.ensureSynths()
    const synth = isDownbeat ? this.clickHigh! : this.clickLow!
    const freq = isDownbeat ? 1200 : 800
    synth.triggerAttackRelease(freq, '32n', time)
  }

  private clearSchedule() {
    if (this.scheduleId !== null) {
      Tone.Transport.clear(this.scheduleId)
      this.scheduleId = null
    }
  }

  private emitChange() {
    const state = this.getState()
    this.listeners.forEach((l) => l(state))
  }
}

export const metronome = new Metronome()
