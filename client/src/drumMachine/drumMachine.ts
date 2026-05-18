import * as Tone from 'tone'
import { audioEngine } from '../audio/audioEngine'

export const STEP_COUNT = 16

export const DRUM_TRACKS = ['kick', 'snare', 'hat', 'crash'] as const

export type DrumTrack = (typeof DRUM_TRACKS)[number]

export type DrumPattern = Record<DrumTrack, boolean[]>

export type DrumMachineState = {
  currentStep: number
  isLoaded: boolean
  pattern: DrumPattern
}

export type DrumMachineStartOptions = {
  step?: number
}

export type StepChangeListener = (state: DrumMachineState) => void

const sampleUrls: Record<DrumTrack, string> = {
  kick: './samples/kick.wav',
  snare: './samples/snare.wav',
  hat: './samples/hat.wav',
  crash: './samples/crash.wav',
}

const createEmptyPattern = (): DrumPattern => ({
  kick: Array(STEP_COUNT).fill(false),
  snare: Array(STEP_COUNT).fill(false),
  hat: Array(STEP_COUNT).fill(false),
  crash: Array(STEP_COUNT).fill(false),
})

const clonePattern = (pattern: DrumPattern): DrumPattern => ({
  kick: [...pattern.kick],
  snare: [...pattern.snare],
  hat: [...pattern.hat],
  crash: [...pattern.crash],
})

class DrumMachine {
  private currentStep = 0
  private loaded = false
  private pattern = createEmptyPattern()
  private players: Tone.Players | null = null
  private scheduleId: number | null = null
  private loadPromise: Promise<void> | null = null
  private listeners = new Set<StepChangeListener>()

  getState(): DrumMachineState {
    return {
      currentStep: this.currentStep,
      isLoaded: this.loaded,
      pattern: clonePattern(this.pattern),
    }
  }

  subscribe(listener: StepChangeListener) {
    this.listeners.add(listener)
    listener(this.getState())

    return () => {
      this.listeners.delete(listener)
    }
  }

  async loadSamples() {
    if (this.loaded) {
      return
    }

    this.loadPromise ??= new Promise<void>((resolve, reject) => {
      this.players = new Tone.Players({
        urls: sampleUrls,
        onload: () => {
          this.loaded = true
          this.emitChange()
          resolve()
        },
        onerror: reject,
        fadeOut: 0.01,
      }).toDestination()
    })

    await this.loadPromise
  }

  async start(options: DrumMachineStartOptions = {}) {
    await this.loadSamples()
    this.ensureScheduled()
    const rawStep = options.step ?? 0
    // Guard against out-of-bounds step from remote snapshot
    this.currentStep = Number.isInteger(rawStep) && rawStep >= 0 && rawStep < STEP_COUNT
      ? rawStep
      : 0
    this.emitChange()
    await audioEngine.play({ position: 0 })
  }

  stop() {
    audioEngine.stop()
    this.currentStep = 0
    this.emitChange()
  }

  toggleStep(track: DrumTrack, step: number, value?: boolean) {
    const normalizedStep = this.normalizeStep(step)
    const nextValue = value ?? !this.pattern[track][normalizedStep]

    this.pattern[track][normalizedStep] = nextValue
    this.emitChange()

    return nextValue
  }

  clearPattern() {
    this.pattern = createEmptyPattern()
    this.emitChange()
  }

  setPattern(pattern: DrumPattern) {
    this.pattern = {
      kick: this.normalizeTrackPattern(pattern.kick),
      snare: this.normalizeTrackPattern(pattern.snare),
      hat: this.normalizeTrackPattern(pattern.hat),
      crash: this.normalizeTrackPattern(pattern.crash),
    }
    this.emitChange()
  }

  dispose() {
    if (this.scheduleId !== null) {
      Tone.Transport.clear(this.scheduleId)
      this.scheduleId = null
    }

    this.players?.dispose()
    this.players = null
    this.loaded = false
    this.loadPromise = null
    this.listeners.clear()
  }

  private ensureScheduled() {
    if (this.scheduleId !== null) {
      return
    }

    Tone.Transport.loop = true
    Tone.Transport.setLoopPoints(0, '1m')
    this.scheduleId = Tone.Transport.scheduleRepeat((time) => {
      this.playStep(this.currentStep, time)
      this.currentStep = (this.currentStep + 1) % STEP_COUNT
      this.emitChange()
    }, '16n')
  }

  private playStep(step: number, time: number) {
    if (!this.players?.loaded) {
      return
    }

    for (const track of DRUM_TRACKS) {
      if (this.pattern[track][step]) {
        this.players.player(track).start(time)
      }
    }
  }

  private normalizeStep(step: number) {
    if (!Number.isInteger(step) || step < 0 || step >= STEP_COUNT) {
      throw new RangeError(`Step must be an integer from 0 to ${STEP_COUNT - 1}`)
    }

    return step
  }

  private normalizeTrackPattern(trackPattern: boolean[]) {
    return Array.from({ length: STEP_COUNT }, (_, step) => Boolean(trackPattern[step]))
  }

  private emitChange() {
    const state = this.getState()
    this.listeners.forEach((listener) => listener(state))
  }
}

export const drumMachine = new DrumMachine()
