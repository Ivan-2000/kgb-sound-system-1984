import * as Tone from 'tone'
import type { TimelineStoreApi } from './timelineStore'
import { clipAudio } from '../audio/recorder'

/**
 * Playback for recorded AUDIO clips on the timeline (counterpart of
 * midiPlayer.ts for midi clips). Schedules a Tone.Player per clip whose WAV
 * blob is present in clipAudio; called on every transport 'start' and cleared
 * on stop/dispose.
 *
 * Respects track Mute/Solo: muted tracks are skipped; when any track is
 * soloed, only soloed tracks play.
 *
 * Limitations (current data model): clips have no source offset — trimming
 * the left edge moves startSec but playback still begins at the start of the
 * recorded buffer.
 */

const scheduledEventIds: number[] = []
const activePlayers: Tone.Player[] = []
/** Decoded buffers per clipId — blob decoding is async, cache survives restarts. */
const bufferCache = new Map<string, Tone.ToneAudioBuffer>()

export function scheduleAudioClips(store: TimelineStoreApi): void {
  clearAudioClipSchedule()

  const { clips, tracks } = store.getState()
  const anySolo = tracks.some((t) => t.solo)
  const audible = new Set(
    tracks
      .filter((t) => !t.muted && (!anySolo || t.solo))
      .map((t) => t.id),
  )

  for (const clip of clips) {
    if (clip.kind !== 'audio' || clip.proxy) continue
    if (!audible.has(clip.trackId)) continue
    const blob = clipAudio.get(clip.id)
    if (!blob) continue

    // Fire-and-forget: decoding a local blob takes ~ms; the transport event is
    // scheduled only after the buffer is ready, so a clip ahead of the playhead
    // still triggers on time. clearAudioClipSchedule() invalidates via `gen`.
    const gen = scheduleGeneration
    void loadBuffer(clip.id, blob).then((buffer) => {
      if (gen !== scheduleGeneration || !buffer) return
      const player = new Tone.Player(buffer).toDestination()
      activePlayers.push(player)
      const dur = Math.min(clip.durSec, buffer.duration)
      const id = Tone.getTransport().schedule((time) => {
        player.start(time, 0, dur)
      }, clip.startSec)
      scheduledEventIds.push(id)
    })
  }
}

let scheduleGeneration = 0

async function loadBuffer(clipId: string, blob: Blob): Promise<Tone.ToneAudioBuffer | null> {
  const cached = bufferCache.get(clipId)
  if (cached?.loaded) return cached
  try {
    const url = URL.createObjectURL(blob)
    try {
      const buffer = await new Tone.ToneAudioBuffer().load(url)
      bufferCache.set(clipId, buffer)
      return buffer
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.warn('[audioClipPlayer] failed to decode clip', clipId, err)
    return null
  }
}

/** Cancel scheduled events and dispose players — call on transport stop/dispose. */
export function clearAudioClipSchedule(): void {
  scheduleGeneration++
  for (const id of scheduledEventIds) {
    Tone.getTransport().clear(id)
  }
  scheduledEventIds.length = 0
  for (const p of activePlayers) {
    try { p.stop(); p.dispose() } catch { /* already disposed */ }
  }
  activePlayers.length = 0
}
