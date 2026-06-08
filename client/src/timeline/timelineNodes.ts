import type { TimelineStoreApi } from './timelineStore'

/**
 * Per-node Timeline registry.
 *
 * Each `timeline` graph node owns its OWN store (created in the node's
 * `create()` via `createTimelineStore`). App reaches the PRIMARY timeline —
 * deterministic id `'timeline'`, the one the Mixer's Record button targets —
 * through `getTimeline('timeline')`, and drives all instances with
 * `forEachTimeline`. Clip sync (T4) hydration: pending clip data is applied
 * when the primary timeline registers (i.e., when the user first opens the panel).
 */

const timelines = new Map<string, TimelineStoreApi>()

// Set by App.tsx via setPendingTimelineClips when joining a room with clip state.
// Applied on registerTimeline for the primary timeline, then cleared.
type PendingClipEntry = {
  id: string; trackKey: string; trackName: string; trackKind: 'audio' | 'midi'
  trackColor?: string; startSec: number; durSec: number; label: string
  kind: 'audio' | 'midi'; proxy?: boolean
}
let pendingTimelineClips: Record<string, PendingClipEntry> | null = null

export function setPendingTimelineClips(clips: Record<string, PendingClipEntry> | null): void {
  pendingTimelineClips = clips
}

export function registerTimeline(nodeId: string, store: TimelineStoreApi): void {
  timelines.set(nodeId, store)
  if (nodeId === 'timeline' && pendingTimelineClips) {
    const tl = store.getState()
    for (const clip of Object.values(pendingTimelineClips)) {
      const trackId = tl.ensureTrack(clip.trackKey, { name: clip.trackName, kind: clip.trackKind, color: clip.trackColor })
      tl.addClipWithId({ id: clip.id, trackId, startSec: clip.startSec, durSec: clip.durSec, label: clip.label, kind: clip.kind, proxy: clip.proxy })
    }
    pendingTimelineClips = null
  }
}

export function unregisterTimeline(nodeId: string): void {
  timelines.delete(nodeId)
}

export function getTimeline(nodeId: string): TimelineStoreApi | undefined {
  return timelines.get(nodeId)
}

export function forEachTimeline(fn: (store: TimelineStoreApi, nodeId: string) => void): void {
  timelines.forEach(fn)
}
