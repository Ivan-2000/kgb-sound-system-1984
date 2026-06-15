# KGB Sound System 85 — Аудит кода и плана

> Жёсткий критический разбор. Все находки с `file:line`, severity и обоснованием.
> Документ **живой** — дополняется по мере разбора.
>
> Дата старта: 2026-06-14
> Метод: чтение авторитетных доков (TASKS.md, CLAUDE.md) + полное чтение `addon.cc` + 3 параллельных глубоких ревью (сервер, нативный JS/IPC, тайминг/запись/синк) + точечная верификация утверждений в коде.
>
> **Сессия 2 (2026-06-14):** два дополнительных аудита по 4 параллельных агента каждый.
> (а) **Корректность** ранее не покрытых зон (App.tsx целиком, panels, singletons, drum/piano/mixer-логика, RTC-видео, компоненты) + добор по ядру и сети → §8.
> (б) **Производительность и ресурсы** (RT-поток/CPU ядра, сеть/трафик/масштаб, React-рендер, память/аллокации/алгоритмы) → §9.
> Нетривиальные утверждения сверены с доками: node-addon-api ThreadSafeFunction, PortAudio start/stop/abort, RFC 6716 / Opus Recommended Settings (Xiph), MDN Transferable objects, electron MessagePortMain, Tone.js issue-tracker, WebRTC perfect-negotiation / mesh-vs-SFU.

## Порядок исправления

Фиксы по этому документу делаются **Волной 2** — ПОСЛЕ упрощения кода (см. `REFACTOR_PLAN.md`, удаление графа). Сначала вырезаем лишнее, потом латаем дыры по упрощённой кодовой базе. Находки §3.1/§3.4, относящиеся к `graph_*`, закроются уже в Волне 1 удалением графа; остальное (ядро §1/§2/§4, запись/синк §5, clip/step §3) — Волна 2.

## Статус разбора (что покрыто / что нет)

**Покрыто:**
- C++ аддон `addon.cc` (полностью прочитан)
- Сервер: `index.js`, `roomManager.js`, `registerSocketHandlers.js`, `schemas.js`
- Нативный JS/IPC: `utilityHost.mjs`, `ipc.js`, `preload.js`, `nativeAudioController.ts`, `nativeRtcManager.ts`, `main.js`
- Тайминг/запись/синк: `recorder.ts`, `audioEngine.ts`, `metronome.ts`, `timelineStore.ts`, `timelineSync.ts`, `midiPlayer.ts`, `audioClipPlayer.ts`, `syncProtocol.ts`, `roomSyncClient.ts`
- Документация vs код (сверка заявлений)
- Репо-гигиена

**Покрыто в сессии 2 (см. §8–§9):**
- Граф / canvas — **удалены рефактором** (файлов нет в дереве; остались только комментарии-призраки, §8.C)
- Panels: `panels/` (FloatingPanel, PanelsView, panelStore) ✔
- Singletons: `timelineSingleton.ts`, `drumSingleton.ts` ✔
- Drum machine логика: `drumMachine.ts`, `drumNodes.ts`, `DrumMachineContainer.tsx`, `DrumMachinePanel.tsx` ✔
- Piano Roll: `PianoRollPanel.tsx`, `pianoRollStore.ts` ✔ (`pianoRollNode`/`pianoTransport` — удалены)
- Timeline UI: `TimelinePanel.tsx` целиком ✔ (`timelineNode`/`timelineNodes` — удалены)
- Mixer engine: `mixerEngine.ts`, `MixerStrip/MixerChannel/LocalMixerStrip/RemoteChannelStrip/Knob` ✔
- RTC видео: `peerManager.ts`, `mediaDevices.ts`, `VideoTile.tsx` ✔
- Export: `exportClip.ts` ✔
- `App.tsx` целиком (1937 строк) ✔
- `ChatPanel.tsx` ✔; `toneNativeContext.ts` ✔; `audioEngine.ts`/`nativeAudioController.ts` (перф-добор) ✔
- **Производительность по всем зонам** (RT/CPU, трафик/масштаб, рендер, память) — §9

**НЕ покрыто (TODO для продолжения):**
- [ ] `SettingsModal.tsx`, `DeviceSetupModal.tsx` — глубоко не разобраны (затронуты косвенно: softmixPeak-диагностика §8.A.6)
- [ ] Сборка/упаковка: `vite.config.ts`, `electron-builder`, `afterPack.mjs`, CMakeLists, submodules
- [ ] `recorder.ts` ↔ `exportClip.ts` ↔ mixdown тракт (Phase 3 экспорт) — частично (§8.D.note, §9.D.1)
- [ ] Тесты — подтверждено: тестовых файлов/раннеров в дереве нет (§7.3)

---

## ВЕРДИКТ (резюме)

1. **Документация завышает готовность.** Phase 1 «~98%, A1–A6 валидировано end-to-end», но главный acceptance-критерий фазы — «гитара через ASIO собеседнику без артефактов» — стоит `[ ]` и недостижим на текущей архитектуре (нерешённые clock drift и single-thread opus). «Валидировано» = 1–2 пира локально + краш-тест, не реальный acceptance.
2. **Сервер открыт.** «room events host-gated» (CLAUDE.md) — ложь: захостгейчены только 9 транспортных событий. Граф, таймлайн-клипы, шаги драм-машины правит/удаляет любой участник. `clip:file` без лимита размера и rate-limit. Утечка комнат.
3. **Три фундаментальные дыры в ядре аудио** (§1) — блокеры, не баги.
4. **(сессия 2) Эффективность рассчитана на 1–2 пира и короткие сессии.** На 8 участниках упирается в single-thread Opus encode (§9.A.3) и upload-mesh (§9.B.1) — mesh-топология объективно за пределом зоны (надёжна до ~4). На длинной сессии течёт память записи/клипов до 0.5–1 ГБ (§9.D.1–9.D.2). UI жжёт CPU вхолостую: ~55 ре-рендеров монолитного App/с при playback + негейтированные RAF (§9.C). Звук при этом НЕ заикается от UI-нагрузки (audio-clock независим от React) — код вычислительно-дисциплинирован там, где это критично (lock-free RT-кольца). Проблемы не «фатальны на 2 пирах», но все три (CPU-масштаб, память, холостой рендер) проявятся ровно в заявленном «8 музыкантов, час репетиции».
5. **(сессия 2) Две тихие порчи данных** — без ошибок, незаметны: запись с захардкоженным 48k SR вместо реального (§8.A.1) и потеря MIDI-нот при гидрации снапшота у опоздавших (§8.C.2).

---

## §1. Архитектурные дыры (фундаментальные — блокеры)

### 1.1 — CRITICAL — Два независимых аудио-клока сведены без синхронизации
Метроном/драм/таймлайн играют через Tone.js / Web Audio → мостятся в PortAudio через «softmix»-кольцо `g_softmixBuf` (`addon.cc:175`). Это отдельный clock-domain (AudioContext) от PortAudio (драйвер). Кольцо дренится `take = min(avail, frames)` без ресэмплинга и drift-компенсации (`addon.cc:463-478`). Через минуты клоки разъедутся → метроном уплывёт относительно записываемой гитары. Latency-компенсация это не лечит (вычитает константу, drift растёт линейно).

### 1.2 — CRITICAL — «Никакого Web Audio в финальной архитектуре» — неправда
Tone.js/Web Audio в критическом пути всех инструментов (softmix ссылается в `App.tsx`, `audioEngine.ts`, `toneNativeContext.ts`, `SettingsModal.tsx`, `nativeAudioController.ts`). Нативным остался только тракт «вход устройства → opus → сеть» + мониторинг. Всё, что генерит клиент — на Web Audio и страдает от §1.1.

### 1.3 — CRITICAL — Нет сетевой синхронизации/drift-компенсации на приёме
Декодированный PCM пишется в `PeerRing` и сразу читается RT-callback (`addon.cc:316-367`, `428-458`). Нет playout-буфера с целевой задержкой, нет компенсации расхождения ADC-клока отправителя и DAC-клока получателя. Кольцо либо медленно переполняется (растущая задержка + дропы), либо опустошается (underrun → щелчки). NTP/drift correction стоят `[ ]` в Phase 4, но без них «без артефактов» недостижимо.

### 1.4 — HIGH — Жёсткая привязка к 48 кГц, необъявленная
`nativeAudioController` хардкодит `sampleRate = 48000` (`nativeAudioController.ts:44`), никогда не читает `device.defaultSampleRate`. Аддон валидирует opus-фрейм только под 48k (120/240/480/960/1920/2880, `addon.cc:806-808`). Устройство на 44.1 кГц → отказ `Pa_OpenStream` или принудительный ресэмплинг драйвером. Декодер хардкодит 48000 (`addon.cc:301`). Opus-опции хардкодятся (`nativeAudioController.ts:293,388`: bitrate 96000, frameMs 20).

### 1.5 — HIGH — Opus encode И decode на одном JS-потоке utility
Кодирование — TSFN-лямбда на JS-thread (`addon.cc:554-585`), декодирование (`PushInboundOpus` → `decodeAndFlush`) — тоже JS-thread (`addon.cc:1071`), плюс весь IPC. При 8 участниках × N каналов один поток не вытянет → дропы. Сам код помечает «known follow-up», но roadmap считает A4 закрытым. Acceptance был на 1–2 пирах.

---

## §2. C++ аддон / RT-поток

