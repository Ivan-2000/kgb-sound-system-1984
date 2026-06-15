import type { DrumTrack } from './drumMachine'
import type { StepCount } from '../protocol/syncProtocol'

/**
 * Drum Machine room glue. The engine itself is the singleton in
 * `drumSingleton.ts` (imported directly). This module only carries the
 * App↔room seam:
 *
 *  - **room glue** — App wires an `emit` callback; the panel calls
 *    {@link emitDrumSync} after mutating the engine and App turns the intent
 *    into a room sync event. Sync logic stays out of the component.
 *  - **editable observable** — host-gating (`disabled`) is room state; the panel
 *    subscribes so it re-renders when host status changes.
 */

// ── room glue (sync emit) ─────────────────────────────────────────────────────

/** A drum edit intent, emitted by the panel for App to turn into a room event. */
export type DrumSyncCmd =
  | { type: 'step_toggle'; track: DrumTrack; step: number; value: boolean }
  | { type: 'velocity_change'; track: DrumTrack; step: number; velocity: number }
  | { type: 'pattern_switch'; patternIndex: number }
  | { type: 'step_count_change'; stepCount: StepCount }
  | { type: 'swing_change'; swing: number }
  | { type: 'chain_set'; chain: number[] | null }

type DrumRoom = { emit: (cmd: DrumSyncCmd) => void }
let room: DrumRoom | null = null

/** App wires the room sync emitter (and detaches it on unmount). */
export function connectDrumRoom(r: DrumRoom): void {
  room = r
}

export function disconnectDrumRoom(): void {
  room = null
}

/** Panel → App: a local mutation already happened; broadcast it to the room. */
export function emitDrumSync(cmd: DrumSyncCmd): void {
  room?.emit(cmd)
}

// ── editable observable (host-gating) ─────────────────────────────────────────

let editable = true
const editSubs = new Set<(v: boolean) => void>()

/** App sets this from room/host state; panels re-render when it changes. */
export function setDrumEditable(next: boolean): void {
  if (next === editable) return
  editable = next
  for (const l of editSubs) l(next)
}

export function subscribeDrumEditable(listener: (v: boolean) => void): () => void {
  editSubs.add(listener)
  listener(editable)
  return () => { editSubs.delete(listener) }
}
