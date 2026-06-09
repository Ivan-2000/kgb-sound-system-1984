/**
 * portaudioWorklet.js
 *
 * AudioWorklet sink: captures the Tone.js master bus output (stereo → mono)
 * and forwards raw PCM frames to the renderer main thread via this.port.
 * The renderer passes them to window.nativeAudio.pushSoftmix(), which sends
 * the samples to the PortAudio output ring buffer in the utility process so
 * they play through the user's selected PortAudio output device.
 *
 * Node configuration:
 *   numberOfInputs:  1  — connected to Tone.js Destination.output (GainNode)
 *   numberOfOutputs: 0  — pure sink; no native Web Audio hardware output needed
 *
 * Silencing native Web Audio output is handled separately by the engine via
 * AudioContext.setSinkId({ type: 'none' }) after Tone.start() resolves.
 */
class PortAudioOutputCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._active = true
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false
    }
  }

  /**
   * @param {Float32Array[][]} inputs  [[L, R]] or [[L]] from Tone.js destination
   * @returns {boolean}  true = keep alive, false = remove from graph
   */
  process(inputs) {
    if (!this._active) return false

    const ch = inputs[0]
    if (!ch || ch.length === 0 || !ch[0] || ch[0].length === 0) return true

    const L = ch[0]                           // left channel (always present)
    const R = ch.length > 1 ? ch[1] : null   // right channel (may be absent)
    const n = L.length                        // always 128 samples per AudioWorklet quantum

    const mono = new Float32Array(n)
    if (R) {
      for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5
    } else {
      mono.set(L)
    }

    // Transfer the buffer (zero-copy) — the backing ArrayBuffer is detached here.
    this.port.postMessage({ samples: mono.buffer }, [mono.buffer])
    return true
  }
}

registerProcessor('portaudio-output-capture', PortAudioOutputCapture)
