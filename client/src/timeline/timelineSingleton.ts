import * as Tone from 'tone'
import { createTimelineStore } from './timelineStore'
import { scheduleMidiClips } from './midiPlayer'
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

Tone.getTransport().on('start', () => {
  scheduleMidiClips(timelineStore)
  scheduleAudioClips(timelineStore)
})
Tone.getTransport().on('stop', () => {
  clearAudioClipSchedule()
})
