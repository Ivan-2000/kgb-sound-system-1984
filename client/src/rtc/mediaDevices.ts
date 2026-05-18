// Music-mode audio constraints: no processing that degrades instrument sound.
// Video is requested separately to keep audio working even if camera fails.
const MUSIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

let localAudioStream: MediaStream | null = null
let localVideoStream: MediaStream | null = null

export async function requestAudioStream(): Promise<MediaStream> {
  if (localAudioStream) {
    return localAudioStream
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: MUSIC_AUDIO_CONSTRAINTS,
    video: false,
  })
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
