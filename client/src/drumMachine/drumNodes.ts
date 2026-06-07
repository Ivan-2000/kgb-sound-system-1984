import type { DrumMachine, DrumTrack } from './drumMachine'
import type { StepCount } from '../protocol/syncProtocol'

/**
 * Per-node Drum Machine plumbing.
 *
 * Each `drum-machine` graph node owns its OWN {@link DrumMachine} engine
 * (created in the node's `create()`). This module is the seam between those
 * per-node instances and the App/room layer:
 *
 *  - **registry** — maps `nodeId → DrumMachine` so App (transport, snapshot,
 *    incoming sync) can reach the right instance(s) without holding a global
 *    engine. `forEachDrum` drives ALL instances together on the project Play.
 *  - **room glue** — a single `emit` callback wired by App; the self-contained
 *    panel calls {@link emitDrumSync} after mutating its instance, and App turns
 *    the intent into a room sync event. Sync logic stays out of the component.
 *  - **editable observable** — host-gating (`disabled`) is room state; the panel
 *    subscribes so it re-renders when the local user's host status changes.
 *
 * NOTE (this stage): the singleton is still ON and the wire protocol is
 * unchanged (no `nodeId` field yet), so App routes every drum sync event to the
 * single instance. Per-node sync routing (a `nodeId` on the events) is the next
 * stage, just before flipping `singleton:false`.
 */

// ── instance registry ────────────────────────────────────────────────────────

const drums = new Map<string, DrumMachine>()

export function registerDrum(nodeId: string, dm: DrumMachine): void {
  drums.set(nodeId, dm)
}

export function unregisterDrum(nodeId: string): void {
  drums.delete(nodeId)
}

export function getDrum(nodeId: string): DrumMachine | undefined {
  return drums.get(nodeId)
}

/** Run a callback against every live drum instance (e.g. start/stop on Play). */
export function forEachDrum(fn: (dm: DrumMachine, nodeId: string) => void): void {
  drums.forEach(fn)
}

// ── room glue (sync emit) ─────────────────────────────────────────────────────

/** A drum edit intent, emitted by the panel for App to turn into a room event. */
export type DrumSyncCmd =
  | { type: 'step_toggle'; track: DrumTrack; step: number; value: boolean }
  | { type: 'velocity_change'; track: DrumTrack; step: number; velocity: number }
  | { type: 'pattern_switch'; patternIndex: number }
  | { type: 'step_count_change'; stepCount: StepCount }
  | { type: 'swing_change'; swing: number }
  | { type: 'chain_set'; chain: number[] | null }

type DrumRoom = { emit: (nodeId: string, cmd: DrumSyncCmd) => void }
let room: DrumRoom | null = null

/** App wires the room sync emitter (and detaches it on unmount). */
export function connectDrumRoom(r: DrumRoom): void {
  room = r
}

export function disconnectDrumRoom(): void {
  room = null
}

/** Panel → App: a local mutation already happened; broadcast it to the room. */
export function emitDrumSync(nodeId: string, cmd: DrumSyncCmd): void {
  room?.emit(nodeId, cmd)
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
