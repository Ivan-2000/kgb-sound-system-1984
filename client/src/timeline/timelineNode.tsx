import * as Tone from 'tone'
import { defineNode } from '../graph/defineNode'
import type { NodeDefinition } from '../graph/types'
import { createTimelineStore } from './timelineStore'
import { registerTimeline, unregisterTimeline } from './timelineNodes'
import { TimelinePanel } from '../components/TimelinePanel'
import { scheduleMidiClips, clearMidiClipSchedule } from './midiPlayer'
import { scheduleAudioClips, clearAudioClipSchedule } from './audioClipPlayer'

/**
 * Timeline — node #2. Owns a per-instance store ({@link createTimelineStore},
 * registered by nodeId) and renders a self-contained {@link TimelinePanel} bound
 * to it via `getNodeInstance().render()` — so duplicated timelines are
 * independent (mirrors the per-node Drum Machine). `singleton:true` keeps the
 * PRIMARY timeline (deterministic id `'timeline'`, opened from the toolbar/`+`,
 * targeted by the Mixer's Record); `duplicable:true` lets ПКМ → Дублировать make
 * independent copies. The transport playhead/loop are shared (global) for now.
 *
 * (Imports from specific `../graph/*` modules, not the barrel — avoids the
 * index → nodes → builtins → timelineNode → index init cycle.)
 */
export const timelineNode: NodeDefinition = defineNode({
  manifest: {
    type: 'timeline',
    label: 'Timeline',
    icon: '🎞',
    description: 'Дорожки, клипы, запись',
    version: '1.0.0',
    author: 'KGB Sound',
    singleton: true,
    duplicable: true,
    ports: [
      { id: 'audioIn', label: 'Audio In', kind: 'audio', direction: 'in', multiple: true },
      { id: 'notesIn', label: 'Notes In', kind: 'midi', direction: 'in', multiple: true },
    ],
    params: [],
    defaults: { panelPos: { x: 40, y: 420 }, canvasPos: { x: 40, y: 480 }, size: { w: 560, h: 280 } },
  },
  create: (ctx) => {
    const store = createTimelineStore()
    registerTimeline(ctx.nodeId, store)

    // Schedule MIDI + recorded audio clip playback each time the transport starts.
    const onStart = () => {
      scheduleMidiClips(store)
      scheduleAudioClips(store)
    }
    const onStop = () => clearAudioClipSchedule()
    Tone.getTransport().on('start', onStart)
    Tone.getTransport().on('stop', onStop)

    return {
      render: () => <TimelinePanel store={store} />,
      dispose: () => {
        Tone.getTransport().off('start', onStart)
        Tone.getTransport().off('stop', onStop)
        clearMidiClipSchedule()
        clearAudioClipSchedule()
        unregisterTimeline(ctx.nodeId)
      },
    }
  },
})