### 2.1 — HIGH — Reinit портит состояние нового Opus-энкодера устаревшим PCM
На синхронном `closeStream → openStream` (один тик, лямбды TSFN не дренировались) `cleanupOpusState()` зануляет `enc`, но новый `openStream` кладёт новые энкодеры в те же `g_opusCh[ch].enc` (`addon.cc:824`). Старая отложенная лямбда, сработав после, прочитает новый ненулевой `enc` и закодирует в него старый PCM (`addon.cc:564-568`). Opus-энкодер stateful → состояние повредится. Комментарий `addon.cc:842-849` рассуждает только о счётчике fill, не о переиспользовании указателя.

### 2.2 — MEDIUM — Хард-клиппинг вместо лимитера
Финальный микс жёстко обрезается в [-1,1] (`addon.cc:483-489`). При нескольких активных пирах — слышимое искажение, не защита. Регресс качества против «без артефактов».

### 2.3 — MEDIUM — `crashMe` → `std::abort()` скомпилирован в продакшн
`addon.cc:654-656`. Комментарий «never in production», но оно там. Кто дотянется до `openStream` — роняет utility.

### 2.4 — LOW/MEDIUM — malloc/new в RT-callback на каждом блоке
PCM-копия `addon.cc:497-500`, Opus-job `addon.cc:544-547`. Код признаёт. Для ASIO ≤64 сэмплов — реальный источник джиттера/xrun. «A3 limitation», но в roadmap отмечено выполненным.

**Сделано хорошо (для баланса):** `std::atomic` release/acquire расставлены аккуратно; SPSC-кольца корректны; eviction в jitter учитывает wrap (signed distance, `addon.cc:358-366`). Проблема не в memory-ordering, а в архитектуре уровнем выше (§1).

---

## §3. Сигнальный сервер (безопасность)

### 3.1 — CRITICAL — Host-gating фиктивен
Захостгейчены только `transport_*`, `bpm_change`, drum-control (`registerSocketHandlers.js:171`). НЕ захостгейчены: `graph_node_remove` (любой `delete g.nodes[nodeId]`, `roomManager.js:333`), `graph_*`, `clip_add/update/remove`, `step_toggle`, `velocity_change`. Любой гость стирает чужой таймлайн и весь граф. CLAUDE.md «room events host-gated» — ложно за пределами 9 событий. (`roomManager.js:325` комментирует это как «LWW, collaborative» — но тогда нужен настоящий LWW, см. §5.5.)

### 3.2 — CRITICAL — `clip:file` без лимита размера и без rate-limit
`registerSocketHandlers.js:189-206`: валидируется только `clipId` + `Buffer.isBuffer`, размер не ограничен, `rateLimiter.consume` не вызывается. `clipFileMetaSchema` не ограничивает `data`. Амплификация 1→N. Без throttle также: `chat_message`, `rtc:signal`, `room:create`, `room:join*`, `participant:rtt`.
> **✅ Волна 2 (Батч 1, 2026-06-14):** `clip:file` теперь rate-limited + cap `MAX_CLIP_BYTES=16 МБ`; `maxHttpBufferSize=16 МБ` в `index.js`. Throttle добавлен на `room:create`/`room:join`/`room:join-by-code`/`chat_message`. **Остаётся:** `rtc:signal` (намеренно — корректность сигналинга важнее throttle) и `participant:rtt` (низкочастотный) не троттлятся.

### 3.3 — CRITICAL/HIGH — Утечка комнат при повторном `room:create`
`createRoom` безусловно перезатирает `socketToRoom`; `leaveRoom` чистит только последнюю комнату. Каждый повторный create оставляет осиротевшую комнату навсегда — нет TTL, нет reaper.
> **✅ Волна 2 (Батч 1):** `createRoom` теперь зовёт `leaveRoom(hostSocketId)` если сокет уже в комнате (реассайн хоста / удаление пустой). Проверено функциональным тестом. (Глобального TTL/reaper по-прежнему нет — но осиротевших комнат больше не возникает.)

### 3.4 — HIGH — Неограниченный рост состояния (DoS памяти)
~~`graph_node_add`~~ (граф удалён), ~~`paramValueSchema` z.string() без .max()~~ (удалён с графом), ~~`getDrumStateFor` плодил драм-киты~~ (1.5b: единый `s.drum`). **✅ Волна 2 (Батч 1):** `clip_add` теперь капится `MAX_CLIPS_PER_TIMELINE=1000` (проверено тестом). **Остаётся:** полный re-serialize снапшота на каждый join (приемлемо при capped-state).

### 3.5 — HIGH — Пароль в открытом виде + слабая проверка
`roomManager.js`: сравнение `!==` (не constant-time), пароль хранится вербатим. Short-circuit для уже-участника. `host_mute` — honor-system флаг, аудио идёт P2P, злонамеренный пир игнорирует; `toggleMuted` переключает, а не ставит → хост может случайно размьютить.
> **✅ Волна 2 (Батч 1):** сравнение пароля теперь constant-time (`timingSafeEqual` через `passwordMatches()`); проверено тестом. **Принято как есть:** хранение в открытом виде в памяти — комнаты эфемерны (не персистятся, не хешируются). **Остаётся (отдельно):** `host_mute` как honor-system флаг (архитектурно P2P) и `toggleMuted`-вместо-set.

### 3.6 — MEDIUM — Прочее
`cors.origin:'*'`, нет auth на коннект. Короткий код 32⁴≈1.05M, `randomBytes` (не предсказуем), но энумерируем без rate-limit на `room:join-by-code`. Rate-limiter обходится реконнектом (`clear` на disconnect). `rtc:signal` релеит `z.unknown()` — произвольный JSON в simple-peer получателя.
> **✅ Волна 2 (Батч 1):** `room:join-by-code` теперь rate-limited (брутфорс-энумерация замедлена). **Остаётся (приемлемо/отдельно):** `cors:'*'` (десктоп-модель, изоляция комнат + rate-limit), reconnect-bypass лимитера, `rtc:signal` z.unknown (валидация SDP/ICE — отдельная задача).

### 3.7 — LOW — `chat_message` — blind relay, потенциальный stored XSS если клиент рендерит через innerHTML (`registerSocketHandlers.js:246-272`); username без ограничения символов (`schemas.js:3-7`).

**Сверка claims CLAUDE.md по серверу:**
- «Zod на каждом handler» — TRUE кроме `clip:file` (только Buffer-check, без размера).
- «Room events host-gated» — FALSE (только 9 типов).
- «Rate limiting» — PARTIAL (2 из ~12 handlers; обходится реконнектом).
- «Password-protected rooms» — TRUE, но слабо (plaintext, не constant-time).
- «Host-set participant limits» — TRUE (clamp 2–8, `schemas.js:16`).
- «Room isolation» — в основном TRUE; подрывается энумерацией кодов.

---

## §4. Нативный JS/IPC-слой

### 4.1 — HIGH — «Лексикографический tie-break инициатора оффера» (A5) в коде отсутствует
`nativeRtcManager.ts:99-150`: `initiator` берётся от вызывающего, нет polite-peer/rollback. Glare → `InvalidStateError`, проглатывается (`:177`), соединение не встаёт.

### 4.2 — HIGH — Входящий Opus пушится в аддон с channelId под контролем удалённого пира, без валидации
`nativeRtcManager.ts:296-299` → `utilityHost.mjs:97-134` → addon. До 256 channelIndex на пира, нет проверок `sequence`/размера/finite до перехода в C++. `encodePacket` (`nativeRtcManager.ts:39-50`): `setUint8(channelIndex)` молча маскирует >255; `sequence` wraparound не охраняется.

### 4.3 — HIGH — Нет таймаута на `sendRequest`
Pending-промис реджектится только при `exit` utility (`ipc.js:52-69`). Зависший ASIO-драйвер / потерянный reply → `controller.openStream()` (`nativeAudioController.ts:302`) висит вечно. Нет `setTimeout`-реджекта нигде.

### 4.4 — MEDIUM — `streamId` пробрасывается end-to-end и нигде не проверяется
`utilityHost.mjs:90,184`, `main.js:216` — поздний PCM-кадр от старого стрима обрабатывается как принадлежащий новому после reinit. Механизм мёртв (PCM-handler `nativeAudioController.ts:74` игнорирует `msg.streamId`).

### 4.5 — MEDIUM — Уборка пира только на `failed`/`closed`; `disconnected` течёт
`nativeRtcManager.ts:134-139`. RTCPeerConnection + ping-таймер живут вечно. Reinit-гонка закрытия портов может снести только что открытый стрим: старый `port1.on('close')` зовёт `a.closeStream()` для нового стрима (`utilityHost.mjs:143-150`).

### 4.6 — MEDIUM — id-реюз / гонки respawn
`ipc.js:28,77`: `reqId` глобально-монотонный, но message-handler не проверяет `if (utility !== u)` (exit-handler проверяет, `:53`). Поздний reply от умирающего инстанса с совпавшим id может зарезолвить чужой промис. Двойной spawn при quit возможен (`ipc.js:113-133`).

### 4.7 — MEDIUM — Стейл-порт у renderer
Если utility крашится между resolve `openStream` и `postMessage('audio:port', [port2])` (`ipc.js`/`main.js:216`), renderer получает живой `port2` к мёртвому `port1`; контроллер ставит `streamActive=true` (`nativeAudioController.ts:315`). Stale stream без сигнала восстановления (если OS-exit не успел дать engine-crashed). Гонка openStream-success ↔ crash-handler без упорядочивания.

