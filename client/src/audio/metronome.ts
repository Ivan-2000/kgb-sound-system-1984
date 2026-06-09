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
}

export type MetronomeListener = (state: MetronomeState) => void

class Metronome {
  private enabled = false
  private soundEnabled = true
  private timeSignature: TimeSignature = DEFAULT_TIME_SIGNATURE
  private currentBeat = 0
  private isPreroll = false
  private prerollTimeouts: ReturnType<typeof setTimeout>[] = []
  private prerollReject: ((reason: unknown) => void) | null = null
  private scheduleId: number | null = null
  private clickHigh: Tone.Synth | null = null
  private clickLow: Tone.Synth | null = null
  private listeners = new Set<MetronomeListener>()

  getState(): MetronomeState {
    return {
      enabled: this.enabled,
      currentBeat: this.currentBeat,
      isDownbeat: this.currentBeat === 0,
      isPreroll: this.isPreroll,
      timeSignature: { ...this.timeSignature },
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
    this.emitChange()
  }

  // Install repeating schedule into Tone.Transport (called when transport starts)
  start() {
    this.clearSchedule()
    this.currentBeat = 0
    this.ensureSynths()

    const beatDuration = this.beatDurationNotation()
    this.scheduleId = Tone.getTransport().scheduleRepeat((time) => {
      const beat = this.currentBeat
      if (this.enabled && this.soundEnabled) {
        this.playClick(beat === 0, time)
      }
      this.currentBeat = (beat + 1) % this.timeSignature.beats
      this.emitChange()
    }, beatDuration)
  }

  // Play N bars of clicks before transport starts.
  // Returns a Promise that resolves when preroll completes, rejects if cancelled via stop().
  // Clicks are scheduled directly into AudioContext time (no Transport needed).
  async startPreroll(bars: number): Promise<void> {
    await Tone.start()
    this.clearPreroll()
    this.ensureSynths()
    this.isPreroll = true
    this.currentBeat = 0
    this.emitChange()

    const bpm = Tone.getTransport().bpm.value
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

      // Respects soundEnabled — preroll is silent in sync-only mode
      if (this.soundEnabled) {
        const synth = beat === 0 ? this.clickHigh! : this.clickLow!
        synth.triggerAttackRelease(beat === 0 ? 1200 : 800, '32n', audioTime)
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.prerollReject = reject
      this.prerollTimeouts.push(setTimeout(() => {
        this.prerollReject = null
        this.isPreroll = false
        this.currentBeat = 0
        this.emitChange()
        resolve()
      }, totalBeats * secsPerBeat * 1000 + 20))
    })
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
    if (this.prerollReject) {
      this.prerollReject(new Error('PREROLL_CANCELLED'))
      this.prerollReject = null
    }
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
      Tone.getTransport().clear(this.scheduleId)
      this.scheduleId = null
    }
  }

  private emitChange() {
    const state = this.getState()
    this.listeners.forEach((l) => l(state))
  }
}

export const metronome = new Metronome()
