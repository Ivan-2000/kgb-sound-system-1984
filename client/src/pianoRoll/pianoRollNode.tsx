import { defineNode } from '../graph/defineNode'
import type { NodeDefinition } from '../graph/types'
import { usePianoRollStore } from './pianoRollStore'
import { PianoTransport } from './pianoTransport'
import { PianoRollPanel } from './PianoRollPanel'

/**
 * Piano Roll — node #5. A standalone MIDI source: it owns the note grid
 * (`pianoRollStore`) and, while the transport runs, emits a {@link NoteEvent}
 * on `notesOut` at each 16th step where a note begins. Cable `notesOut` into any
 * `midi`-in (Drum Kit, Sampler, …) to make it sound — it carries no voice.
 *
 * Playback runs on the node's OWN clock ({@link PianoTransport}) with its own
 * play/stop — independent of the project transport (global Play). Tempo follows
 * the shared BPM. One transport per node, so duplicated Piano Rolls play their
 * own patterns. (Prototype note: notes fire on the clock step, not sample-
 * accurately re-timed downstream — see TASKS_UI.md.)
 */
export const pianoRollNode: NodeDefinition = defineNode({
  manifest: {
    type: 'piano-roll',
    label: 'Piano Roll',
    icon: '🎹',
    description: 'FL-редактор нот → MIDI',
    version: '1.0.0',
    author: 'KGB Sound',
    singleton: true,
    ports: [
      { id: 'notesOut', label: 'Notes Out', kind: 'midi', direction: 'out' },
    ],
    params: [],
    defaults: { panelPos: { x: 360, y: 120 }, canvasPos: { x: 1080, y: 40 }, size: { w: 600, h: 440 } },
  },
  create: (ctx) => {
    const transport = new PianoTransport(
      (n) => ctx.emit('notesOut', n),
      () => { const { notes, bars } = usePianoRollStore.getState(); return { notes, bars } },
    )
    return {
      render: () => <PianoRollPanel ctx={ctx} transport={transport} />,
      dispose: () => transport.dispose(),
    }
  },
})
