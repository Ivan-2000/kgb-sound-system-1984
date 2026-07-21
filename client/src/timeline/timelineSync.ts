import { roomSyncClient } from '../networking/roomSyncClient'
import { timelineStore } from './timelineSingleton'
import { clipAudio } from '../audio/recorder'
import type { ClipAddEvent, ClipUpdateEvent, ClipRemoveEvent } from '../protocol/syncProtocol'
import type { ClipFileEvent } from '../networking/roomSyncClient'

export const SYNC_TIMELINE_ID = 'timeline'

// §5.5 LWW: highest server-assigned revision we've applied per clip. The server
// rev is monotonic per room, so this watermark is immune to client clock skew (§5.17).
const appliedRev = new Map<string, number>()
// §5.15: a clip:file can arrive before its clip_add (separate emits, unordered).
// Hold the blob until the clip exists so we neither leak nor drop it.
const pendingFiles = new Map<string, Blob>()

function isStale(clipId: string, rev: number | undefined): boolean {
  if (rev === undefined) return false
  return rev <= (appliedRev.get(clipId) ?? -1)
}

/** Monotonic watermark update — never moves backwards (guards async ack races). */
function markRev(clipId: string, rev: number | undefined): void {
  if (rev === undefined) return
  if (rev > (appliedRev.get(clipId) ?? -1)) appliedRev.set(clipId, rev)
}

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
  const clipId = params.clip.id
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_add',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, ...params },
  }).then((rev) => markRev(clipId, rev)).catch(() => { /* best-effort */ })
}

export function sendClipUpdate(
  clipId: string,
  patch: { startSec?: number; durSec?: number; label?: string; proxy?: boolean },
): void {
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_update',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, clipId, patch },
  }).then((rev) => markRev(clipId, rev)).catch(() => { /* best-effort */ })
}

export function sendClipRemove(clipId: string): void {
  appliedRev.delete(clipId)
  pendingFiles.delete(clipId)
  roomSyncClient.sendSyncEvent({
    ...eventBase(),
    type: 'clip_remove',
    payload: { timelineNodeId: SYNC_TIMELINE_ID, clipId },
  }).catch(() => { /* best-effort */ })
}

export function sendClipFile(clipId: string, blob: Blob): void {
  roomSyncClient.sendClipFile(clipId, blob).catch(() => { /* best-effort */ })
}

/** Seed LWW watermarks from a hydrated snapshot so late, in-flight events can't
 *  revert freshly-joined state (§5.5). Called by App.tsx on room hydration. */
export function hydrateClipRevs(clips: Array<{ id: string; rev?: number }>): void {
  for (const c of clips) markRev(c.id, c.rev)
}

/** §5.3/§5.15: apply any buffered clip:file whose clip now exists. Late joiners
 *  get clips via the snapshot (not applyClipAdd), so call this after hydration. */
export function flushPendingClipFiles(): void {
  if (pendingFiles.size === 0) return
  const tl = timelineStore.getState()
  for (const [clipId, blob] of pendingFiles) {
    if (tl.clips.some((c) => c.id === clipId)) {
      pendingFiles.delete(clipId)
      clipAudio.set(clipId, blob)
      timelineStore.getState().updateClip(clipId, { proxy: false })
    }
  }
}

// ── Receive handlers (called from App.tsx sync listener) ─────────────────────

export function applyClipAdd(event: ClipAddEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  const { trackKey, trackName, trackKind, trackColor, clip } = event.payload
  if (isStale(clip.id, event.rev)) return

  const tl = timelineStore.getState()
  const existing = tl.clips.find((c) => c.id === clip.id)
  if (existing) {
    // §5.5 dedup: a re-add of a known clip is an update, not a duplicate.
    tl.updateClip(clip.id, { startSec: clip.startSec, durSec: clip.durSec, label: clip.label, proxy: clip.proxy })
  } else {
    const trackId = tl.ensureTrack(trackKey, { name: trackName, kind: trackKind, color: trackColor })
    tl.addClipWithId({ ...clip, trackId })
  }
  markRev(clip.id, event.rev)

  // §5.15: flush a file that arrived before this clip existed.
  const pending = pendingFiles.get(clip.id)
  if (pending) {
    pendingFiles.delete(clip.id)
    clipAudio.set(clip.id, pending)
    timelineStore.getState().updateClip(clip.id, { proxy: false })
  }
}

export function applyClipUpdate(event: ClipUpdateEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  if (isStale(event.payload.clipId, event.rev)) return
  timelineStore.getState().updateClip(event.payload.clipId, event.payload.patch)
  markRev(event.payload.clipId, event.rev)
}

export function applyClipRemove(event: ClipRemoveEvent): void {
  if (event.payload.timelineNodeId !== SYNC_TIMELINE_ID) return
  appliedRev.delete(event.payload.clipId)
  pendingFiles.delete(event.payload.clipId)
  timelineStore.getState().removeClip(event.payload.clipId)
}

export function applyClipFile(event: ClipFileEvent): void {
  const blob = new Blob([event.data], { type: 'audio/wav' })
  const clip = timelineStore.getState().clips.find((c) => c.id === event.clipId)
  if (!clip) {
    // §5.15: don't set audio for a clip that doesn't exist yet — buffer it.
    pendingFiles.set(event.clipId, blob)
    return
  }
  clipAudio.set(event.clipId, blob)
  if (clip.proxy) timelineStore.getState().updateClip(event.clipId, { proxy: false })
}
