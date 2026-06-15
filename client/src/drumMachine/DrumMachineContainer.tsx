import { useEffect, useState } from 'react'
import { drumMachine } from './drumSingleton'
import { DRUM_TRACKS, type DrumMachineState, type DrumTrack } from './drumMachine'
import { emitDrumSync, subscribeDrumEditable } from './drumNodes'
import { DrumMachinePanel } from '../components/DrumMachinePanel'
import { audioEngine } from '../audio/audioEngine'
import { timelineStore } from '../timeline/timelineSingleton'
import { STEPS_PER_BAR, type PianoNote } from '../pianoRoll/pianoRollStore'

/**
 * Стейтфул-контейнер драм-машины (бывший DrumNodeView из drumMachineNode.tsx,
 * без нодовой обёртки). Привязан к singleton-движку {@link drumMachine}; UI —
 * презентационный {@link DrumMachinePanel}. Правки мутируют движок локально и
 * через {@link emitDrumSync} уходят в room-sync (host-gating через editable).
 */

const DRUM_PITCH: Record<DrumTrack, number> = { kick: 36, snare: 38, hat: 42, crash: 49 }

function buildDrumNotes(): { notes: PianoNote[]; bars: number; durSec: number } {
  const state = drumMachine.getState()
  const bpm = audioEngine.getBpm()
  const notes: PianoNote[] = []
  let idCounter = 0
  for (const track of DRUM_TRACKS) {
    for (let step = 0; step < state.stepCount; step++) {
      if (state.pattern[track][step]) {
        notes.push({
          id: `drum-${(++idCounter).toString(36)}`,
          pitch: DRUM_PITCH[track],
          startStep: step,
          lengthSteps: 1,
          velocity: state.velocity[track][step] ?? 100,
        })
      }
    }
  }
  const bars = Math.max(1, Math.ceil(state.stepCount / STEPS_PER_BAR))
  const durSec = state.stepCount * (60 / (bpm * 4))
  return { notes, bars, durSec }
}

export function DrumMachineContainer() {
  const [state, setState] = useState<DrumMachineState>(() => drumMachine.getState())
  const [editable, setEditable] = useState(true)

  useEffect(() => drumMachine.subscribe(setState), [])
  useEffect(() => subscribeDrumEditable(setEditable), [])

  const handleTransferToTimeline = () => {
    const { notes, bars, durSec } = buildDrumNotes()
    const st = timelineStore.getState()
    const trackId = st.addTrack({ name: 'Drum', kind: 'midi', color: 'var(--gold)' })
    st.addClip({ trackId, startSec: 0, durSec, label: 'Drum Pattern', kind: 'midi', notes, clipBars: bars })
  }

  return (
    <DrumMachinePanel
      state={state}
      isPlaying={state.running}
      disabled={!editable}
      onStepToggle={(track, step) => {
        const value = drumMachine.toggleStep(track, step)
        emitDrumSync({ type:'step_toggle', track, step, value })
      }}
      onVelocityChange={(track, step, velocity) => {
        const clamped = drumMachine.setVelocity(track, step, velocity)
        emitDrumSync({ type:'velocity_change', track, step, velocity: clamped })
      }}
      onPatternSwitch={(i) => {
        drumMachine.switchPattern(i)
        emitDrumSync({ type:'pattern_switch', patternIndex: i })
      }}
      onStepCountChange={(n) => {
        drumMachine.setStepCount(n)
        emitDrumSync({ type:'step_count_change', stepCount: n })
      }}
      onSwingChange={(s) => {
        drumMachine.setSwing(s)
        emitDrumSync({ type:'swing_change', swing: s })
      }}
      onChainSet={(chain) => {
        drumMachine.setChain(chain)
        emitDrumSync({ type:'chain_set', chain })
      }}
      onTransferToTimeline={handleTransferToTimeline}
    />
  )
}