### 4.8 — LOW — `sandbox:false`
`main.js:21`. `contextIsolation:true` + `nodeIntegration:false` изолируют renderer; экспонированный API фиксирован (без произвольного invoke). Но через порт идут поля под контролем удалённого пира (4.2) → больший blast radius. Предпочесть `sandbox:true` с sandbox-совместимым preload.

### 4.9 — LOW — `pushInboundOpus` непоследовательный возврат (boolean vs Promise), fallback через ipc без await → возможен unhandled rejection (`preload.js:130-141`); провал fast-path молча проглатывается.

---

## §5. Тайминг, запись, синк

### 5.1 — CRITICAL — Latency-компенсация делает неверную арифметику и противоречит доку
TASKS.md T5 обещает сдвиг на `inputLatencyMs/1000`; код вычитает input+output (`App.tsx:311`). Output-задержка не сдвигает записанные сэмплы. Систематический сдвиг всех записей вперёд на величину выходного тракта. Значения — номинальные оценки `Pa_GetStreamInfo` (`nativeAudioController.ts:321-322,414-415`), не измеренный round-trip.

### 5.2 — CRITICAL — Локальная (бессмысленная для удалёнки) компенсация транслируется пирам
`App.tsx:319-320` → `timelineSync.ts:65-69` `applyClipUpdate` → `updateClip`. Прокси-клип у других сдвигается на железную задержку автора. Плюс `Math.max(0, …)` (`App.tsx:314`) обнуляет компенсацию для записи у t=0 (частый кейс) → позиционно-зависимый сдвиг.

### 5.3 — CRITICAL — Опоздавшие участники НИКОГДА не получают записанное аудио
Метаданные гидратируются из снапшота, но WAV (`clip:file`) релеится только live и не хранится на сервере (`registerSocketHandlers.js:187`). Поздний участник видит клип `proxy:false` и слышит тишину (`audioClipPlayer.ts:38` `if (!blob) continue`).

### 5.4 — CRITICAL — setState/store-write внутри Tone.js-колбэка (нарушение CLAUDE.md)
`metronome.ts:79-91`: `scheduleRepeat` → `emitChange()` → React-`setState` на каждую долю. Прямое нарушение non-negotiable.

### 5.5 — CRITICAL — У клипов таймлайна нет LWW/дедупа
«patterns sync via LWW» верно только для шагов драм-машины (`App.tsx:565-567`, `stepLwwRef`). Клипы: `clip_update` → `Object.assign` без сравнения timestamp; `eventId` (`eventBase()`) генерится, но нигде не проверяется. Двое тянут клип → расхождение по порядку прихода пакетов. Сервер `applySyncEvent` тоже без timestamp-сравнения (`roomManager.js:380-384`).

### 5.6 — HIGH — Клип-события не захостгейчены (см. §3.1) — любой участник `clip_remove` чужой клип; в связке с §5.5 — свободный стомпинг таймлайна.

### 5.7 — HIGH — Запись не выровнена к позиции 0 транспорта
`audioEngine.play({position:0})` ожидается, потом `recorder.start()` (`App.tsx:1289→1301`). Кадр 0 рекордера = более поздний момент, чем считанный `startSec` (`App.tsx:1244`). Зазор JS-планировщика не измеряется и не компенсируется.

### 5.8 — HIGH — Смена BPM во время записи отрывает аудио от тактов
`durSec = framesSeen/sampleRate` (`recorder.ts:97-98`) — секунды; сетка музыкальная. Mid-record `rampTo` (host) → клип не лежит на барах. Гарды нет.

### 5.9 — HIGH — Отмена преролла не отменяет уже запланированные на аудио-клоке клики
`metronome.ts:97-164`: преролл планируется на `Tone.now()` (аудио-клок), резолв/отмена на `setTimeout` (wall-clock). `clearPreroll` чистит таймауты, но не `triggerAttackRelease` → отменённый преролл доигрывает клики. Фадж +20мс (`:135`). Стыковка преролл→запись (`App.tsx:741-746`) wall-clock-неточная.

### 5.10 — HIGH — Расхождение BPM/частоты компенсации зависит от позиции
(см. §5.2 — `Math.max(0,…)`): клип у t=0 получает 0 компенсации, клип у 10с — полную. Клипы дрейфуют друг относительно друга.

### 5.11 — MEDIUM — Live-waveform пишет store каждые 150мс с растущим массивом peaks
`App.tsx:271-285` `updateClip(... peaks)` 7×/сек → полный ре-рендер списка клипов. Чтение через ref (ок), запись усиливается в React по таймеру.

### 5.12 — MEDIUM — Гонка двух путей Stop
Транспорт-Stop (`finishRecording` → `recorder.stop`, `App.tsx:727→731`) vs effect закрытия стрима (`recorder.stopAll`, `App.tsx:328-336`). Кто первым — определяет, финализируется запись или молча теряется.

### 5.13 — MEDIUM — Double-record/re-arm молча теряет аудио
`recorder.ts:39`: `if (active.has(idx)) this.stop(idx)` — возврат `stop()` выбрасывается; первая запись осиротевает.

### 5.14 — MEDIUM — Утечки памяти на запись
`clipAudio` (Blob, `recorder.ts:31`) и `bufferCache` (декодированные буферы, `audioClipPlayer.ts:22`) — module-level Map, не чистятся при удалении клипа. `rec.chunks.push(new Float32Array)` (`recorder.ts:101`) копит весь PCM без потоковой записи на диск.

### 5.15 — HIGH — Гонки proxy→real свапа и порядка clip-событий
`applyClipFile` (`timelineSync.ts:77-84`) всегда `clipAudio.set(...)` (leak если клип не существует), флипает proxy только если найден. `clip:file` до `clip_add` (отдельные emit, нет упорядочивания) → proxy не снимется, клип застрянет placeholder. `sendClipAdd`/`sendClipUpdate`/`sendClipFile` — 3 best-effort emit с `.catch(()=>{})` (`App.tsx:1305-1312`); потеря `clip_add` → последующие no-op + leak.

### 5.16 — MEDIUM — Beat-индекс метронома неверен при смене BPM
`metronome.ts:83-85`: `beatSec` из live BPM, `posSec` накоплен под старым BPM во время `rampTo(bpm,0.03)`. Деление → неверный `beat` при/после смены темпа.

### 5.17 — MEDIUM/LOW — Clock-skew в LWW
`timelineSync.ts:11-13`: `eventId` = `Date.now()`+`Math.random()`. Где LWW есть (шаги, `App.tsx:566` `>=`), клиент с быстрыми часами всегда выигрывает, с медленными — навсегда теряет апдейты. Нет серверного упорядочивания.

### 5.18 — LOW — MIDI vs аудио расходятся при смене BPM на воспроизведении
`midiPlayer.ts:35` `sixteenthSec=60/(bpm*4)` (музыкальное время, рефлоу с темпом) vs аудио-клипы на фикс `startSec` (секунды). Выровненное на записи — расходится на playback в другом темпе.

### 5.19 — MEDIUM — React `setState-in-render` между TimelinePanel и PianoRollPanel
Наблюдалось в рантайме 2026-06-14: при открытом пиано-ролл-редакторе поверх таймлайна консоль спамит `Cannot update a component (TimelinePanel) while rendering a different component (PianoRollPanel)`. PianoRollPanel во время рендера дёргает setState в TimelinePanel. Пред-существующий баг (не связан с удалением графа/уборкой). `pianoRoll/` ранее не аудировался — это первая зафиксированная находка по нему.

---

## §6. Расхождения «документация vs код» (ложные «готово/валидировано»)

| Заявлено в TASKS.md/CLAUDE.md | Реальность | Где |
|---|---|---|
| Phase 1 «~98%, A1–A6 валидировано end-to-end» | Главный acceptance `[ ]`; clock drift/single-thread не решены | §1 |
| «room events host-gated» | Только 9 событий; граф/клипы/шаги открыты всем | §3.1 |
| «Zod на каждом событии» | `clip:file` — только Buffer-check, без размера | §3.2 |
| A5 «лексикографический tie-break инициатора» | В коде отсутствует | §4.1 |
| T5 «сдвиг на inputLatencyMs/1000» | Вычитает input+output, транслируется пирам | §5.1–5.2 |
| «patterns sync via LWW» | Только шаги; клипы без LWW | §5.5 |
| «no setState in Tone.js callbacks» | Нарушено метрономом | §5.4 |
| «финальная архитектура без Web Audio» | Web Audio в критическом пути через softmix | §1.2 |
| «Аудио попадает на таймлайн без сдвига» | Неверно для опоздавших (тишина), у t=0, при смене BPM | §5.2,5.3,5.8 |
| JSDoc `softmixPeak` «read-and-reset» | Реализован как decaying-без-reset | §8.A.6 |
| Запись на SR устройства | WAV-заголовок хардкодит 48000; реальный `result.sampleRate` теряется | §8.A.1 |
| «MIDI-ноты синкаются» (подразумевается) | `clip_add` payload и гидрация снапшота `notes` не переносят | §8.C.2 |
| Phase 1 «8 музыкантов через интернет» | Mesh не масштабируется >4–5; single-thread encode + upload-потолок | §9.B.1, §9.A.3 |

Прогресс-проценты системно завышены: фазы «готово» по числу закрытых подпунктов, игнорируя невыполненные верхнеуровневые acceptance, упирающиеся в нерешённые архитектурные проблемы.

---

## §7. Репо-гигиена

