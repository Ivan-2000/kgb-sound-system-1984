import * as Tone from 'tone'
import type { TimelineStoreApi } from './timelineStore'
import { getDrum } from '../drumMachine/drumNodes'
import type { DrumTrack } from '../drumMachine/drumMachine'

/** Drum pitch → DrumTrack mapping (GM standard). */
const DRUM_PITCH_MAP: Partial<Record<number, DrumTrack>> = {
  36: 'kick',
  38: 'snare',
  42: 'hat',
  49: 'crash',
}

/** IDs of currently scheduled Tone.Transport events (cleared on re-schedule or stop). */
const scheduledEventIds: number[] = []

/**
 * Schedule all MIDI clips in `store` whose notes map to drum pitches.
 * Call this right before the transport starts.
 *
 * Only the PRIMARY drum machine (nodeId 'drum-machine') is targeted.
 * Melodic pitches are silently skipped until a VST instrument is available (Phase 2 V-series).
 */
export function scheduleMidiClips(store: TimelineStoreApi): void {
  clearMidiClipSchedule()

  const dm = getDrum('drum-machine')
  if (!dm) return

  const { clips } = store.getState()
  const bpm = Tone.getTransport().bpm.value
  const sixteenthSec = 60 / (bpm * 4)

  for (const clip of clips) {
    if (clip.kind !== 'midi' || !clip.notes?.length) continue

    for (const note of clip.notes) {
      const track = DRUM_PITCH_MAP[note.pitch]
      if (!track) continue

      const absTime = clip.startSec + note.startStep * sixteenthSec
      const id = Tone.getTransport().schedule((time) => {
        dm.triggerVoice(track, note.velocity, time)
      }, absTime)
      scheduledEventIds.push(id)
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
