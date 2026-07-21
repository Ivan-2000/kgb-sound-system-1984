import * as Tone from 'tone'
import type { TimelineStoreApi } from './timelineStore'
import { drumMachine } from '../drumMachine/drumSingleton'
import type { DrumTrack } from '../drumMachine/drumMachine'
import { useInsertChainStore, targetKey } from '../audio/insertChainStore'

/** Drum pitch → DrumTrack mapping (GM standard). */
const DRUM_PITCH_MAP: Partial<Record<number, DrumTrack>> = {
  36: 'kick',
  38: 'snare',
  42: 'hat',
  49: 'crash',
}

/** IDs of currently scheduled Tone.Transport events (cleared on re-schedule or stop). */
const scheduledEventIds: number[] = []

const vst = () => (typeof window !== 'undefined' ? window.nativeAudio?.vst : undefined)

/**
 * Schedule all MIDI clips in `store`.
 * - Drum pitches (GM map) → trigger the drum machine voice.
 * - Melodic pitches on tracks with a VSTi insert chain → noteOn/noteOff via VST3.
 * Call this right before the transport starts.
 */
export function scheduleMidiClips(store: TimelineStoreApi): void {
  clearMidiClipSchedule()

  const dm = drumMachine
  const v = vst()

  const transport = Tone.getTransport()
  const { clips, tracks } = store.getState()
  // §5.18: schedule notes at musical TICK positions so they stay locked to the
  // beat grid and reflow when the project tempo changes (MIDI is musical time,
  // not seconds). Expressing offsets in ticks makes the grid-lock explicit.
  const ticksPerSixteenth = transport.PPQ / 4
  const chains = useInsertChainStore.getState().chains

  for (const clip of clips) {
    if (clip.kind !== 'midi' || !clip.notes?.length) continue
    const clipStartTicks = transport.toTicks(clip.startSec)
    const tickAt = (step: number) => `${Math.round(clipStartTicks + step * ticksPerSixteenth)}i`

    for (const note of clip.notes) {
      const drumTrack = DRUM_PITCH_MAP[note.pitch]
      if (drumTrack) {
        const id = transport.schedule((time) => {
          dm.triggerVoice(drumTrack, note.velocity, time)
        }, tickAt(note.startStep))
        scheduledEventIds.push(id)
        continue
      }

      // I3: melodic path — find a VSTi slot on the clip's track
      if (!v) continue
      const track = tracks.find((t) => t.id === clip.trackId)
      if (!track) continue
      const trackSlots = chains[targetKey({ kind: 'track', id: track.id })] ?? []
      const vstSlot = trackSlots.find((s) => !s.bypass && s.type === 'instrument')
      if (!vstSlot) continue

      const slotId = vstSlot.slotId
      const onId = transport.schedule(() => {
        void v.noteOn(slotId, 0, note.pitch, note.velocity)
      }, tickAt(note.startStep))
      const offId = transport.schedule(() => {
        void v.noteOff(slotId, 0, note.pitch)
      }, tickAt(note.startStep + (note.lengthSteps ?? 1)))
      scheduledEventIds.push(onId, offId)
    }
  }
}

/** Cancel all previously scheduled MIDI clip events. */
export function clearMidiClipSchedule(): void {
  for (const id of scheduledEventIds) {
    Tone.getTransport().clear(id)
  }
  scheduledEventIds.length = 0
}
