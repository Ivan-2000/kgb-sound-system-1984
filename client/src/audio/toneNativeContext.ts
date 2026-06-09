import * as Tone from 'tone'

/**
 * Tone.js v15 builds its default context on `standardized-audio-context`,
 * which hides the native AudioContext: `Tone.getContext().rawContext` is a
 * library wrapper, `instanceof AudioContext` is false, and `setSinkId` is
 * not exposed. The PortAudio output bridge needs the NATIVE context for
 * `audioWorklet.addModule` + `setSinkId({type:'none'})`.
 *
 * Fix: hand Tone a native AudioContext up front. `Tone.setContext(native)`
 * is a supported path — Tone wraps it as-is (`isAnyAudioContext` accepts
 * native contexts and `createAudioWorkletNode` branches on
 * `instanceof BaseAudioContext`), so every Tone node is then built on
 * native Web Audio nodes.
 *
 * MUST be imported before anything constructs Tone objects — main.tsx
 * imports this module first.
 */
// sampleRate matches the PortAudio stream (nativeAudioController opens at
// 48000) — the softmix bridge does no resampling, so the rates must agree.
export const nativeToneContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
Tone.setContext(nativeToneContext)