### 7.1 — HIGH — Полная вторая копия репозитория внутри рабочего дерева
`kgb-sound-system-1984/` — со своим `.git`, `.gitmodules`, 1944 файлами, untracked. Вложенный git-репо: риск случайного коммита, путаницы «в какой копии правлю», расхождения сабмодулей. Плюс untracked `123` и `client/electron/nativeAudio/test-addon.cjs`. Разрешить осознанно (вынести/удалить).

### 7.2 — LOW — Память противоречит планам
Memory `ui-graph-first` («node graph — фундамент, supersedes C4–C9») конфликтует с пивотом TASKS.md 2026-06-06 «panels-first, кабели заморожены». Одна запись устарела.

### 7.3 — (наблюдение) Похоже, тестов нет вообще
Не найдено тестовых файлов/раннеров в дереве. Для проекта с RT-аудио, конкурентностью и сетевым синком это само по себе риск. — Подтвердить при дальнейшем разборе.

---

## §8. Второй проход — новые находки корректности (сессия 2, 2026-06-14)

> Зоны ранее не покрытые (App.tsx, panels, singletons, drum/piano/mixer-логика, RTC-видео, компоненты) + добор по ядру и сети. Находки, дублирующие §1–§7, помечены «(= §X)» — приводится только новое/уточнение. Часть находок агенты сами понизили после перепроверки (помечено).

### 8.A — Ядро аудио (добор к §1–§2)

**8.A.1 — HIGH — WAV пишется с захардкоженным SR, а не реальным SR стрима.** `recorder.ts:58,62` берёт `sampleRate` из `nativeAudioController.getSnapshot()` (= запрошенный хардкод 48000, `nativeAudioController.ts:44`), а не из `result.sampleRate`, который вернул `Pa_GetStreamInfo` при открытии. Контроллер реальный SR вообще не сохраняет (`nativeAudioController.ts:314-322` пишет latency, SR — нет). На любом не-48k устройстве (44.1k + WASAPI-shared / ASIO навязал свой SR) PCM приходит на одном SR, WAV-заголовок пишет 48000 → **все записи воспроизводятся с неверным питчем/длиной, без ошибки**. Тихая порча данных. Уточняет §1.4 (там только про хардкод запроса; здесь — что и фактический SR теряется). Фикс: сохранять `result.sampleRate`, отдавать в снапшоте, recorder использует его.

**8.A.2 — HIGH — Opus bitrate 96000 на МОНО-энкодере, захардкожен в 2 местах.** `nativeAudioController.ts:293,388`. Энкодер моно (`addon.cc:824`), 96 kbps для одного моно-инструмента — в 3–4× выше точки насыщения качества Opus; libopus примет, но раздувает трафик без выигрыша (см. §9.B.2) и быстрее упирается в single-thread encode (§1.5). DRY-нарушение: дубль константы рассинхронизируется при правке. Фикс: одна константа opus-опций, mono 24–48 kbps, проброс из настроек.

**8.A.3 — MEDIUM — CloseStream использует блокирующий `Pa_StopStream`; зависший ASIO заморозит utility.** `addon.cc:923` зовёт `Pa_StopStream` (по докам PortAudio ждёт дослития буферов, может блокировать на глючном ASIO) перед `Pa_CloseStream`. Dispatcher utility синхронный (`utilityHost.mjs`), зависший Stop замораживает обработку всех IPC-сообщений (включая shutdown). В связке с §4.3 (нет таймаута `sendRequest`) обходит изоляцию utilityProcess через синхронный dispatcher. Источник: PortAudio docs (Pa_AbortStream — немедленная остановка). Фикс: `Pa_AbortStream` в пути закрытия, либо Stop под watchdog с фолбэком на Abort.

**8.A.4 — MEDIUM — `channelIndex` по проводу — Uint8 (0–255), нет валидации против MAX_INPUT_CH=64 / 32 peer-слотов.** `nativeRtcManager.ts:43` `setUint8`; приём `decodePacket` → `channelId = String(0..255)` → `findOrCreatePeer` занимает слот из 32 (`addon.cc`). Битый/злонамеренный пир, разбрасывая `channelIndex` 0..255, исчерпает 32 слота мусорными декодерами и заблокирует легитимные. Уточняет §4.2. Фикс: валидация диапазона на отправке + кламп/reject на приёме до `pushInboundOpus`.

**8.A.5 — MEDIUM — Tone destination → worklet tap без хранения ссылки, риск двойного tap.** `audioEngine.ts:129` `(Tone.getDestination() as any).connect(worklet)`; гард `if (this.workletNode) return` есть, но connection нигде не дисконнектится, `workletNode` не обнуляется. При пересоздании контекста — старый tap остаётся + новый → удвоение softmix-сигнала (клиппинг §2.2). Фикс: хранить connection + teardown, убрать `as any` через тип `InputNode`.

**8.A.6 — MEDIUM — `electron.d.ts:72` контракт IPC врёт:** `softmixPeak` задокументирован «read-and-reset», реализован как decaying-без-reset (`utilityHost.mjs:114,320`). UI (`SettingsModal.tsx:38`) на основе ложного JSDoc может вычитать diff и получить мусор. Фикс: исправить JSDoc на «decaying peak, not reset on read».

**8.A.7 — LOW — `addon.cc:733`** `if (outputChannels < 0)` после `std::min(...,2)` — недостижимая ветка (мёртвый код).
**8.A.8 — LOW — `nativeAudioController.ts:51,98`** `channelLevels`/`getChannelLevel` дублируют RMS, считаемый и в LocalMixerStrip — двойной проход по PCM на кадр (перф-аспект §9.A.7).
**8.A.9 — LOW — `utilityHost.mjs:344`** `closeStream?.()` — опциональная цепочка на всегда-существующей функции (мёртвая защита).

**8.A.U — Подтверждение §2.1 доками node-addon-api.** `ThreadSafeFunction.Release()` НЕ дренирует очередь синхронно — оставшиеся задания выполняются после Release, читая глобальный `g_opusCh[].enc`, уже указывающий на НОВЫЙ энкодер после reinit. Баг реален. Уточнение к фиксу: лямбда должна нести свой `OpusEncoder*` в `OpusEncJob` (snapshot на момент enqueue), а не читать глобал по индексу.

> **Проверка «не врёт ли AUDIT» (ядро):** §1.1, §1.4, §2.2, §2.3, §2.4, §4.3, §5.4 — все подтверждены повторным чтением кода. AUDIT в зоне ядра точен; находки 8.A — дополнение, не опровержение.

### 8.B — Сеть (добор к §3–§4)

> Карта событий клиент↔сервер построена. Zod-валидация реально на каждом `room:event`/`room:*`/`chat`/`host_*`/`channel_meta`. **Подтверждены ОТКРЫТЫМИ** (не закрыты Волной 2): §3.1 (host-gating клипов фиктивен), §3.6 (reconnect-bypass лимитера, `rtc:signal` z.unknown), §4.1 (glare/A5 фантом), §4.2 (валидация входящего Opus). **Подтверждены ЗАКРЫТЫМИ** проверкой кода: §3.2, §3.3, §3.4, §3.5 — Волна 2 Батч 1 реально применена.
> **Положительное (баланс):** `senderId`-спуфинг закрыт (серверный `eventBaseSchema` стрипает клиентский `senderId`, сервер ставит `socket.id`); trickle-ICE буферизация кандидатов корректна (`pendingCandidates`); RTT-staleness сравнивает reference записи пира, не socketId (защита от stale-closure при reuse socketId); initiator-паттерн без glare в normal-flow продуман.

**8.B.1 — HIGH — `rtc:signal` без rate-limit + `signal: z.unknown()`.** `registerSocketHandlers.js:227` — единственный релей без `rateLimiter.consume`; схема валидирует только `targetSocketId`. Амплификация 1→1 без бюджета + произвольный объект уходит в `peerManager.handleSignal → simple-peer.signal()` (`App.tsx:410`, без guard `_kgbAudio` в simple-peer-пути — он только в native-пути `nativeRtcManager.ts:159`) — исторический источник крашей simple-peer на невалидном SDP. Уточняет §3.6. Фикс: `consume` + сузить схему (type/sdp.max/candidate/_kgbAudio).

**8.B.2 — MEDIUM — `participant:rtt` эхо отправителю + без throttle.** `registerSocketHandlers.js:400-411` шлёт `io.to(roomId)` (включая отправителя), не `.except`. Каждый клиент пингует каждые 2с и получает свой же RTT обратно (трафик N², см. §9.B.4). Фикс: `socket.to(roomId)` / `.except(socket.id)`.

**8.B.3 — MEDIUM — `mic_toggle`/`camera_toggle` нет case в `roomManager.applySyncEvent`.** Есть в схемах, эмитятся (`App.tsx:972,1027`), но в snapshot не сохраняются. By design (per-user, транзит), НО опоздавший видит чужие mic/cam как `true` по умолчанию, даже если выключены. Рассинхрон UI-состояния. Фикс: либо синкать в снапшот, либо задокументировать дефолт.

**8.B.4 — LOW — host-reassign при leave** детерминирован (Map insertion order, `roomManager.js:185`), но ack joiner-у со старым хостом может краткосрочно разойтись с broadcast `room:host` при гонке доставки. Самовосстанавливается следующим `room:host`.
**8.B.5 — LOW — мёртвый `channel_meta`** в `syncEventTypeSchema` (`syncProtocol.ts:20`) — реальный канал через отдельный `sync:channel_meta`, в discriminated union его нет.
**8.B.6 — LOW — `ICE_SERVERS` дублируется** вербатим в `peerManager.ts:7-21` и `nativeRtcManager.ts:2-15` — вынести в общий модуль.

