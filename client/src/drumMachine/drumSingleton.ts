import { DrumMachine } from './drumMachine'

/**
 * Singleton Drum Machine (id 'drum-machine'). Заменяет прежний
 * drumMachineNode.create(): один движок на сессию, регистрируется сразу, чтобы
 * room-sync (pattern/swing/chain) и проектный транспорт находили его ещё до
 * открытия панели. Сэмплы грузятся лениво внутри DrumMachine (loadSamples).
 *
 * Конструктор не трогает AudioContext (players=null до первого play), поэтому
 * создание на импорте безопасно ещё до пользовательского жеста.
 */
export const drumMachine = new DrumMachine()
