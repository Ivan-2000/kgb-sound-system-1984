import type { TimelineStoreApi } from './timelineStore'

/**
 * Per-node Timeline registry.
 *
 * Each `timeline` graph node owns its OWN store (created in the node's
 * `create()` via `createTimelineStore`). App reaches the PRIMARY timeline —
 * deterministic id `'timeline'`, the one the Mixer's Record button targets —
 * through `getTimeline('timeline')`, and drives all instances with
 * `forEachTimeline`. Timeline isn't room-synced yet, so there's no sync glue
 * here (unlike `drumNodes.ts`): just the instance registry.
 */

const timelines = new Map<string, TimelineStoreApi>()

export function registerTimeline(nodeId: string, store: TimelineStoreApi): void {
  timelines.set(nodeId, store)
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
