// Music-mode audio constraints: no processing that degrades instrument sound.
// Video is requested separately to keep audio working even if camera fails.
export const MUSIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

const STORAGE_KEY_INPUT = 'kgb_webrtc_input_device'

// Preferred input device — persisted across sessions.
// Loaded from localStorage on module init; updated via setPreferredInputDevice().
let preferredInputDeviceId: string = (() => {
  try { return localStorage.getItem(STORAGE_KEY_INPUT) ?? '' } catch { return '' }
})()

export function setPreferredInputDevice(id: string): void {
  preferredInputDeviceId = id
  try {
    if (id) localStorage.setItem(STORAGE_KEY_INPUT, id)
    else localStorage.removeItem(STORAGE_KEY_INPUT)
  } catch { /* ignore */ }
}

export function getPreferredInputDevice(): string {
  return preferredInputDeviceId
}

let localAudioStream: MediaStream | null = null
let localVideoStream: MediaStream | null = null

/**
 * Request an audio-only MediaStream for WebRTC.
 *
 * Preferred input device (set in Settings) is passed as `{ ideal: deviceId }`
 * so the browser falls back to the system default gracefully if the preferred
 * device is unavailable (avoids "Requested device not found" crashes).
 *
 * If even the default fails, the error is rethrown with a descriptive message.
 */
export async function requestAudioStream(): Promise<MediaStream> {
  if (localAudioStream) return localAudioStream

  const constraints: MediaTrackConstraints = { ...MUSIC_AUDIO_CONSTRAINTS }
  if (preferredInputDeviceId) {
    // `ideal` — browser honours the preference but falls back to default if needed.
    // Never use `exact` here: it throws NotFoundError when the device is missing.
    constraints.deviceId = { ideal: preferredInputDeviceId }
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  } catch (err) {
    // Preferred device unavailable → retry with system default
    if (preferredInputDeviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: MUSIC_AUDIO_CONSTRAINTS,
          video: false,
        })
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new Error(`No audio input device found. Connect a microphone and try again. (${msg})`)
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`No audio input device found. Connect a microphone and try again. (${msg})`)
    }
  }

  localAudioStream = stream
  return stream
}

export async function requestVideoStream(): Promise<MediaStream> {
  if (localVideoStream) {
    return localVideoStream
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: true,
  })
  localVideoStream = stream
  return stream
}

export function stopAudioStream() {
  if (!localAudioStream) return
  for (const track of localAudioStream.getTracks()) {
    track.stop()
  }
  localAudioStream = null
}

export function stopVideoStream() {
  if (!localVideoStream) return
  for (const track of localVideoStream.getTracks()) {
    track.stop()
  }
  localVideoStream = null
}

export function getLocalAudioStream() {
  return localAudioStream
}

export function getLocalVideoStream() {
  return localVideoStream
}
