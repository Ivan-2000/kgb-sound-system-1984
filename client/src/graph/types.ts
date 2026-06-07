import type { ReactNode } from 'react'

/**
 * KGB Sound — node graph contract (G1).
 *
 * Every engine (mixer, metronome, drum machine, timeline, …) is a NODE.
 * A node declares typed ports and params, carries its own UI, and talks to the
 * rest of the system ONLY through {@link NodeContext}. Third parties author a
 * node as a JS/TS module exporting a {@link NodeDefinition} (see `defineNode`).
 *
 * Signal model:
 *  - `control` / `trigger` / `value` / `midi` ports carry runtime signals that
 *    flow LOCALLY through the {@link ControlBus} on each client.
 *  - `audio` ports are routing DECLARATIONS — the actual samples are mixed in
 *    the native PortAudio utility process, never through this JS graph (G5).
 *
 * Sync model: node existence, edges and params are SHARED per room; runtime
 * signals are not (each client runs its own copy of the graph). See memory
 * `ui-graph-first` for the full rationale.
 */

/** Kind of data a port carries. Determines connection compatibility and routing. */
export type PortKind =
  | 'audio'    // PCM stream — compiled to native routing, not routed in JS
  | 'control'  // sustained control value (e.g. a parameter stream)
  | 'trigger'  // momentary event (e.g. a metronome tick, a step hit)
  | 'value'    // a discrete value push (number/string/bool)
  | 'midi'     // MIDI message

export type PortDirection = 'in' | 'out'

export interface PortDef {
  /** Unique within the node, e.g. `'clock'`, `'audioOut'`, `'gain'`. */
  id: string
  label: string
  kind: PortKind
  direction: PortDirection
  /**
   * Whether more than one cable may attach.
   * Defaults: outputs allow many, inputs allow one.
   */
  multiple?: boolean
}

export type ParamType = 'number' | 'enum' | 'bool' | 'string'

export type ParamValue = number | string | boolean

export interface ParamDef {
  id: string
  label: string
  type: ParamType
  default: ParamValue
  min?: number
  max?: number
  step?: number
  /** For `type: 'enum'`. */
  options?: string[]
}

export interface NodeManifest {
  /** Stable unique type id, e.g. `'metronome'` or `'com.author.reverb'`. */
  type: string
  label: string
  icon: string
  description: string
  version: string
  author?: string
  ports: PortDef[]
  params: ParamDef[]
  /** Only one instance allowed per room (mixer, metronome, settings, …). */
  singleton?: boolean
  /**
   * Allow ПКМ → Дублировать to clone this node even though it's a `singleton`.
   * The singleton is the auto-created PRIMARY (deterministic id = type, opened
   * from the toolbar/`+`); duplicates are extra instances with fresh ids that
   * sync per-`nodeId`. Used by the Drum Machine: one primary kit per room, plus
   * independent copies to work on alternate versions.
   */
  duplicable?: boolean
  /**
   * Personal node — never synced to the room (e.g. Settings: audio-device
   * binding is local hardware). Its mutations skip the sync hook and it is not
   * part of room hydration.
   */
  local?: boolean
  /** Default panel/canvas placement when first created. */
  defaults?: {
    panelPos?: { x: number; y: number }
    canvasPos?: { x: number; y: number }
    size?: { w: number; h: number }
  }
}

/** Payload carried on a non-audio port. Authors narrow this in their handlers. */
export type SignalPayload = unknown

/**
 * Payload on `midi` ports — a single musical note. Carries data (not just a
 * "bang") so masks/filters can combine notes by pitch / time / velocity.
 *
 * A voice interprets `pitch`: melodic voices map it to a frequency; a drum kit
 * maps it to a sample (GM-style pitch→voice map). One note-currency means
 * transpose/filter/mask operate identically on melody and on drums.
 */
export interface NoteEvent {
  /** MIDI pitch, 0–127. */
  pitch: number
  /** Velocity, 0–127. */
  velocity: number
  /** Note length in beats (quarter notes). Omitted for bare one-shot hits. */
  durationBeats?: number
  /** Optional stable id (editor identity / dedup). */
  id?: string
}

/**
 * Forward declaration of the native audio routing handle, populated in G5.
 * Until then `NodeContext.audio` is `undefined` and audio edges are recorded
 * as topology only.
 */
export interface AudioRoutingHandle {
  connectOutput(portId: string, target: { nodeId: string; portId: string }): void
  disconnectOutput(portId: string, target: { nodeId: string; portId: string }): void
}

/**
 * The node's only interface to the outside world. A node knows nothing about
 * the network, React, or other nodes — just this object.
 */
export interface NodeContext {
  readonly nodeId: string

  /** Push a payload out of an output port to every connected input. Local-only. */
  emit(portId: string, payload: SignalPayload): void
  /** Listen on an input port. Returns an unsubscribe function. */
  onInput(portId: string, handler: (payload: SignalPayload) => void): () => void

  /** Read a param's current value (falls back to the manifest default). */
  getParam<T extends ParamValue = ParamValue>(paramId: string): T
  /** Write a param. Goes through the synced mutation funnel (shared per room). */
  setParam(paramId: string, value: ParamValue): void
  /** React to param changes (local or remote). Returns an unsubscribe function. */
  onParam(paramId: string, handler: (value: ParamValue) => void): () => void

  /** Native audio routing — `undefined` until G5. */
  readonly audio?: AudioRoutingHandle
}

/** A live, instantiated node. Created by {@link NodeDefinition.create}. */
export interface NodeInstance {
  /** The node's own UI, rendered inside a panel or a canvas node. */
  render(): ReactNode
  /** Tear down subscriptions, engine resources, etc. */
  dispose(): void
}

/** What a node module exports. Third-party plugins implement this. */
export interface NodeDefinition {
  manifest: NodeManifest
  create(ctx: NodeContext): NodeInstance
}

/** A directed connection between two ports on the graph. */
export interface Edge {
  id: string
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

/** Serializable per-node state held in the graph store (shared per room). */
export interface GraphNode {
  id: string
  type: string
  params: Record<string, ParamValue>
  /** Position in the Panels view. */
  panelPos: { x: number; y: number }
  /** Position in the Canvas view. */
  canvasPos: { x: number; y: number }
  /** Panel size (Panels view). */
  size: { w: number; h: number }
  zIndex: number
  isMinimized: boolean
}
