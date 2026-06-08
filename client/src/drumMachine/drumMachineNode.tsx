import { useEffect, useState } from 'react'
import { defineNode } from '../graph/defineNode'
import type { NodeDefinition } from '../graph/types'
import { DrumMachine, DRUM_TRACKS, type DrumMachineState, type DrumTrack } from './drumMachine'
import {
  registerDrum,
  unregisterDrum,
  emitDrumSync,
  subscribeDrumEditable,
} from './drumNodes'
import { DrumMachinePanel } from '../components/DrumMachinePanel'
import { audioEngine } from '../audio/audioEngine'
import { getTimeline } from '../timeline/timelineNodes'
import { STEPS_PER_BAR } from '../pianoRoll/pianoRollStore'
import type { PianoNote } from '../pianoRoll/pianoRollStore'

const DRUM_PITCH: Record<DrumTrack, number> = { kick: 36, snare: 38, hat: 42, crash: 49 }

function buildDrumNotes(dm: DrumMachine): { notes: PianoNote[]; bars: number; durSec: number } {
  const state = dm.getState()
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

/**
 * Drum Machine — node #4. Unlike the early built-ins, this node is NOT `thin`:
 * its `create()` owns a per-instance {@link DrumMachine} engine (registered by
 * `nodeId`) and returns a self-contained {@link DrumNodeView}. The presentational
 * {@link DrumMachinePanel} is driven entirely by this instance's state — so once
 * `singleton` is flipped off, each duplicate plays its own independent pattern.
 *
 * Behaviour:
 *  - `notesIn` (midi): incoming {@link NoteEvent}s play voices (pitch → voice).
 *  - The internal sequencer runs on the SHARED project transport (global Play),
 *    self-incrementing its own step — App owns `audioEngine.play/stop`.
 *  - Edits mutate the instance locally, then `emitDrumSync` broadcasts the intent
 *    so App turns it into a room sync event (host-gating via the editable flag).
 *
 * (Imports use specific `../graph/*` modules, NOT the barrel, to avoid the
 * index → nodes → builtins → drumMachineNode → index init cycle — same as
 * pianoRollNode.)
 */

/** Self-contained UI for one drum node: subscribes to its OWN instance + room editability. */
function DrumNodeView({ nodeId, dm }: { nodeId: string; dm: DrumMachine }) {
  const [state, setState] = useState<DrumMachineState>(() => dm.getState())
  const [editable, setEditable] = useState(true)

  useEffect(() => dm.subscribe(setState), [dm])
  useEffect(() => subscribeDrumEditable(setEditable), [])

  const disabled = !editable

  const handleTransferToTimeline = () => {
    const tl = getTimeline('timeline')
    if (!tl) {
      alert('Откройте Timeline (кнопка 🎞 в тулбаре) перед переносом паттерна.')
      return
    }
    const { notes, bars, durSec } = buildDrumNotes(dm)
    const st = tl.getState()
    const trackId = st.addTrack({ name: 'Drum', kind: 'midi', color: 'var(--gold)' })
    st.addClip({ trackId, startSec: 0, durSec, label: 'Drum Pattern', kind: 'midi', notes, clipBars: bars })
  }

  return (
    <DrumMachinePanel
      state={state}
      isPlaying={state.running}
      disabled={disabled}
      onStepToggle={(track, step) => {
        const value = dm.toggleStep(track, step)
        emitDrumSync(nodeId, { type: 'step_toggle', track, step, value })
      }}
      onVelocityChange={(track, step, velocity) => {
        const clamped = dm.setVelocity(track, step, velocity)
        emitDrumSync(nodeId, { type: 'velocity_change', track, step, velocity: clamped })
      }}
      onPatternSwitch={(i) => {
        dm.switchPattern(i)
        emitDrumSync(nodeId, { type: 'pattern_switch', patternIndex: i })
      }}
      onStepCountChange={(n) => {
        dm.setStepCount(n)
        emitDrumSync(nodeId, { type: 'step_count_change', stepCount: n })
      }}
      onSwingChange={(s) => {
        dm.setSwing(s)
        emitDrumSync(nodeId, { type: 'swing_change', swing: s })
      }}
      onChainSet={(chain) => {
        dm.setChain(chain)
        emitDrumSync(nodeId, { type: 'chain_set', chain })
      }}
      onTransferToTimeline={handleTransferToTimeline}
    />
  )
}

export const drumMachineNode: NodeDefinition = defineNode({
  manifest: {
    type: 'drum-machine',
    label: 'Drum Machine',
    icon: '🥁',
    description: '16-шаговый секвенсор',
    version: '1.0.0',
    author: 'KGB Sound',
    // The primary kit is a singleton (auto-created with deterministic id
    // 'drum-machine', opened from the toolbar/`+`), but `duplicable` lets
    // ПКМ → Дублировать spawn independent copies with fresh ids that sync
    // per-nodeId. See drumNodes.ts + the per-node `drums` map on the server.
    singleton: true,
    // duplicable removed (2026-06-07): per-node drum state + hydration is
    // complex; re-enable after Piano Roll → clip editor (Phase 3) stabilises.
    ports: [
      { id: 'clock', label: 'Clock', kind: 'trigger', direction: 'in' },
      { id: 'notesIn', label: 'Notes In', kind: 'midi', direction: 'in' },
      { id: 'kick', label: 'Kick', kind: 'trigger', direction: 'out' },
      { id: 'snare', label: 'Snare', kind: 'trigger', direction: 'out' },
      { id: 'hat', label: 'Hat', kind: 'trigger', direction: 'out' },
      { id: 'crash', label: 'Crash', kind: 'trigger', direction: 'out' },
      { id: 'notesOut', label: 'Notes Out', kind: 'midi', direction: 'out' },
      { id: 'audioOut', label: 'Audio Out', kind: 'audio', direction: 'out' },
    ],
    params: [],
    defaults: { panelPos: { x: 260, y: 60 }, canvasPos: { x: 440, y: 40 }, size: { w: 520, h: 340 } },
  },
  create: (ctx) => {
    const dm = new DrumMachine()
    registerDrum(ctx.nodeId, dm)

    // notesIn subscription removed (pivot 2026-06-06, G4f-3): ControlBus
    // routing is disabled, so onInput would never fire. Live MIDI from an
    // external device will be wired directly (Phase 5 MI3–MI5), not via notesIn.

    return {
      render: () => <DrumNodeView nodeId={ctx.nodeId} dm={dm} />,
      dispose: () => {
        unregisterDrum(ctx.nodeId)
        dm.dispose()
      },
    }
  },
})
