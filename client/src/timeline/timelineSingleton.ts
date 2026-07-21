import * as Tone from 'tone'
import { createTimelineStore } from './timelineStore'
import { scheduleMidiClips, clearMidiClipSchedule } from './midiPlayer'
import { scheduleAudioClips, clearAudioClipSchedule } from './audioClipPlayer'

/**
 * Singleton primary Timeline (id 'timeline'). Заменяет прежний
 * timelineNode.create(): один store на сессию, регистрируется сразу, чтобы
 * кнопка Record в миксере и гидрация клипов комнаты всегда его находили.
 * Транспорт start/stop планирует воспроизведение MIDI- и записанных
 * аудио-клипов (раньше это жило в ноде).
 *
 * Очистка дорожек/клипов при выходе из комнаты — через store.clear() в App
 * (синглтон не диспозится за всю сессию).
 */
export const timelineStore = createTimelineStore()

// §8.C.1: named handlers registered once. Under Vite HMR this module can re-run,
// which would stack a second pair of listeners on the (global) Transport and
// double-schedule clips on every start. Remove them on hot-dispose.
const onTransportStart = () => {
  scheduleMidiClips(timelineStore)
  scheduleAudioClips(timelineStore)
}
const onTransportStop = () => {
  clearAudioClipSchedule()
  clearMidiClipSchedule()
}
Tone.getTransport().on('start', onTransportStart)
Tone.getTransport().on('stop', onTransportStop)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    Tone.getTransport().off('start', onTransportStart)
    Tone.getTransport().off('stop', onTransportStop)
  })
}