### 8.C — Корневой слой / App.tsx / панели / синглтоны (зона ранее НЕ покрыта)

**8.C.1 — CRITICAL — Подписка на транспорт в module-side синглтоне без cleanup.** `timelineSingleton.ts:16-24`: `Tone.getTransport().on('start'/'stop', ...)` на верхнем уровне модуля, ни одного `off()`. В проде дубля нет (модуль исполняется один раз), НО при **Vite HMR в dev** модуль выполнится повторно → вторая пара `.on('start')` на тот же глобальный Transport → `scheduleMidiClips`/`scheduleAudioClips` дважды за один `start` → двойное расписание клипов (наложение/щелчки). Плюс `clear()` стора при выходе (`App.tsx:1079`) не снимает подписки. Фикс: идемпотентная регистрация + `import.meta.hot.dispose(off)`, либо явный `initTimelineRuntime()` с guard (как планировал REFACTOR_PLAN Шаг 3, но реализовано через module-side-effect — менее контролируемо).

**8.C.2 — HIGH — Гидрация снапшота теряет MIDI-ноты клипов.** `App.tsx:1037-1040`: `addClipWithId` переносит id/trackId/startSec/durSec/label/kind/proxy, но **НЕ** `notes`/`clipBars` (хотя `TimelineClip` их поддерживает, `timelineStore.ts:43-46`). У опоздавшего MIDI-клип без нот → тишина при воспроизведении, расхождение с остальными. `sendClipAdd` payload `notes` тоже не содержит (`timelineSync.ts:21`). Связано с §5.3 (там про WAV). Тихая порча данных. Фикс: решить — синкать ли MIDI-ноты; если да — добавить `notes`/`clipBars` в `clip_add` payload + гидрацию; если нет — задокументировать дыру.

**8.C.3 — HIGH — Live-waveform interval может пережить размонтирование / не глохнет на reset.** `App.tsx:266-287`: `liveTimerRef` (setInterval 150мс) чистится только в `stopLiveWaveform`; нет unmount-cleanup (`useEffect(() => () => stopLiveWaveform(), [])` отсутствует). Выход из комнаты (`App.tsx:1076-1082`) делает `timelineStore.clear()`, но не зовёт `stopLiveWaveform()`/`recorder.stopAll()` напрямую — полагается на `streamActive`-эффект. Если стрим активен при выходе — таймер крутится зря на очищенные клипы. Фикс: unmount-cleanup + явный stop при выходе.

**8.C.4 — MEDIUM — rAF active-speaker пере-подписывается на каждое изменение `participants`.** `App.tsx:347-374` deps `[participants]`; любой join/leave/mic-toggle рвёт rAF-цикл и заводит новый (cleanup корректен — не баг, но частая пере-подписка, перф §9.C.5). Фикс: `participantsRef`, не зависеть от массива.

**8.C.5 — MEDIUM — Хрупкие замыкания над `roomState` в record-flow.** `finishRecording` (`App.tsx:292-317`), `armTimelineTrack` (`:1173-1195`) — обычные функции в теле компонента, корректны только потому что пересоздаются каждый рендер (свежие `roomState`/`armed`) и хендлеры НЕ мемоизированы. Структурный риск: декомпозиция в хуки / `useCallback` без ref-дисциплины внесёт stale-closure. Не баг сейчас, но мина при рефакторе.

**8.C.6 — LOW — `syncOnly`** (`App.tsx:194`) дублирует `metronome.soundEnabled` — два источника правды одного факта (`handleSyncOnlyToggle:803` ставит оба). Сейчас не стреляет (единственный путь), но анти-паттерн.

> **Остатки graph-рефактора (мёртвый код).** Активного мёртвого кода графа в корневом слое НЕТ — Grep по `viewMode|CanvasView|nodeRegistry|useGraphStore|hydrateGraph|from './graph'` в App.tsx = 0. Файлов-сирот (`pianoTransport.ts`, `*Node.tsx`, `graph/`, `canvas/`) в дереве нет. Остались только **комментарии-призраки**: `App.tsx:1416-1417` («Shared by BOTH views (Panels+Canvas)… getNodeInstance().render()» — Canvas удалён); `PanelsView.tsx:11-12` (отсылка к старой графовой типизации, `PanelContentFn` берёт `string` вместо `PanelId`); `timelineStore.ts:116-118` («one per Timeline node → duplication», «per-store now» — мульти-инстансы выпали, фабрика зовётся 1 раз); `drumNodes.ts` (имя `*Nodes` после удаления нод); `App.tsx:206-219` («Close the add-node menu» — теперь add-module).
>
> **App.tsx (1937 строк)** — God-component на грани управляемости, но НЕ спагетти: рефы против stale-closure расставлены сознательно (`micEnabledRef`, `drumEmitRef`, `fullscreenSocketIdRef`), cleanup'ы в основном на месте, host-gating единообразен. Декомпозиция (по убыванию выгоды, с предупреждениями §9.C.14): record-flow → `useRecording()`; video-grid (дублирован theater/обычный) → `<VideoGrid>`; lobby (~170 строк, изолирован) → `<Lobby>`; room-sync wiring → `useRoomSync()`. **НЕ** оборачивать record/transport-хендлеры в `useCallback` без переноса зависимостей в ref — текущая корректность держится на пересоздании функций каждый рендер.

### 8.D — Модули: drum/piano/mixer/timeline-UI/RTC-видео/компоненты (зона ранее НЕ покрыта)

**8.D.1 — CRITICAL — setState внутри Tone.js-колбэка драм-машины (НЕ было в AUDIT).** `drumMachine.ts:361-385`: `scheduleRepeat('16n')` → `emitChange()` (`:384`) → `DrumMachineContainer.tsx:46` подписан через `drumMachine.subscribe(setState)` → **React setState из аудио-колбэка на каждый шаг** (8–16/сек). Близнец §5.4 (метроном), но §5.4 драм-машину не упоминает — отдельная находка, прямое нарушение CLAUDE.md. Фикс: текущий шаг через ref + отдельный rAF в контейнере; `emitChange` оставить только для структурных правок (toggle/velocity/pattern).

**8.D.2 — HIGH — Off-by-one степпера на границе доли.** `drumMachine.ts:369` `globalIdx` через `Math.round(posSec / sixteenthSec)`. Колбэк `scheduleRepeat` срабатывает чуть раньше номинального времени шага (lookahead Tone), `posSec` чуть меньше `k*sixteenthSec`, `Math.round` даёт то `k`, то `k-1` в зависимости от джиттера → шаг сыграется дважды или пропустится на границе. Нужен `Math.floor` с эпсилоном (`PianoRollPanel.tsx:55` уже использует `floor` — несогласованность подходов между модулями). Фикс: `Math.floor(posSec / sixteenthSec + 1e-6)`.

**8.D.3 — HIGH — MediaStream-утечка в VideoTile.** `VideoTile.tsx:45-49`: `el.srcObject = stream` без cleanup. При unmount `srcObject` остаётся, при смене `stream` старый не освобождается, треки не `stop()`. Для удалённых тайлов трек принадлежит peer'у (`stop` нельзя), но `srcObject = null` на cleanup нужен, чтобы `<video>` отпустил decode-pipeline (перф §9.C.11). Фикс: `return () => { el.srcObject = null }`.

**8.D.4 — HIGH — `pianoRollStore` мёртв после PR1.** `pianoRollStore.ts:29-97` — полноценный zustand-стор (notes/bars/selectedId + addNote/moveNote/resizeNote/setVelocity/removeNote/select/setBars/clear), но Grep по `client/src`: единственный вызов — `App.tsx:1080 usePianoRollStore.getState().clear()`. `PianoRollPanel` ведёт ноты через локальный `useState` (`:32-35`), стор не трогает. TASKS.md PR1 перенёс ноты в `MidiClip`, стор не удалили — **второй рассинхронизированный источник правды нот**. Живы только `STEPS_PER_BAR`/`DEFAULT_VELOCITY`/тип `PianoNote` (импортируются). Фикс: вырезать тело `create()` и действия, `clear()`-вызов заменить прямой очисткой клипа. Дубль генераторов id нот: `PianoRollPanel.tsx:15` (`pn-`) и `pianoRollStore.ts:44` (`pn-`) — латентная коллизия id.

**8.D.5 — MEDIUM — Клипы/драмы идут мимо микшера.** `audioClipPlayer.ts:47` `new Tone.Player(buffer).toDestination()` и `drumMachine.ts:145` `.toDestination()` → прямо в `Tone.Destination`, не через `mixerEngine`. Mute/Solo дорожек учитывается вручную в `scheduleAudioClips` (`:28-33`), но master-громкость/компрессор `mixerEngine` к ним не применяется. Тракт инструментов и тракт микшера — две разные точки вывода.

**8.D.6 — MEDIUM — PianoRollPanel не реагирует на изменение клипа.** `PianoRollPanel.tsx:32-33` инициализирует `notes`/`bars` из пропсов лениво (только при mount); `TimelinePanel.tsx:552` монтирует панель без `key`. Изменение клипа извне (sync от другого участника) при открытом редакторе → UI не обновится. Фикс: `key={openEditorClipId}` или контролируемые ноты.

**8.D.7 — MEDIUM — Гонка громкости на общем Tone.Player.** `drumMachine.ts:191,404` `player.volume.value = 20*log10(vel/127)` мутирует единственный `Tone.Players.player(track)` непосредственно перед `start()`. При overlap соседних шагов того же трека (swing/быстрый темп) или совпадении `triggerVoice` со степпером — последняя записанная громкость применится к уже звучащему голосу. Фикс: отдельный gain-узел на каждый триггер, не мутация общего плеера.

