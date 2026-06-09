import * as Tone from 'tone'
import type { StepCount } from '../protocol/syncProtocol'

export const DEFAULT_STEP_COUNT: StepCount = 16
export const MAX_PATTERNS = 8

export const DRUM_TRACKS = ['kick', 'snare', 'hat', 'crash'] as const

export type DrumTrack = (typeof DRUM_TRACKS)[number]

export type DrumPattern = Record<DrumTrack, boolean[]>
export type DrumVelocity = Record<DrumTrack, number[]>

export const DEFAULT_VELOCITY = 100

export type PatternSlot = {
  pattern: DrumPattern
  velocity: DrumVelocity
  stepCount: StepCount
}

export type DrumMachineState = {
  currentStep: number
  isLoaded: boolean
  /** Whether this instance's sequencer is currently advancing (project transport running). */
  running: boolean
  activePatternIndex: number
  swing: number
  // Active slot — convenience aliases for the sequencer grid
  pattern: DrumPattern
  velocity: DrumVelocity
  stepCount: StepCount
  // Which slots have at least one active step (for bank UI)
  patternActivity: boolean[]
  // Pattern chain — null means just loop active pattern
  chain: number[] | null
  chainPosition: number
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

const createEmptyPattern = (stepCount: StepCount): DrumPattern => ({
  kick: Array(stepCount).fill(false),
  snare: Array(stepCount).fill(false),
  hat: Array(stepCount).fill(false),
  crash: Array(stepCount).fill(false),
})

const createDefaultVelocity = (stepCount: StepCount): DrumVelocity => ({
  kick: Array(stepCount).fill(DEFAULT_VELOCITY),
  snare: Array(stepCount).fill(DEFAULT_VELOCITY),
  hat: Array(stepCount).fill(DEFAULT_VELOCITY),
  crash: Array(stepCount).fill(DEFAULT_VELOCITY),
})

const clonePattern = (p: DrumPattern): DrumPattern => ({
  kick: [...p.kick], snare: [...p.snare], hat: [...p.hat], crash: [...p.crash],
})

const cloneVelocity = (v: DrumVelocity): DrumVelocity => ({
  kick: [...v.kick], snare: [...v.snare], hat: [...v.hat], crash: [...v.crash],
})

const createEmptySlot = (): PatternSlot => ({
  pattern: createEmptyPattern(DEFAULT_STEP_COUNT),
  velocity: createDefaultVelocity(DEFAULT_STEP_COUNT),
  stepCount: DEFAULT_STEP_COUNT,
})

const slotHasContent = (slot: PatternSlot): boolean =>
  DRUM_TRACKS.some((t) => slot.pattern[t].some(Boolean))

export class DrumMachine {
  private currentStep = 0
  private loaded = false
  private running = false
  private swing = 0
  private activePatternIndex = 0
  private chain: number[] | null = null
  private chainPosition = 0
  private patterns: PatternSlot[] = Array.from({ length: MAX_PATTERNS }, createEmptySlot)
  private players: Tone.Players | null = null
  private scheduleId: number | null = null
  private loadPromise: Promise<void> | null = null
  private listeners = new Set<StepChangeListener>()

  private get activeSlot(): PatternSlot {
    return this.patterns[this.activePatternIndex]
  }

  getState(): DrumMachineState {
    const slot = this.activeSlot
    return {
      currentStep: this.currentStep,
      isLoaded: this.loaded,
      running: this.running,
      activePatternIndex: this.activePatternIndex,
      swing: this.swing,
      pattern: clonePattern(slot.pattern),
      velocity: cloneVelocity(slot.velocity),
      stepCount: slot.stepCount,
      patternActivity: this.patterns.map(slotHasContent),
      chain: this.chain ? [...this.chain] : null,
      chainPosition: this.chainPosition,
    }
  }

  getPatternBank(): PatternSlot[] {
    return this.patterns.map((slot) => ({
      pattern: clonePattern(slot.pattern),
      velocity: cloneVelocity(slot.velocity),
      stepCount: slot.stepCount,
    }))
  }

  subscribe(listener: StepChangeListener) {
    this.listeners.add(listener)
    listener(this.getState())
    return () => { this.listeners.delete(listener) }
  }

  async loadSamples() {
    if (this.loaded) return

    this.loadPromise ??= new Promise<void>((resolve, reject) => {
      this.players = new Tone.Players({
        urls: sampleUrls,
        onload: () => { this.loaded = true; this.emitChange(); resolve() },
        onerror: reject,
        fadeOut: 0.01,
      }).toDestination()
    })

    await this.loadPromise
  }

  /**
   * Arm this instance's sequencer on the shared project transport. The CALLER
   * owns the transport (App calls `audioEngine.play()` once) — a DrumMachine no
   * longer starts/stops `Tone.Transport`, so multiple instances coexist without
   * fighting over it. Each instance maintains its OWN `currentStep` and its own
   * `scheduleRepeat`; no instance touches the global loop points.
   */
  async start(options: DrumMachineStartOptions = {}) {
    await this.loadSamples()
    this.ensureScheduled()
    const rawStep = options.step ?? 0
    this.currentStep =
      Number.isInteger(rawStep) && rawStep >= 0 && rawStep < this.activeSlot.stepCount
        ? rawStep
        : 0
    this.running = true
    this.emitChange()
  }

  stop() {
    this.running = false
    this.currentStep = 0
    this.emitChange()
  }

  /**
   * Play a single drum voice immediately — used by the `midi`-in path (a Piano
   * Roll or mask drives the kit via NoteEvents). Independent of the sequencer.
   * Loads samples lazily; the first note before load completes is dropped.
   */
  triggerVoice(track: DrumTrack, velocity: number = DEFAULT_VELOCITY, time?: number) {
    if (!this.loaded) { void this.loadSamples(); return }
    if (!this.players?.loaded) return
    const vel = Math.min(127, Math.max(1, Math.round(velocity)))
    const player = this.players.player(track)
    player.volume.value = 20 * Math.log10(vel / 127)
    player.start(time)
  }

  // ── Pattern bank ─────────────────────────────────────────────────────────

  setChain(chain: number[] | null) {
    this.chain = chain ? [...chain] : null
    this.chainPosition = 0
    if (chain !== null && chain.length > 0) {
      const prevStepCount = this.activeSlot.stepCount
      this.activePatternIndex = chain[0]
      if (this.activeSlot.stepCount !== prevStepCount) {
        this.currentStep = 0
        this.reschedule()
      }
    }
    this.emitChange()
  }

  switchPattern(index: number) {
    if (index < 0 || index >= MAX_PATTERNS) return
    if (index === this.activePatternIndex) return

    const prevStepCount = this.activeSlot.stepCount
    this.activePatternIndex = index

    // When manually switching, align chain position to this pattern if it's in the chain
    if (this.chain !== null) {
      const pos = this.chain.indexOf(index)
      if (pos >= 0) this.chainPosition = pos
    }

    if (this.activeSlot.stepCount !== prevStepCount) {
      this.currentStep = 0
      this.reschedule()
    }

    this.emitChange()
  }

  setPatternBank(bank: PatternSlot[], activeIndex: number) {
    this.patterns = Array.from({ length: MAX_PATTERNS }, (_, i) => {
      const slot = bank[i]
      if (!slot) return createEmptySlot()
      const sc = slot.stepCount ?? DEFAULT_STEP_COUNT
      return {
        pattern: {
          kick: normalizeTrack(slot.pattern.kick, sc),
          snare: normalizeTrack(slot.pattern.snare, sc),
          hat: normalizeTrack(slot.pattern.hat, sc),
          crash: normalizeTrack(slot.pattern.crash, sc),
        },
        velocity: {
          kick: normalizeVelTrack(slot.velocity?.kick ?? [], sc),
          snare: normalizeVelTrack(slot.velocity?.snare ?? [], sc),
          hat: normalizeVelTrack(slot.velocity?.hat ?? [], sc),
          crash: normalizeVelTrack(slot.velocity?.crash ?? [], sc),
        },
        stepCount: sc,
      }
    })
    this.activePatternIndex = Math.min(Math.max(0, activeIndex), MAX_PATTERNS - 1)
    this.currentStep = 0
    this.reschedule()
    this.emitChange()
  }

  // ── Active-slot operations ────────────────────────────────────────────────

  setSwing(value: number) {
    this.swing = Math.min(100, Math.max(0, Math.round(value)))
    this.emitChange()
  }

  setStepCount(next: StepCount) {
    const slot = this.activeSlot
    if (next === slot.stepCount) return

    for (const track of DRUM_TRACKS) {
      slot.pattern[track] = Array.from({ length: next }, (_, i) => slot.pattern[track][i] ?? false)
      slot.velocity[track] = Array.from({ length: next }, (_, i) => slot.velocity[track][i] ?? DEFAULT_VELOCITY)
    }
    slot.stepCount = next
    this.currentStep = 0
    this.reschedule()
    this.emitChange()
  }

  setVelocity(track: DrumTrack, step: number, value: number) {
    const normalizedStep = this.normalizeStep(step)
    const clamped = Math.min(127, Math.max(1, Math.round(value)))
    this.activeSlot.velocity[track][normalizedStep] = clamped
    this.emitChange()
    return clamped
  }

  toggleStep(track: DrumTrack, step: number, value?: boolean) {
    const normalizedStep = this.normalizeStep(step)
    const nextValue = value ?? !this.activeSlot.pattern[track][normalizedStep]
    this.activeSlot.pattern[track][normalizedStep] = nextValue
    this.emitChange()
    return nextValue
  }

  clearPattern() {
    const sc = this.activeSlot.stepCount
    this.activeSlot.pattern = createEmptyPattern(sc)
    this.activeSlot.velocity = createDefaultVelocity(sc)
    this.emitChange()
  }

  setPattern(pattern: DrumPattern, stepCount?: StepCount, velocity?: DrumVelocity) {
    const slot = this.activeSlot
    if (stepCount !== undefined) slot.stepCount = stepCount
    const sc = slot.stepCount
    slot.pattern = {
      kick: normalizeTrack(pattern.kick, sc),
      snare: normalizeTrack(pattern.snare, sc),
      hat: normalizeTrack(pattern.hat, sc),
      crash: normalizeTrack(pattern.crash, sc),
    }
    slot.velocity = velocity
      ? {
          kick: normalizeVelTrack(velocity.kick, sc),
          snare: normalizeVelTrack(velocity.snare, sc),
          hat: normalizeVelTrack(velocity.hat, sc),
          crash: normalizeVelTrack(velocity.crash, sc),
        }
      : createDefaultVelocity(sc)
    this.reschedule()
    this.emitChange()
  }

  dispose() {
    if (this.scheduleId !== null) {
      Tone.getTransport().clear(this.scheduleId)
      this.scheduleId = null
    }
    this.players?.dispose()
    this.players = null
    this.loaded = false
    this.loadPromise = null
    this.listeners.clear()
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private ensureScheduled() {
    if (this.scheduleId !== null) return
    this.installSchedule()
  }

  private reschedule() {
    if (this.scheduleId !== null) {
      Tone.getTransport().clear(this.scheduleId)
      this.scheduleId = null
    }
    if (Tone.getTransport().state === 'started') this.installSchedule()
  }

  private installSchedule() {
    // No loop ownership here: the drum used to set Tone.getTransport().loop +
    // setLoopPoints, which made multiple instances fight over the global loop.
    // Each instance now just self-increments its step on every 16th; the loop
    // region (if any) belongs solely to the Timeline (audioEngine.setLoopRegion).
    this.scheduleId = Tone.getTransport().scheduleRepeat((time) => {
      this.playStep(this.currentStep, time)
      const nextStep = (this.currentStep + 1) % this.activeSlot.stepCount

      if (nextStep === 0 && this.chain !== null && this.chain.length > 0) {
        this.chainPosition = (this.chainPosition + 1) % this.chain.length
        this.activePatternIndex = this.chain[this.chainPosition]
      }

      this.currentStep = nextStep
      this.emitChange()
    }, '16n')
  }

  private playStep(step: number, time: number) {
    if (!this.players?.loaded) return

    const slot = this.activeSlot

    // Swing: delay odd steps by swing% of one-third of a 16th note
    const isOddStep = step % 2 === 1
    const audioTime =
      isOddStep && this.swing > 0
        ? time + (this.swing / 100) * (1 / 3) * Tone.Time('16n').toSeconds()
        : time

    for (const track of DRUM_TRACKS) {
      if (slot.pattern[track][step]) {
        const vel = slot.velocity[track][step] ?? DEFAULT_VELOCITY
        const player = this.players.player(track)
        player.volume.value = 20 * Math.log10(vel / 127)
        player.start(audioTime)
      }
    }
  }

  private normalizeStep(step: number) {
    if (!Number.isInteger(step) || step < 0 || step >= this.activeSlot.stepCount) {
      throw new RangeError(`Step must be 0–${this.activeSlot.stepCount - 1}`)
    }
    return step
  }

  private emitChange() {
    const state = this.getState()
    this.listeners.forEach((l) => l(state))
  }
}

// Module-level helpers (used in setPatternBank and setPattern)
function normalizeTrack(src: boolean[], stepCount: StepCount): boolean[] {
  return Array.from({ length: stepCount }, (_, i) => Boolean(src[i]))
}

function normalizeVelTrack(src: number[], stepCount: StepCount): number[] {
  return Array.from({ length: stepCount }, (_, i) => {
    const v = src[i]
    return typeof v === 'number' && v >= 1 && v <= 127 ? Math.round(v) : DEFAULT_VELOCITY
  })
}
