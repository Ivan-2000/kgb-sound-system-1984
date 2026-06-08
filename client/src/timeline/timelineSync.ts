import { roomSyncClient } from '../networking/roomSyncClient'
import { getTimeline } from './timelineNodes'
import { clipAudio } from '../audio/recorder'
import type { ClipAddEvent, ClipUpdateEvent, ClipRemoveEvent } from '../protocol/syncProtocol'
import type { ClipFileEvent } from '../networking/roomSyncClient'

export const SYNC_TIMELINE_ID = 'timeline'

function eventBase() {
  return {
    timestamp: Date.now(),
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

export function sendClipAdd(params: {
  trackKey: string
  trackName: string
  trackKind: 'audio' | 'midi'
  trackColor?: string
  clip: { id: string; startSec: number; durSec: number; label: string; kind: 'audio' | 'midi'; proxy?: boolean }
}): void {
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_add',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, ...params },
  }).catch(() => { /* best-effort */ })
}

export function sendClipUpdate(
  clipId: string,
  patch: { startSec?: number; durSec?: number; label?: string; proxy?: boolean },
): void {
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_update',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, clipId, patch },
  }).catch(() => { /* best-effort */ })
}

export function sendClipRemove(clipId: string): void {
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_remove',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, clipId },
  }).catch(() => { /* best-effort */ })
}

export function sendClipFile(clipId: string, blob: Blob): void {
  roomSyncClient.sendClipFile(clipId, blob).catch(() => { /* best-effort */ })
}

// ── Receive handlers (called from App.tsx sync listener) ─────────────────────

export function applyClipAdd(event: ClipAddEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  const store = getTimeline(SYNC_TIMELINE_ID)
  if (!store) return
  const { trackKey, trackName, trackKind, trackColor, clip } = event.payload
  const tl = store.getState()
  const trackId = tl.ensureTrack(trackKey, { name: trackName, kind: trackKind, color: trackColor })
  tl.addClipWithId({ ...clip, trackId })
}

export function applyClipUpdate(event: ClipUpdateEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  const store = getTimeline(SYNC_TIMELINE_ID)
  store?.getState().updateClip(event.payload.clipId, event.payload.patch)
}

export function applyClipRemove(event: ClipRemoveEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  const store = getTimeline(SYNC_TIMELINE_ID)
  store?.getState().removeClip(event.payload.clipId)
}

export function applyClipFile(event: ClipFileEvent): void {
  const blob = new Blob([event.data], { type: 'audio/wav' })
  clipAudio.set(event.clipId, blob)
  const store = getTimeline(SYNC_TIMELINE_ID)
  if (!store) return
  const clip = store.getState().clips.find((c) => c.id === event.clipId)
  if (clip?.proxy) store.getState().updateClip(event.clipId, { proxy: false })
}

// ── Late-joiner hydration ─────────────────────────────────────────────────────

interface RemoteClipState {
  id: string
  trackKey: string
  trackName: string
  trackKind: 'audio' | 'midi'
  trackColor?: string
  startSec: number
  durSec: number
  label: string
  kind: 'audio' | 'midi'
  proxy?: boolean
}

export function hydrateTimelineClips(
  timelineClips: Record<string, Record<string, RemoteClipState>> | undefined,
): void {
  if (!timelineClips) return
  const perTimeline = timelineClips[SYNC_TIMELINE_ID]
  if (!perTimeline) return
  const store = getTimeline(SYNC_TIMELINE_ID)
  if (!store) return
  const tl = store.getState()
  for (const clip of Object.values(perTimeline)) {
    const trackId = tl.ensureTrack(clip.trackKey, {
      name: clip.trackName,
      kind: clip.trackKind,
      color: clip.trackColor,
    })
    tl.addClipWithId({ id: clip.id, trackId, startSec: clip.startSec, durSec: clip.durSec, label: clip.label, kind: clip.kind, proxy: clip.proxy })
  }
}