**8.D.8 — LOW/MED — `mixerEngine.removeChannel` не отключает MediaStreamSource от трека** (`mixerEngine.ts:50-84`) — поток держится (перф §9.D).
**8.D.9 — LOW — `mixerEngine` вероятно МЁРТВЫЙ ТРАКТ:** берёт `MediaStreamSource` из WebRTC-аудио, но ремоут теперь нативный (Opus/PortAudio) — весь WebRTC-аудио-движок вероятно обойдён. Требует подтверждения по App.tsx, но похоже на осиротевший слой (`MixerChannel.tsx` использует `mixerEngine`, `App.tsx:103`).
**8.D.10 — LOW — Мёртвые публичные методы:** `mixerEngine.getMasterVolume/getControls` (`mixerEngine.ts:140-146`); `DrumMachine.getPatternBank/setPattern` (`drumMachine.ts:122,303`) — не вызываются.
**8.D.11 — LOW — Pan-стейт чисто визуальный, никуда не подключён:** `RemoteChannelStrip.tsx:32`, `LocalMixerStrip.tsx:23` (комментарий признаёт).
**8.D.12 — LOW — `DrumMachineContainer.tsx:46`** `subscribe` синхронно зовёт listener → лишний ранний setState (минор).

> **Понижено после перепроверки:** `exportClip.ts` WAV-заголовок оказался согласован для mono16 (НЕ баг данных). Реальный недостаток (LOW): при `clipId` с настоящим аудио возвращается чужой Blob (может быть stereo/иного SR), имя файла всегда `.wav` даже при mp3, `opts.sampleRate` к реальному Blob не применяется — рассинхрон метаданных; экспорт «тишины» — плейсхолдер (комментарий в коде).
> **Подтверждено хорошим:** mixer-strip'ы — все 4 (MixerStrip/MixerChannel/RemoteChannelStrip/LocalMixerStrip) используются, дублей нет (три «источника» под один презентационный MixerStrip — нормально). `ChatPanel` рендерит `{msg.text}` как JSX-текст (экранируется) — XSS по рендеру нет (опровергает гипотетику §3.7 на стороне клиента); чат капнут на 100 сообщений — роста памяти нет.

---

## §9. Производительность и распределение ресурсов (сессия 2, 2026-06-14)

> Числа — порядковые оценки с показанным расчётом, сверены где нетривиально с RFC 6716, Opus Recommended Settings (Xiph), MDN Transferable, electron MessagePortMain, Tone.js issue-tracker, mesh-vs-SFU. Severity по влиянию на производительность: CRITICAL = xrun/дропы/неогр. рост; HIGH = заметный CPU/латентность/трафик; MEDIUM; LOW.
> **Базовые частоты (SR=48000):** PCM-callback на буфер — buf 256 → 187.5/с, 128 → 375/с, 64 → 750/с. Opus-фрейм 20мс → 50/с на канал. Softmix-quantum AudioWorklet 128 → 375/с. Текущий конфиг захардкожен: buf 256, frameMs 20, bitrate 96000, complexity 5.

### 9.A — RT-поток / CPU ядра

**9.A.1 — CRITICAL — malloc/new в RT-колбэке на каждом блоке.** `addon.cc:497-500` (PCM-копия `malloc`+`new PcmChunk`), `:544-547` (Opus-job `malloc`+`new OpusEncJob`). При buf 64 = 750 malloc + 750 free + 750 `new`/с; Opus +50/с/канал. `malloc` без верхней границы по времени (lock арены / syscall) → в бюджете 64 сэмпла = 1.33мс один stall = пропуск буфера = xrun/щелчок. Количественно уточняет §2.4 (там severity LOW/MED — здесь CRITICAL для buf ≤128). Фикс: преаллоц. SPSC-кольцо RT→worker (уже спроектировано в комментарии `addon.cc:83`).

**9.A.2 — CRITICAL — `encodePacket` в цикле по каждому пиру.** `nativeRtcManager.ts:305-311` `broadcastOpusPacket`: `encodePacket` (new ArrayBuffer(13+len)+Uint8Array+копия payload, `:39`) вызывается заново для КАЖДОГО пира, хотя пакет идентичен (тот же channelIndex/sequence/payload). При 8 уч × 2 канала = 700 лишних ArrayBuffer/с (GC-давление в renderer) против 100 нужных; линейно с числом пиров — зона «упрётся первой». Фикс (однострочник): кодировать пакет ОДИН раз до цикла, слать один и тот же ArrayBuffer всем (`channel.send` не забирает буфер).

**9.A.3 — HIGH — single-thread encode + decode + IPC.** `addon.cc:554` (encode-лямбда), `:1071` (decode), весь IPC — на одном JS-потоке utility. 8 уч × 2 канала: 100 encode + 700 decode + 375 softmix-push/с. encode complexity 5 — самая тяжёлая операция (Xiph/RFC 6716: complexity↔CPU напрямую). Поток станет bottleneck по encode/decode раньше памяти/IPC. Количественно уточняет §1.5. Фикс: encode (и decode) на выделенный worker-thread — снимает и 9.A.1, и 9.A.3 **одним рефактором**.

**9.A.4 — HIGH — softmix-тракт: 375/с копий + аллокаций + 2 diagnostic peak-скана.** Путь quantum: worklet `new Float32Array`+стерео→моно (`portaudioWorklet.js:40-45`) → transfer в renderer → renderer `new Float32Array` + полный peak-скан (`audioEngine.ts:113`) → `pushSoftmix` `postMessage` БЕЗ transfer-листа (`preload.js:188`) = structured-clone копия → utility `new Float32Array` (`utilityHost.mjs:106`) + ещё peak-скан (`:108-112`) → копия в кольцо. 375×/с × (3 alloc + 2 полных peak-прохода + 1 clone). Два diagnostic peak-скана нужны только для Settings-диагностики — чистый оверхед. Фикс: загейтить peak-сканы за «Settings открыт»; батчинг quantum (transfer на шаге 4 невозможен — ограничение Electron MessagePortMain).

**9.A.5 — HIGH — RT-колбэк: ~11 проходов по выходному буферу при 7 пирах.** `addon.cc:413` (memset) → `:417` (monitor-mix) → `:439-447` (peer-mix, вложенный `for c<outCh`) → `:469-475` (softmix) → `:483-489` (clip). Выходной буфер трогается (1+1+P+1+1) раз; для 7 пиров = 11 проходов по `frames×2` каждый блок. Фикс: слить peer-mix+softmix+clip в один проход; mono→stereo писать `out[2f]=out[2f+1]=acc`.

**9.A.6 — MEDIUM — recorder копирует весь многоканальный PCM.** `recorder.ts:101` `new Float32Array(samples)` — все каналы, хотя извлекается один (`extractChannel:127`); 2× память/копирование при 2-канальном входе/записи 1 канала (= §5.14, перф-аспект). Фикс: извлекать целевой канал сразу при push.
**9.A.7 — MEDIUM — двойной `onPcm` RMS-проход** (`nativeAudioController.ts:74-89` + `recorder.ts:93`) — два независимых подписчика, каждый `new Float32Array` + полный RMS-проход по тому же буферу (187.5/с) (= 8.A.8). Фикс: общий view, RMS только когда VU видимы.
**9.A.8 — MEDIUM — live-waveform store-write 7×/с с растущим массивом** (= §5.11, `App.tsx:271`).
**9.A.9 — MEDIUM — RMS пер-пир считается в RT всегда, даже без VU-читателей** (`addon.cc:438-456`) — полный `for f<frames` + sqrt + leaky-integrator на каждый блок на каждого пира. Фикс: реже / гейтить флагом.
**9.A.10 — LOW/MED — std::map jitter с per-packet alloc** (`addon.cc:1121` `emplace(seq, vector<uint8_t>)`) — нода map + heap-vector на каждый входящий пакет (8 уч × 2 кан = 700/с). Фикс: ring-буфер фикс. размера (jitter всё равно капится JITTER_MAX=8).
**9.A.11 — LOW — getStats 30/с строит `remoteChannelLevels` Napi-объект даже при нуле пиров** (`addon.cc:1027-1059`). Гейтить на наличие пиров.
**9.A.12 — LOW — `metronome.ts:79`** `emitChange`→setState на долю (= §5.4 перф-аспект).
> **Хорошо:** SPSC-кольца (PeerRing, softmix) lock-free корректны; `accumBuf` для Opus преаллоцирован (`addon.cc:71`); jitter-eviction учитывает wrap. Аллокации — единственная проблема горячего пути, не memory-ordering.

### 9.B — Сеть / трафик / масштаб

> Топология — полносвязный WebRTC-mesh; на каждый аудио-канал (до 32 на пира) отдельный `DataChannel.send()` каждому пиру = двойной N² (N²-пиры × K-каналов).
> **Расчёт трафика (8 уч, Opus 96 kbps + ~30 kbps SCTP/DTLS/UDP/IP overhead на 20мс-фреймах, ~75 B/пакет):**
> - K=1 (голос): 1 поток = 126 kbps; upload на пира K·(N-1)·126 = **882 kbps**; download столько же; агрегат ~7 Мбит/с.
> - K=3 (multichannel гитара+вокал+DI): upload **~2.65 Мбит/с** на пира; download ~2.65; агрегат ~21 Мбит/с — плюс **отдельный видео-mesh** (peerManager) поверх.
> - При 32 kbps mono: K=3 upload ~1.3 Мбит/с — вдвое легче.

