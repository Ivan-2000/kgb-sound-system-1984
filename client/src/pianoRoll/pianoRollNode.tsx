import { defineNode } from '../graph/defineNode'
import type { NodeDefinition } from '../graph/types'
import { PianoRollPanel } from './PianoRollPanel'

/**
 * Piano Roll — formerly node #5.
 *
 * NOT registered in builtins (PR4, pivot 2026-06-06). Piano Roll is now a
 * per-clip editor opened from the Timeline (PR3), not a standalone node.
 * This file stays in the repo so the module continues to compile and can be
 * re-enabled if needed.
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
  create: () => {
    return {
      render: () => (
        <PianoRollPanel
          initialNotes={[]}
          initialBars={1}
          onChange={() => { /* standalone node — no clip target */ }}
        />
      ),
      dispose: () => { /* nothing */ },
    }
  },
})