**9.B.1 — CRITICAL — Mesh + per-channel fan-out не масштабируется на целевые 8.** `nativeRtcManager.ts:305-312`. Консенсус индустрии: pure mesh надёжен до ~4 участников; проект таргетит 8 (clamp 2–8, `schemas.js:16`) — верх диапазона. Хуже обычного звонка: **двойной mesh** (аудио `nativeRtc` + видео `peerManager`) + **per-channel fan-out** (эфф. upstream = K·(N-1), не N-1). Фикс: SFU (upload K·(N-1)→K·1) для целевых 8; до тех пор честно ограничить mesh ≤4–5.
**9.B.2 — HIGH — Opus 96 kbps mono в 3–4× выше sweet-spot** (= 8.A.2). 96→32 = −66% всего mesh-трафика. Самый дешёвый крупный выигрыш.
**9.B.3 — HIGH — `clip:file` полный WAV (до 16МБ) по сокету, fan-out 1→(N-1), не хранится** (`registerSocketHandlers.js:203`, `roomSyncClient.ts:282`). Один клип на 8 = ~7×WAV через сервер; на free-tier Render бьёт по лимитам полосы. (= §5.3 для late-joiner + перф.) Фикс: хранить на сервере / раздавать P2P через DataChannel.
**9.B.4 — MEDIUM — `participant:rtt` `io.to` включает отправителя, N²** (= 8.B.2).
**9.B.5 — MEDIUM — два независимых ping-цикла по 2с:** socket-ping (`roomSyncClient.ts:487`) + per-peer ctrl-ping по DataChannel (`nativeRtcManager.ts:256`). Второй — N² таймеров на комнату. Фикс: переиспользовать один механизм.
**9.B.6 — MEDIUM — полная ре-сериализация syncState** (patternBank×8 + все clips) на каждый create/join (`roomManager.js:214`, `cloneSlot`×8). При capped-state приемлемо.
**9.B.7 — LOW/MED — frameMs 20:** SCTP/DTLS/UDP/IP overhead (~30 kbps) почти равен полезному payload при 32 kbps. frameMs 20→40 = overhead вдвое, ценой +20мс задержки (оценить для RT). DataChannel `ordered:false`/`maxRetransmits:0` (`nativeRtcManager.ts:108`) — правильно для RT.
**9.B.8 — LOW — socket-ping каждые 2с гонит `participant:rtt` даже без изменения RTT** (`roomSyncClient.ts:489`).
> **Где упрётся первым:** (1) **upload пира** (бытовой 5–10 Мбит/с, съедается аудио+видео-mesh при K≥3 или видео); (2) **CPU encode single-thread** (9.A.3) почти одновременно; (3) `clip:file` всплески; (4) видео-mesh упрётся раньше аудио при включённых камерах. Сигнальный сервер НЕ узкое место при capped-state.
> **Хорошо:** `room:event` fan-out `io.to().except(sender)` корректен; DataChannel сконфигурирован для RT правильно; drag/trim не флудит сокет; транспорт websocket-only.

### 9.C — React-рендер

> **Главное:** при playback (метроном+драм+таймлайн открыты) `App` (1937 строк JSX) реконсилируется ЦЕЛИКОМ **~55 раз/с** — 3 setState из горячих аудио-путей замкнуты на стейт App. Аудио-тайминг при этом НЕ страдает (audio-clock независим) — страдает UI-отзывчивость и расход CPU/батареи.
> Расчёт (120 BPM 4/4): метроном-доля 8 + beatFlash on+off 16 + native levels 33мс 30 + active-speaker ~0–2 (guard) = **~54–56/с**. Источники разнофазны (audio-clock vs 33мс vs 80мс), React-batching почти не сливает.

**9.C.1 — CRITICAL — `metronome.ts:79-91` + `App.tsx:472-474`** — `setMetronomeState` на каждую долю, App подписан целиком (= §5.4). Фикс: `currentBeat` в ref + лёгкий `<BeatIndicator>`.
**9.C.2 — CRITICAL — `drumMachine.ts:361-385`** — 16n `scheduleRepeat` → `emitChange` → `getState()` КЛОНИРУЕТ все pattern+velocity (8 массивов) на каждый тик (= 8.D.1 + перф). Фикс: узкий `{currentStep}`, не полный getState.
**9.C.3 — CRITICAL — `TimelinePanel.tsx:104-109`** — RAF playhead **БЕЗ гейта на `isPlaying`**: `setPlaySec` каждый кадр всегда → ре-рендер всего TimelinePanel (594 строки: клипы/треки/грид/ruler) ~60/с **постоянно пока панель открыта**. Фикс: гейт на `isPlaying` + playhead через CSS-transform отдельного элемента (ref).
**9.C.4 — CRITICAL — `PianoRollPanel.tsx:49-61`** — тот же паттерн, `setPlayStep` каждый кадр всегда; открыт поверх таймлайна → 9.C.3 и 9.C.4 крутятся одновременно (+60/с). Фикс: гейт + ref-playhead.
**9.C.5 — HIGH — `App.tsx:346-374` active-speaker RAF** — equality-guard спасает ре-рендеры (`prev===topId?prev:topId`), но `mixerEngine.getLevelRms()` по всем участникам каждый кадр всегда (CPU). Фикс: throttle до 10–15 Гц.
**9.C.6 — HIGH — `App.tsx:378-385` `setInterval(33мс)` → `setNativeRemoteLevels`** (новый объект) → ре-рендер App 30×/с постоянно в комнате (даже на паузе) + каскад на все RemoteChannelStrip. Фикс: вынести VU в самоопрашивающийся компонент, не держать levels в App-стейте.
**9.C.7 — HIGH — `MixerChannel.tsx:23-31`** — свой RAF на каждый удалённый канал → `setLevel` каждый кадр (N×60/с). Фикс: общий VU-тикер ~20 Гц.
**9.C.8 — HIGH — `LocalMixerStrip.tsx:47-54`** — то же per-instance RAF на локальный канал. Фикс: общий тикер/throttle.
**9.C.9 — HIGH — live-waveform `setInterval(150мс)` → `updateClip`(растущий peaks)** → ре-рендер TimelinePanel 7×/с во время записи поверх 9.C.3 (= §5.11). Фикс: peaks в ref + прямой canvas.
**9.C.10 — MEDIUM — `App.tsx:1112,1418-1443`** — на каждый ре-рендер App пересоздаются `remoteTiles` (.map), `panelContents` (новый Record с инлайн-стрелками), `mixerContent`/`metronomeContent` JSX. При ~55 ре-рендерах/с — постоянная аллокация + ломает любую будущую memo детей. Фикс: useMemo/useCallback, вынос из App.
**9.C.11 — MEDIUM — VideoTile не memo + инлайн-колбэки** (`onHostMute`/`onClick`) + новые объекты (`App.tsx:1740-1789`). Каждый видеотайл реконсилируется на каждый App-тик. Фикс: `React.memo` + стабильные колбэки (см. 8.D.3 для srcObject).
**9.C.12 — MEDIUM — strip'ы не мемоизированы;** RemoteChannelStrip получает `level` пропом из App-стейта (9.C.6) → весь mixer-rack diff'ится 30×/с. Фикс: memo + стабильные пропы.
**9.C.13 — MEDIUM — `App.tsx:477-483` beatFlash:** `setBeatFlash(true)`+`setTimeout(80мс,false)` на каждую смену `currentBeat` → 2 доп. ре-рендера App/долю + класс на корневом `<main>` (`:1448`) → возможен большой repaint shell. Фикс: CSS-анимация на отдельном элементе.
**9.C.14 — LOW — `App.tsx:139-199` ~45 `useState`** в одном компоненте — любой горячий setState реконсилирует ~1500 строк JSX (корневая причина каскадов). Фикс: декомпозиция (8.C).
**9.C.15 — LOW — `drumMachine.ts:116` `patternActivity`** пересчёт всех 8 слотов на каждый `getState()` (= step-тик). Фикс: кэшировать activity, инвалидировать на правку.
> **Карта одновременных RAF:** ~3 + N + K (active-speaker + TimelinePanel + PianoRoll + N MixerChannel + K LocalMixerStrip), большинство БЕЗ гейта на playback/видимость. **setInterval:** native levels 33мс, live-waveform 150мс, beatFlash 80мс setTimeout. Смягчение: RAF в панелях останавливаются при размонтировании (FloatingPanel рендерит `null` для закрытых, `keepMounted` только chat) — случайное, не намеренное.
> `React.memo` помогает только при стабильных пропах — memo детей + стабилизацию пропов делать в паре, и только ПОСЛЕ 9.C.1–4/6. RAF/интервалы имеют корректный cleanup — утечки по размонтированию нет, проблема в **частоте**.

### 9.D — Память / аллокации / алгоритмы

> **Рост памяти при длительной сессии** (запись + многократный play/stop), не освобождается до перезагрузки:

**9.D.1 — CRITICAL — `recorder.chunks` без границы и без сброса на диск.** `recorder.ts:99-114` `push(new Float32Array)`. 48000×4×2 = 384 КБ/с ≈ **23 МБ/мин стерео** (11.5 моно); пик ×2 на финализации (`extractChannel:129` + `encodeWav:143`). 10 мин = 115–230 МБ в одном массиве. Количественно уточняет §5.14 (severity не была оценена → CRITICAL). Фикс: потоковая запись на диск через Electron main; извлекать нужный канал сразу (не хранить все каналы — экономия в `channels`× раз).
**9.D.2 — HIGH — `clipAudio` (`recorder.ts:31`, Blob) + `bufferCache` (`audioClipPlayer.ts:22`, декодир. ToneAudioBuffer ≈×4) — module-level Map, НИКОГДА не вытесняются.** `removeClip` (`timelineStore.ts:173-180`) их не трогает; `applyClipFile` (`timelineSync.ts:75`) всегда `set` даже без клипа (= §5.15). Удалил клип в UI → WAV+декодир. буфер в RAM навсегда. «час репетиции, 20 дублей по 2 мин, половину удалил» → `clipAudio` ~220 МБ (110 чистая утечка) + `bufferCache` сотни МБ → приложение в **0.5–1 ГБ**. Фикс: в `removeClip` `clipAudio.delete` + `bufferCache.dispose()+delete`; LRU-кэп.
**9.D.3 — HIGH — `new Tone.Player` на каждый клип при каждом play, нет пула.** `audioClipPlayer.ts:45-47` `scheduleAudioClips` на каждый transport `start`: N плееров (GainNode + одноразовый AudioBufferSourceNode). `dispose` на stop корректен (НЕ утечка самих плееров), но `Tone.Player` переиспользуем (буфер кэширован) — пересоздавать обёртку+connect на каждый play незачем. play→stop×M = N×M создано/освобождено (GC-давление). Tone.js (issue-tracker): обёртка Player переиспользуема, но новый AudioBufferSourceNode на каждый `start` (Web Audio source одноразовы). Фикс: пул плееров (`player.buffer = ...` при смене).
**9.D.4 — MEDIUM — live-waveform растущий peaks в zustand 7×/с** (= §5.11 / 9.C.9): `getLive` slice + `updateClip` `clips.map` (новый массив+объект). 3-мин дубль = 9000 элементов копируются 7×/с. Фикс: ref+canvas или коммит только на финализации.
**9.D.5 — MEDIUM — drumMachine `emitChange` full `getState` clone на каждый 16-й** (= 9.C.2): клон ~10 массивов + скан 32 трека `slotHasContent` 8/с. Фикс: узкий `currentStep`.
**9.D.6 — MEDIUM — `drumMachine.ts:367,397` `Tone.Time('16n').toSeconds()` парс строки в колбэке каждый шаг (до 3×);** значение зависит только от BPM. Фикс: кэш `sixteenthSec`, инвалидация на `bpm_change` (`midiPlayer.ts:31` уже так на момент schedule).
**9.D.7 — MEDIUM — undo-история: глубокий клон ВСЕХ tracks+clips+notes на каждый жест,** `HISTORY_MAX=60` (`timelineStore.ts:329-330`, `snap:108-112`). Большой проект → 60×O(clips×notes) в RAM. Фикс: структурное разделение / diff-undo.
**9.D.8 — LOW/MED — `removeGaps`/`closeGapAt`/`packFromFirst`** (`timelineStore.ts:264,306,320`) filter+sort всей ленты + `.map` по всем клипам на жест. O(n log n)+O(n), не горячо.
**9.D.9 — LOW — `mixerEngine.ts:156` `new Uint8Array(frequencyBinCount)` на каждый `getLevelRms`** (из meter-loop ~60 Гц × каналы). Фикс: переиспользуемый Uint8Array на канал.
**9.D.10 — LOW — `mixerEngine.ts:172` `[...channels.values()]` на каждый `effectiveGain` в цикле `recomputeAllGains` → O(n²).** Фикс: `anySoloed` один раз перед циклом.
> **Хорошо:** `mixerEngine` корректно `disconnect` при `removeChannel` (нет утечки графа); `clearAudioClipSchedule` дисциплинированно `dispose` плееров; `mediaDevices` корректно `stop` треки; `DrumMachine.dispose` чистит; `participantColor` — чистая дешёвая функция. Play/stop сам по себе не утекает — реальная утечка play-тракта в том, что `bufferCache` (9.D.2) растёт и переживает удаление клипов.

### 9.E — Масштабирование на 8 участников (где упрётся первым)

Порядок отказа (оценка): **(1) CPU JS-потока utility** (9.A.3) — 100 encode + 700 decode + 375 softmix на одном потоке, упрётся раньше памяти/IPC; опус TSFN-queue (64) переполнится → `g_dropCount` растёт. **(2) GC-давление в renderer** (9.A.2 + 9.A.4) — 700+ лишних alloc/с → major GC паузы → джиттер UI. **(3) RT-колбэк** (9.A.1 + 9.A.5) — на ASIO 64 malloc даст xrun раньше, чем CPU encode упрётся. **(4) Память** (9.D.1/9.D.2) течёт, но не мгновенный отказ. **(5) Upload-канал пира** (9.B) — насыщение при K≥3 или видео. **Latency:** софт-путь добавляет слои (worklet quantum + softmix-кольцо + peer ring + jitter) поверх драйвера; драйверный запас (ASIO 64 = 1.33мс) съедается программными слоями, реальный end-to-end — десятки мс.

### 9.F — Приоритет перф-фиксов по ROI

1. **9.A.2 + 9.B.2** — encode-once + Opus 32–48 kbps. Два мелких изменения, сразу −66% трафика и −O(пиры) аллокаций. **Делать первыми — копеечная цена.**
2. **9.C.3/9.C.4 + 9.C.6/9.C.1** — гейт playhead-RAF на `isPlaying`, увод VU/метронома из стейта App. Убирает ~115 холостых ре-рендеров/с.
3. **9.D.2** — чистка `clipAudio`/`bufferCache` при `removeClip`. Однострочники против утечки в сотни МБ.
4. **9.A.1 + 9.A.3** — worker-thread + SPSC кольцо в аддоне. Крупный рефактор, но единственный путь к 8 уч. и low-latency buf.
5. **9.D.1** — потоковая запись на диск.
6. **9.B.1 / SFU** — архитектурное решение для масштаба 8; до тех пор ограничить mesh.

---

## Приоритеты исправления (черновой)

1. **§1.1/§1.3 — clock domains и сетевой drift.** Playout-буфер с целевой задержкой + drift-компенсация. Блокер Phase 1, не Phase 4.
2. **§3.1/§3.2/§3.3 — сервер:** host-gate граф/клипы (или настоящий LWW+лимиты), лимит+throttle на `clip:file`, фикс утечки комнат.
3. **§5.1/§5.2 — переписать latency-компенсацию** (только input, локально, не синкать) + **§5.4 убрать setState из аудио-колбэка**.
4. **§5.3 — серверное хранение/догрузка WAV** для опоздавших.
5. **§1.4 / §8.A.1 — читать и сохранять реальный `result.sampleRate`**, не хардкодить 48к (тихая порча всех записей на не-48k).
6. **§7.1 — убрать вложенный репозиторий.**
7. **(сессия 2, дёшево/высокий ROI) §8.A.1 + §8.C.2** — две тихих порчи данных (SR записи, потеря MIDI-нот); **§8.D.1 + §5.4** — убрать setState из аудио-колбэков drum/метроном; **§9.A.2 + §9.B.2** — encode-once + снизить Opus-битрейт; **§9.D.2** — чистка `clipAudio`/`bufferCache` при удалении клипа.
8. **(сессия 2, крупный рефактор) §9.A.1 + §9.A.3** — worker-thread + SPSC-кольцо в аддоне (открывает путь к 8 участникам и low-latency buf); **§9.B.1** — SFU или честное ограничение mesh ≤4–5.
9. **(сессия 2, UI) §9.C** — гейт playhead-RAF на `isPlaying`, увод VU/метронома из стейта App, декомпозиция App.tsx (§8.C).

---

## Журнал разбора

- **2026-06-14, сессия 1:** покрыты §1–§7 (аддон, сервер, нативный JS/IPC, тайминг/запись/синк, docs-сверка, репо). Дальше — граф/canvas/panels, drum/piano-roll логика, TimelinePanel целиком, mixerEngine, RTC-видео, export, сборка, тесты. См. «Статус разбора» выше.
- **2026-06-14, сессия 2:** два аудита по 4 параллельных агента.
  - **§8 — корректность** ранее не покрытых зон (App.tsx целиком, panels, singletons, drum/piano/mixer, RTC-видео, компоненты) + добор по ядру (8.A) и сети (8.B). Ключевое новое: §8.A.1 (SR записи), §8.C.1 (HMR-дубль подписок транспорта), §8.C.2 (потеря MIDI-нот), §8.D.1 (setState в Tone-колбэке драм-машины), §8.D.3 (утечка srcObject), §8.D.4 (мёртвый pianoRollStore). Граф-рефактор подтверждён доведённым (только комментарии-призраки). AUDIT §1–§7 перепроверен — в зоне ядра точен.
  - **§9 — производительность/ресурсы** (RT/CPU, трафик/масштаб, рендер, память). Ключевое: §9.A.1/9.A.3 (malloc в RT + single-thread — потолок на 8 уч.), §9.A.2 (encode-per-peer), §9.B.1 (mesh не масштабируется), §9.C (~55 ре-рендеров App/с + негейтированные RAF), §9.D.1/9.D.2 (рост памяти до 0.5–1 ГБ). ROI-приоритеты в §9.F.
  - Осталось не покрытым: SettingsModal/DeviceSetupModal глубоко, сборка/упаковка, mixdown-экспорт-тракт. Тестов в дереве нет (подтверждено).
