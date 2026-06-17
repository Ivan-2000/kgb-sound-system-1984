# KGB Sound — TASKS.md

Задачи по разработке. Архитектура — в `docs/kgb_sound_system_85_application_architecture_v_2.md`.
`[x]` — реализовано, `[ ]` — предстоит сделать.

> **Этот файл = спеки и статус фич (V/I/T, фазы).** Баг-беклог — в `AUDIT.md`.
> Кто что делает и в каком порядке (две дорожки + точный маппинг спринт→пункты) —
> в **`SPRINTS.md`** (Coverage ledger). При закрытии пункта: `[x]` здесь **и** ✅ в
> ledger SPRINTS.md. Правила слияния — `AGENTS.md`.

Версия: **1.24**
Обновлён: 2026-06-17

---

## Содержание

- [Архитектурный пивот 2026-06-06](#архитектурный-пивот-2026-06-06)
- [Архитектура аудиосигнала](#архитектура-аудиосигнала)
- [Схема работы](#схема-работы)
- [Phase 1 — Сеть и комнаты](#phase-1--сеть-и-комнаты)
- [Phase 2 — Миксер и запись](#phase-2--миксер-и-запись)
- [Phase 3 — Монтажный стол и MIDI](#phase-3--монтажный-стол-и-midi)
- [Phase 4 — Метроном и драм-машина](#phase-4--метроном-и-драм-машина)
- [Phase 5 — UI и полировка](#phase-5--ui-и-полировка)
- [Дополнительные фичи](#дополнительные-фичи)
- [Технический стек](#технический-стек)
- [Общий прогресс](#общий-прогресс)

---

## Архитектурный пивот 2026-06-06

Решение о смене модели взаимодействия между модулями. Влияет на Phase 2/3.

**Было:** ноды связываются типизированными кабелями (audio / control / trigger / value / midi), сигналы маршрутизируются через `ControlBus`; Canvas — продвинутый режим работы с реальными связями; миди от Piano Roll → Drum через `notesOut → notesIn`; G5 (audio routing через граф) и G8 (math/util-ноды) были фундаментом «модульного синтезатора».

**Стало:** **panels-first**. Каждый модуль — самодостаточная панель. Связей между нодами нет, **за единственным исключением общего clock sync через проектный транспорт**.

> **Обновление 2026-06-14:** нодовый граф и Canvas (React Flow) **удалены из кода целиком** (`client/src/graph/`, `client/src/canvas/`, обёртки `*Node.tsx`, `@xyflow/react`) — не «заморожены в репо», как было в первой редакции пивота. Окна теперь на `client/src/panels/panelStore.ts`. См. `REFACTOR_PLAN.md`.

**Что заменяет кабели:**
- **Drum → Piano Roll** — кнопка «перенести паттерн» на драм-машине: разовая конвертация `pattern[track][step] + velocity + swing → NoteEvent[]` (маппинг 36→kick, 38→snare, 42→hat, 49→crash уже зашит). Результат становится миди-клипом на дорожке таймлайна. Никакого live-роутинга.
- **Piano Roll → звук** — Piano Roll перестаёт быть самостоятельной нодой со своим клоком. Он становится **редактором миди-клипа на дорожке таймлайна** (Reaper-style: двойной клик / «развернуть» по клипу → пиано-ролл редактирует ноты этого клипа). Транспорт — общий проектный, `PianoTransport` удаляется.
- **Звук миди-клипа до VST** — переходный период: барабанные клипы играются голосами драм-кита. Мелодические клипы звучат только когда появится VST-инструмент на дорожке.
- **Аудио-маршрутизация** — стандартная DAW-цепочка: `track → InsertChain (VST) → mixer master`. Граф `audio`-портов и G5 больше не нужны.

**Что выпадает из roadmap:**
- ~~G5 — Аудио-маршрутизация через `audio`-edges~~ → заменено цепочкой track→VST→mixer.
- ~~G8 — Math / util / mask-ноды~~ → требовали кабелей; без них продукт не зависит от этой библиотеки.
- ~~Кейс «совместить две драм-машины по маске»~~ → не строится без кабелей; вычеркнут.

**VST-хостинг (решения по ADR):**
- Хост живёт в том же `utilityProcess`, что PortAudio (вариант A в ADR §6). VST вызывается прямо из RT-callback, минимальная задержка, одна цепочка `ASIO → InsertChain → Opus`. Крэш VST убивает audio-engine, но через существующий `engine-crashed` event движок перезапускается.
- UI плагина: для MVP — **открытие в собственном OS-окне плагина** (без embed в Electron); + наш generic-params-fallback для headless-плагинов. Window embedding — отдельной задачей позже.
- Единый компонент **InsertChain** (UI + рантайм): список VST-инсертов с параметрами. Применяется в двух местах: на канал миксера (live insert до Opus-кодера) и на дорожку таймлайна (при воспроизведении клипов).
- Кросс-юзер: live — собеседники слышат уже обработанный сигнал автора (его VST на его машине); проектные файлы — копируется параметризация, предупреждение «VST отсутствует» если плагин не установлен у участника.

**MIDI-инпут с устройства** (в самом конце roadmap, не критично для основной функциональности):
- Транспорт **WebMIDI vs нативный PortMidi-bridge** — развилка, решается при подходе к реализации. Не противоречит другим решениям: оба варианта дают одинаковый `NoteEvent` в JS-сторону, выбор изолирован от VST-хоста, InsertChain и модели MIDI-канала.
- В тулбаре «+» → «Add MIDI Input» → выбор подключённого устройства → новый **MIDI-канал** в миксере (новый тип strip с обязательным instrument-слотом: VST-инструмент или встроенный синт-заглушка).
- MIDI-канал имеет **arm**-кнопку: armed → ноты пишутся в выделенный клип armed-дорожки таймлайна.

---

## Архитектура аудиосигнала

> **Принципиальная схема работы:**
>
> Каждый участник выбирает своё физическое аудиоустройство (аудиоинтерфейс, звуковая карта) локально на своём компьютере. Устройство является единственным источником и приёмником звука:
>
> - **Input(s)** — каналы ввода: микрофон, гитара, синтезатор или любой другой инструмент, подключённый во вход аудиоустройства. Многоканальные интерфейсы (например, Focusrite Scarlett 18i20) предоставляют несколько независимых input-каналов — все они автоматически появляются в миксере.
> - **Output(s)** — каналы вывода: мониторы, наушники. Аналогично могут быть многоканальными.
>
> Сигнальный путь:
> ```
> Инструмент → [аудиоустройство input] → PortAudio → PCM → Opus encode
>     → WebRTC DataChannel → сеть → WebRTC DataChannel
>     → Opus decode → PortAudio → [аудиоустройство output] → наушники/мониторы
> ```
>
> PortAudio абстрагирует драйверный слой и поддерживает несколько Host API для каждого устройства. Приложение выбирает оптимальный драйвер автоматически по приоритету, пользователь может переопределить вручную:
>
> | Host API | Задержка | Условие |
> |----------|----------|---------|
> | **ASIO** | < 10 мс | Профессиональный интерфейс с ASIO-драйвером |
> | **WASAPI Exclusive** | 10–30 мс | Современная звуковая карта, Windows Vista+ |
> | **WASAPI Shared** | 30–50 мс | Устройство используется несколькими приложениями |
> | **DirectSound** | 50–100 мс | Широкая совместимость, старые устройства |
> | **MME** | 100+ мс | Последний fallback |
>
> macOS: CoreAudio (единственный, нативный системный драйвер).
> Linux: ALSA или JACK.
>
> Интернет-соединение используется **только для передачи аудиопотока между участниками**. Никакого системного аудио через браузер (`getUserMedia`) в финальной архитектуре нет.
>
> **Текущее состояние:** нативный путь через PortAudio **реализован** (A1–A6, 2026-05-27): ASIO/WASAPI/CoreAudio/ALSA, libopus v1.5.2 encode/decode в utility-процессе, WebRTC DataChannel с jitter buffer, измерение round-trip RTT. Браузерный `getUserMedia` остаётся только для видео (VideoTile). Остаток Phase 1: A2 auto-Host-API + перечисление каналов устройства, end-to-end acceptance «гитара через ASIO без артефактов».

---

## Схема работы

**Актуальный порядок работ:** упрощение завершено (удаление графа, см. `REFACTOR_PLAN.md`). Дальше — фиксы по `AUDIT.md` (Волна 2: ядро §1/§2/§4, запись/синк §5, сервер §3), затем продолжение фаз ниже.

> **Исторический контекст (для справки).** До завершения A1–A6 работа шла в двух параллельных потоках:
> - **Поток A** — нативный аудиодвижок (A1 архитектура → A2 addon → A3 захват → A4 opus → A5 транспорт → A6 round-trip). Сейчас **закрыт** (валидировано 2026-05-27).
> - **Поток B** — независимые задачи параллельно с A: B1 signaling (закрыт), B2 драм/метроном на Web Audio (~80%), B3 UI (~60%).
>
> Параллельная модель свою задачу выполнила. Дальше работа сериализована по спринтам.

---

## Phase 1 — Сеть и комнаты

**Цель:** два участника подключаются к комнате и слышат друг друга через свои аудиоустройства в реальном времени с профессиональной латентностью.

**Оценка:** 2–3 недели (signaling) + 2–4 месяца (нативный аудиодвижок)

### Задачи

**Сигнализация и комнаты** *(закрыто — B1 завершён)*:
- [x] WebRTC signalling-сервер (Node.js + Socket.IO)
- [x] Создание комнаты с уникальным 4-символьным кодом
- [x] Подключение к комнате по коду
- [x] STUN-серверы (Google) для NAT traversal
- [x] TURN-релей (openrelay.metered.ca) для симметричного NAT
- [x] Автопереподключение при обрыве (Socket.IO reconnect + pending rejoin)
- [x] Изоляция комнат — участники слышат только свою комнату
- [x] Ограничение участников по комнате (rate limiting на события)
- [x] Пароль на комнату (приватная комната)
- [x] Лимит участников задаётся хостом (рекомендуемый максимум: 8)
- [x] Индикатор пинга каждого участника в реальном времени
- [x] Подключение по прямой ссылке (invite link)
- [x] Сохранение настроек посещённых комнат (история: код, имя, время)
- [x] История комнат на стартовом экране

**Нативный аудиодвижок** ⚠️ *критический блок — Поток A, без него инструменты не работают*:
- [x] ~~Аудиотранспорт через WebRTC (Opus через браузер `getUserMedia`)~~ — временный прототип, подлежит замене
- [x] ~~Музыкальные аудио-ограничения (echoCancellation: off, noiseSuppression: off, autoGainControl: off)~~ — актуально только для прототипа
- [x] **A1** — Выбор binding-стратегии: naudiodon vs. node-addon-api + PortAudio C++; схема IPC между main process и renderer *(см. `docs/ADR_native_audio.md`)*
- [x] **A2** — Интеграция PortAudio: перечисление всех аудиоустройств в системе (название, тип, число каналов)
- [x] **A2** — Перечисление доступных Host API для каждого устройства (ASIO / WASAPI / DirectSound / MME на Windows; CoreAudio на macOS; ALSA / JACK на Linux)
- [x] **A2** — Авто-выбор оптимального Host API по приоритету: ASIO → WASAPI_EXCLUSIVE → WASAPI → DirectSound → MME; пользователь может переопределить *(реализовано 2026-06-07: `bestApiForDevice()` + `HOST_API_PRIORITY` в `nativeAudioController.ts`; `loadDevices()` авто-выбирает первое input-устройство с лучшим API; `selectInput/selectOutput` без явного kind авто-выбирают API; Settings UI сохраняет ручной override через явную пару `deviceId::kind`)*
- [x] **A2** — Перечисление всех input/output каналов выбранного устройства с их названиями *(реализовано 2026-06-07: `maxInputChannels` в снапшоте; Settings UI показывает `(Nin)/(Nout)` в опциях устройств; селектор числа каналов 1..maxInputChannels; `setInputChannels()` с зажимом по capacity устройства; `buildChannelNames()` генерирует `${device.name} Ch.N`; ASIO per-channel имена — Phase 5 MI3)*
- [x] **A3** — Рефакторинг инициализации PortAudio: `Pa_Initialize()` вызывается один раз при старте приложения и живёт всё время его работы; `Pa_Terminate()` — только при выходе; `getDevices()` и стримы работают внутри одной сессии (текущая архитектура A2 вызывает `Pa_Initialize/Pa_Terminate` при каждом `getDevices()` — это несовместимо с открытым стримом)
- [x] **A3** — Нативный захват аудио через Electron main process (минуя браузерный `getUserMedia`)
- [x] **A3** — Настройка размера буфера (buffer size): цель ≤ 64 сэмпла для ASIO, ≤ 256 для WASAPI
- [x] **A3** — Захват PCM со всех активных input-каналов выбранного устройства
- [x] **A3** — Нативный мониторинг: PortAudio открывает вход и выход одновременно, PCM-буфер из input callback напрямую маршрутизируется на output (`Инструмент → PortAudio input callback → PortAudio output → наушники`); задержка на уровне драйвера — ASIO ~1–5 мс, WASAPI ~10 мс; архитектурно неотделимо от открытия стрима, реализуется в той же инициализации; управляется параметром `monitor: true/false` с регулировкой громкости в миксере *(реализовано и валидировано end-to-end: input→output×gain в PaCallback с атомарным setMonitorGain; duplex на раздельных input/output deviceId — через A3.5b; исправлено 2 бага: addon.cc сбрасывал monitorGain в 0 при openStream, ipc.js не пробрасывал monitor/monitorGain в addon)*
- [x] **A3** — Переинициализация аудиоустройства без перезапуска приложения (смена устройства / драйвера)
- [x] **A3.5a** — ASIO support в сборке: ASIO SDK 2.3.4 у Steinberg через переменную окружения `KGB_ASIO_SDK_DIR` (лицензия запрещает редистрибуцию, SDK не в репо); PortAudio как git submodule в `third_party/portaudio/` вместо MSYS2-сборки (`v19.7.0`, `iasiothiscallresolver.cpp` обеспечивает MinGW-совместимость); флаги `PA_USE_ASIO=ON`, `PA_USE_WASAPI=ON`, `PA_USE_WDMKS=ON`, `PA_USE_DS=ON`, `PA_USE_WMME=ON` в CMakeLists; `build:asio` / `build:noasio` в package.json; скрипт `scripts/fetch-asio-sdk.ps1` для новых разработчиков; README с разделом «Building with ASIO». Без `KGB_ASIO_SDK_DIR` — CMake fatal error со ссылкой на скрипт; `build:noasio` работает без SDK. *(валидировано: BEHRINGER USB AUDIO и FL Studio ASIO появляются в `getDevices()` с `kind: 'ASIO'`; inputLatency 6.3 мс, round-trip 23.2 мс ≤ 30 мс; ASIO-мониторинг работает; блокер A6 снят)*
- [x] **A3.5b** — Расширить `openStream` API на раздельные `inputDeviceId` / `outputDeviceId` для duplex-стрима на разных устройствах (Windows split: WASAPI/DirectSound/WDM-KS выдают input и output одного физического устройства как отдельные deviceId). Реализовано: раздельные `PaStreamParameters` и `PaWasapiStreamInfo` на каждую сторону; `inputHostApiKind`/`outputHostApiKind` позволяют задать EXCLUSIVE независимо для каждой стороны; back-compat — старый `deviceId` по-прежнему работает без изменений в renderer.
- [x] **A3.5c** — Перенести portaudio addon из main process в `utilityProcess.fork()` (ADR §3.2). Реализовано: `client/electron/nativeAudio/utilityHost.mjs` грузит addon, держит Pa_Initialize и единственный PA-стрим, MSYS2 PATH-инициализация для libwinpthread переехала туда же. `ipc.js` теперь — тонкий прокси: каждый `ipcMain.handle('audio:*')` шлёт `{kind:'request', id, op, opts}` в utility и резолвится по матчингу `{kind:'reply', id, payload}`; `MessageChannelMain.port1` транзитом передаётся в utility (TSFN endpoint), `port2` — в renderer (data plane utility ↔ renderer напрямую, main PCM не видит). `utility.on('exit', code)` ≠ 0 → broadcast `audio:engine-crashed` во все окна + reject всех pending; respawn ленивый на следующий запрос (без auto-restart, иначе цикл). `preload.js` добавил `onEngineCrashed(handler)` — публичный API расширен additively, существующее не менялось. Renderer API (`window.nativeAudio.*`) и форматы payload/response остались идентичны. Quartet фиксов 33a6bb1 сохранён: TSFN try/catch (addon), `port1.on('close')` теперь в utility, atomics, outputChannels cap, terminateAudio без isStreamActive-guard. Smoke-тест: отдельный «Electron Helper (Utility)» в Task Manager при открытом стриме; `opts.crashMe=true` → `std::abort()` в addon → окно Electron живо, UI работает, engine-crashed приходит в renderer, reinit поднимает движок заново. *(валидировано 2026-05-27: 30 устройств перечислены через утилити (ASIO + WASAPI/EXCLUSIVE + WDMKS + DirectSound + MME), отдельный процесс с `--utility-sub-type=node.mojom.NodeService` виден в Task Manager; WASAPI Shared duplex на BEHRINGER USB AUDIO id=16, inputLatency 6.3 мс / outputLatency 16.9 мс; `setMonitorGain(1.0) → {ok:true}`; `openStream({...,crashMe:true})` → utility exited code=0xC0000005, await вернулся с `{ok:false, error:'engine crashed'}`, `onEngineCrashed` handler в renderer получил `{code:3221226505}`, окно Electron не упало; `reinit()` поднял движок заново, streamId продолжил расти; graceful shutdown через закрытие окна — Electron exit code=0)*
- [x] **A4** — Кодирование каждого захваченного канала в Opus в main process. **A4a (encoder) готово:** libopus v1.5.2 как git submodule; per-channel `OpusEncoder*` создаётся в `openStream` с параметрами `opts.opus = { bitrate, complexity, frameMs }`; PCM аккумулируется в pre-allocated `accumBuf` в PaCallback (без alloc в RT); полный фрейм отправляется через отдельный `g_opusTsfn`, `opus_encode_float()` вызывается на JS-thread (known follow-up: перенести на encoder worker thread); `kind:'opus-out'` пакеты летят renderer-у через тот же `MessageChannelMain`; BigInt `timestampUs` из `Pa_GetStreamInfo`; `preload.js` добавляет `onOpusPacket(h)`, `pushInboundOpus(p)`.
- [x] **A4b** — Decoder сторона (принять Opus-пакет от remote peer → декодировать → вывести на output). Что реализовать: (1) `addon.cc`: `OpusDecoder*` per (peerId, channelId) в `std::map`; новый export `pushInboundOpus(peerId, channelId, sequence, timestampUs, payload: ArrayBuffer)` — создаёт decoder при первом пакете от peer, декодирует (`opus_decode_float`), кладёт PCM в preallocated SPSC ring; jitter buffer — min-heap по sequence, drop пакеты старше порога, PLC (`opus_decode_float(nullptr, 0)`) при пропуске; `PaCallback` output side — читает из всех peer-колец и суммирует (mix) с monitor-PCM перед записью в `out`. (2) `utilityHost.mjs`: `case 'pushInboundOpus'` в dispatcher. (3) `ipc.js`: заменить TODO-stub на реальный `sendRequest('pushInboundOpus', packet)`. (4) `preload.js`: `pushInboundOpus` передаёт ArrayBuffer через port напрямую (не через ipc.js), чтобы избежать extra hop через main. Тест: loopback — encoder output → pushInboundOpus → слышно на output без артефактов. После реализации — отметить `[x] A4` в TASKS.md.
- [x] **A4.5** — Метрики аудио-потока через `audio:get-stats` (ADR §3.3): `xrunCount` (`paInputOverflow`/`paOutputUnderflow` из `PaStreamCallbackFlags`), `dropCount` (когда TSFN `NonBlockingCall` → `napi_queue_full`), `bufferFillPct` (ручной счётчик `g_opusTsfnFill`, очередь 64 слота), `cpuLoad` из `Pa_GetStreamCpuLoad()`. Экспортировано через `addon.getStats()` → `utility op:getStats` → `ipc audio:get-stats` → `preload getStats()`. Счётчики монотонны — UI делает diff. Протестировать: при нормальной нагрузке `xrunCount ≈ 0`, `dropCount ≈ 0`, `cpuLoad < 0.05`.
- [x] **bugfix-post-A4b** — 7 багов найденных при ревью кода после A4b (2026-05-27): (1) нулевой пакет продвигал nextSeq без декодирования — теперь PLC + early-return на len==0; (2) IPC-fallback pushInboundOpus не проверял isStreamActive — добавлен guard; (3) Pa_StopStream возвращаемое значение игнорировалось — теперь логируется; (4) g_opusTsfnFill.store(0) в openStream делал счётчик отрицательным на каждом reinit — убран, счётчик сходится естественно; (5) capture-only режим молча дропал decoded audio — guard на outputChannels==0 в PushInboundOpus; (6) port1 не закрывался при броске u.postMessage — закрывается в catch; (7) комментарий о 2^31-ограничении signed-distance.
- [x] **A5** — Передача Opus-потоков через WebRTC DataChannel (замена MediaStream). Реализовано: `nativeRtcManager.ts` — один `RTCPeerConnection` + `RTCDataChannel('kgb-opus', {ordered:false, maxRetransmits:0})` на каждого пира; бинарный заголовок 13 байт (channelIndex / sequence / timestampHi+Lo big-endian); `nativeAudioController.ts` — синглтон управляет жизненным циклом PortAudio-стрима (loadDevices / openStream / closeStream / reinit / setMonitorGain); `electron.d.ts` — ambient-типизация `window.nativeAudio` для всего renderer. Сигналы обёрнуты в `{_kgbAudio:true}` — роутер в App.tsx разделяет их от SimplePeer-сигналов. Лексикографический tie-break (`mySocketId < peerId`) определяет инициатора оффера. SettingsModal расширен секцией «Native Audio (PortAudio)»: выбор input/output устройства с Host API, buffer size, monitor gain, кнопки Open/Close Stream, бейдж ACTIVE/INACTIVE. *(реализовано 2026-05-27)*
- [x] **A5** — Декодирование входящих Opus-потоков и вывод на output-каналы устройства через PortAudio. DataChannel `onmessage` → `decodePacket` → `window.nativeAudio.pushInboundOpus` → addon decoder (A4b) → PortAudio output. `channelId = String(channelIndex)` — ключ совпадает с addon.cc.
- [x] **A5** — Jitter buffer для компенсации нестабильности сети. Sequence-based min-heap jitter buffer реализован в A4b (addon.cc): drop пакетов старше порога, PLC (`opus_decode_float(nullptr,0)`) при пропуске. DataChannel `ordered:false, maxRetransmits:0` даёт UDP-семантику без head-of-line blocking.
- [x] **A6** — Измерение сквозной задержки round-trip (инструмент → сеть → уши собеседника). `kgb-ctrl` DataChannel (ordered, reliable) per peer; инициатор отправляет ping каждые 2 с, получатель отвечает pong; RTT хранится per peer, доступен через `subscribeRtt()`; PortAudio inputLatencyMs/outputLatencyMs сохраняются из `openStream`/`reinit`, отображаются в SettingsModal; DC RTT badge рядом с WS ping в панели участников. *(реализовано 2026-05-27)*

### Критерий готовности

- [x] Два участника подключаются и слышат друг друга (прототип)
- [ ] Сигнал с гитары/инструмента через ASIO или WASAPI передаётся собеседнику без артефактов
- [x] Задержка сквозного пути ≤ 30 мс на локальной сети
- [x] Пинг отображается у каждого участника
- [x] Приватная комната с паролем работает

---

## Phase 2 — Миксер и запись

**Цель:** участник выбирает аудиоустройство, его каналы автоматически появляются в миксере; инструментальный сигнал записывается на таймлайн без сдвига.

**Оценка:** 3–4 недели

> **Контекст:** A3–A6 закрыты, миксер работает с сигналом, захваченным через PortAudio/ASIO/WASAPI. Pipeline записи живёт в Phase 3 (T2/T3/T5) — Phase 2 владеет **UI**-кнопкой Record и preroll, реальный механизм записи — на таймлайне.

### Задачи

**Выбор аудиоустройства и автоматическое заполнение миксера:**
- [x] Экран / модальное окно выбора аудиоустройства при первом запуске и в настройках *(DeviceSetupModal — появляется при входе в комнату без активного стрима; 2026-06-08)*
- [x] Отображение списка устройств: название, доступные Host API (ASIO / WASAPI / DirectSound), число input/output каналов *(в DeviceSetupModal и SettingsModal; 2026-06-08)*
- [x] Выбор устройства и Host API пользователем; авто-приоритет если не выбрано вручную *(A2 + DeviceSetupModal; авто-выбор в loadDevices(); 2026-06-07/08)*
- [x] После выбора — автоматическое создание input-канала в миксере для каждого физического входа устройства *(LocalMixerStrip рендерится по nativeSnapshot.activeInputChannels при streamActive; 2026-06-08)*
- [ ] Автоматическое создание output-шины для каждого физического выхода устройства *(visual output bus в миксере — отложено)*
- [ ] При смене устройства или Host API — пересоздание каналов миксера с сохранением настроек (fader, mute) где возможно *(сохранение VST-цепочек — V10)*
- [x] Передача по сети только тех input-каналов, которые пользователь явно включил для трансляции (кнопка «Send» на канале) — `nativeRtcManager.sendEnabled` Set + гейтинг в `broadcastOpusPacket`; App.tsx включает ch 0 по умолчанию при открытии стрима

**Мультиканальный миксер** *(Phase 2 Step 2 — в работе)*:

- [x] **M1 — Названия локальных каналов** — при открытии стрима брать имена каналов из метаданных устройства (`device.inputChannelNames[]` или генерировать «Input 1», «Input 2»); пользователь может переименовать; имена хранятся в `localStorage` по ключу `kgb_ch_name_{deviceId}_{channelIdx}`; передавать в `LocalMixerStrip` через проп `label`
- [x] **M2 — Синк метаданных каналов** — новый sync-event `channel_meta: { channelCount: number, channelNames: string[] }` в `syncProtocol.ts`; отправляется при открытии стрима и при изменении send-toggle; сервер пробрасывает всем участникам комнаты; App.tsx хранит `remoteChannelMeta: Map<socketId, { channelCount: number, channelNames: string[] }>`
- [x] **M3 — UI удалённых каналов** — новый компонент `RemoteChannelStrip`; вместо одного `MixerChannel` на пира рендерятся N стрипов (по `remoteChannelMeta[socketId].channelCount`); стрипы визуально сгруппированы под именем участника; `RemoteChannelStrip` принимает `{ peerId, channelIdx, label, socketId }`
- [x] **M4 — Per-channel gain в аддоне** — новый экспорт `addon.setRemoteChannelGain(peerId, channelId, gain)` применяет gain к конкретному каналу пира перед суммированием в PaCallback; цепочка: `addon → utilityHost (op: setRemoteChannelGain) → ipc.js → preload window.nativeAudio.setRemoteChannelGain()`; слайдер `RemoteChannelStrip` вызывает эту функцию; mute = gain 0; `std::atomic<float> gain` в PeerDecState, `g_pendingGains` для setGain до первого пакета *(реализовано 2026-05-30)*
- [x] **M5 — VU-метр удалённых каналов** — расширить `addon.getStats()` полем `remoteChannelLevels: Record<peerId, number[]>` (RMS per channel); поллинг 30fps через `audio:get-stats` → передать в `RemoteChannelStrip` через проп `level`; leaky integrator `lvl = 0.9*lvl + 0.1*frameRms` в PaCallback (pre-gain); `std::atomic<float> rmsLevel` в PeerDecState; App-level setInterval 33ms → `nativeRemoteLevels` state → `peerLevels` prop → `RemoteChannelStrip`; убран устаревший RAF + `mixerEngine.getLevelRms` в `RemoteParticipantGroup` *(реализовано 2026-05-30)*

**Миксер (частично реализован):**
- [x] Input-каналы для каждого участника
- [x] Регулировка громкости (fader) на каждом канале
- [x] Кнопка Mute на каждом канале
- [x] Кнопка Solo на каждом канале
- [x] VU-метр (индикатор уровня сигнала) на каждом канале
- [x] Стерео панорама на каждом канале
- [x] Мастер-шина с компрессором
- [x] Кнопка Record на каждом канале — по нажатию открывает Timeline, запускает полный транспорт (преролл → клик + драм) и пишет дорожку с **бегущей осциллограммой** (peaks ~50/с в клипе, live-обновление durSec); локальный нативный захват → WAV → синк файла, прокси-клип у других *(2026-06-12)*
- [x] Кнопка Send на каждом локальном канале (включить/выключить трансляцию этого канала в комнату) — `LocalMixerStrip` с Send toggle; App.tsx `handleSendToggle` → `nativeRtcManager.setSendEnabled`
- [x] Секция локальных каналов (свои входы устройства) и секция удалённых каналов (входящие от других участников) — `nativeSnapshot.activeInputChannels` (из `NativeAudioSnapshot`) управляет рендером блока Local в миксере
- [ ] Мониторинг латентности аудио на каждом входящем канале (отображение задержки в мс)
- [ ] Send/return шина для общих эффектов комнаты

**VST / InsertChain** *(см. [Архитектурный пивот](#архитектурный-пивот-2026-06-06))*:
- [x] **V1 — VST3 host в utility-процессе** — прямой Steinberg VST3 SDK встроен в `client/electron/nativeAudio/portaudioAddon` (`src/vst/`, флаг `KGB_WITH_VST`, дефолт OFF), живёт в том же `utilityProcess`, что PortAudio. Хост-ядро (HostApplication + IComponent/IAudioProcessor) вызывается из RT-callback через `processChain()` (пустая цепочка = passthrough). Крэш VST → ненулевой выход utility → `engine-crashed` → ленивый respawn (механизм A3.5c, общий — спец-обработки не требует). SDK собран под MinGW/GCC (спайк на Guitar Rig 7 / Piano V2). ADR §6 закрыт.
- [x] **V2 — Сканирование/листинг плагинов** — addon экспортирует `scanVst3(paths[])` → `[{name,vendor,version,type:effect|instrument,subCategories,uid,path}]`; `defaultVst3Paths()`. Проброшено в renderer через `window.nativeAudio.vst.scan`, кэш в `insertChainStore.available`.
- [x] **V3 — Загрузка/выгрузка плагина** — `loadPlugin(path,classUid,sampleRate,maxBlock,slotId)` создаёт инстанс, настраивает RT-процессинг, возвращает дескриптор + список параметров; `unloadPlugin(slotId)`; `getParam`/`setParam`. Проброшено через `window.nativeAudio.vst.*` (control-plane IPC). Заведён `insertChainStore` (логика, не UI). Live round-trip проверен в реальном Electron utilityProcess (scan/load/setParam↔getParam/setInsertChain/unload на Guitar Rig 7). *Замечание:* выгрузка тяжёлого плагина блокирует JS-поток utility на ~1с (холодный кэш — дольше); кандидат на async-teardown в E2.
- [x] **V4 — Открытие нативного окна плагина** — плагин открывается в **собственном OS-окне** (без embed): `openEditor(slotId)`/`closeEditor(slotId)` зовут VST3 `IPlugView` (createView→HWND→attached), окно живёт в utility-процессе. Message pump — `setInterval` в utilityHost гонит `pumpEditor()` на Node-loop (≈60Hz, тот же JS-поток, что создал окно). Проброшено `window.nativeAudio.vst.openEditor/closeEditor` + `insertChainStore`. Проверено вживую в реальном Electron utilityProcess на Guitar Rig 7. Embed в Electron-окно — отдельная задача позже.
- [ ] **V5 — Generic-params UI** — fallback для headless-плагинов: список параметров с типом (float/enum/bool), слайдеры/комбобоксы в нашем React-UI; читаются через `getParam`/`setParam` на дескрипторе слота.
- [x] **V6 — InsertChain (рантайм)** — упорядоченный список slotId на «точке вставки»; addon применяет цепочку in-order в RT-callback. Точка вставки идентифицируется ключом `(target: 'channel'|'track', id: string)`. Per-channel de-interleave→processChain(mono)→re-interleave в PaCallback; глобальные таблицы `g_chanChainSlots[MAX_INPUT_CH][MAX_VST_CHAIN]` (lock-free atomic). `insertChainStore.addInsert/removeInsert/moveInsert/setBypass` → `v.setChannelChain(chIdx, slotIds)` *(2026-06-17)*
- [ ] **V7 — InsertChain (UI)** — единый React-компонент: список инсертов, drag-reorder, кнопка «+», ПКМ→bypass/remove, двойной клик→открыть окно плагина (V4) или generic UI (V5). Переиспользуется в MixerStrip и в Timeline TrackHeader.
- [x] **V8 — InsertChain на канале миксера** — input-канал: `ASIO input → InsertChain → Opus encode → сеть`; собеседники слышат уже обработанный сигнал. Запись на armed-дорожку — тоже обработанная. Выполнено транзитивно через V6: `procIn` применяется ко всему downstream (монитор, PCM TSFN, Opus-энкодер), поэтому пост-VST сигнал идёт в сеть автоматически *(2026-06-17)*
- [x] **V9 — Сохранение/восстановление состояния плагина** — `addon.getPluginState(slotId)` → бинарный preset; кладётся в проектный файл. `IBStream` (WriteStream/ReadStream) поверх `std::vector<uint8_t>`; `getState`/`setState` через `window.nativeAudio.vst.getState/setState`; кэш `InsertSlot.presetData` в сторе; `capturePluginState`/`restorePluginState` в `insertChainStore` *(2026-06-17)*
- [x] **V10 — При смене аудиоустройства/Host API** — пересоздание каналов миксера с сохранением VST-цепочек. Цепочки в C++ static globals выживают `closeStream/openStream` нативно; `resyncAllChains()` в `insertChainStore` вызывается из `nativeAudioController.openStream()`+`reinit()` после успеха для покрытия respawn утилити-процесса *(2026-06-17)*

**Запись — UI-обвязка в Phase 2:** *(сам pipeline — Phase 3 T2/T3/T5; модель: локальный нативный захват → конверт → синк файла → прокси-клип у других до приезда файла)*
- [x] Preroll длительностью из настроек метронома (число тактов перед началом записи) — Record запускает полный плей-флоу: преролл → транспорт → запись; отмена преролла откатывает арм *(2026-06-12)*
- [x] Кнопка вкл/выкл звука метронома (🔊/🔇 в тулбаре, = sync-only): клик играет в общий микс, преролл уважает настройку *(2026-06-12)*
- [x] Play на таймлайне отделён от Play в тулбаре: играет содержимое таймлайна + метроном с playhead, без преролла и без драм-секвенсора *(2026-06-12)*
- [x] Сетка таймлайна синхронизирована с BPM/размером такта — пересчёт при смене (bpm/timeSignature пропы в TimelinePanel) *(2026-06-12)*
- [ ] *(остальное — pipeline записи, MP3, latency compensation — реализуется в Phase 3 T2/T3/T5; здесь не дублируем)*

### Критерий готовности

- [ ] Пользователь выбрал Focusrite Scarlett 2i2 — в миксере автоматически появились «Input 1» и «Input 2»
- [x] Пользователь нажал Send на «Input 1» — остальные участники услышали этот канал и увидели его в своём миксере *(закрыто M2/M3 + Send-toggle)*
- [ ] Сигнал с гитары через ASIO или WASAPI попадает на канал миксера
- [ ] Участник записывает инструмент с VST-обработкой *(требует V8)*
- [x] Аудио попадает на таймлайн без временного сдвига *(Phase 3 T5)*
- [ ] MP3 кодируется в фоне без зависания UI *(Phase 3 T3)*

---

## Phase 3 — Монтажный стол и MIDI

**Цель:** записать, отредактировать и экспортировать полноценный трек. **Piano Roll живёт как редактор миди-клипа на дорожке** (Reaper-style), не как самостоятельная нода. Связи между нодами отсутствуют — за исключением общего проектного транспорта.

**Оценка:** 4–6 недель

> **Зависимости (точечно):**
> - Timeline-скелет уже собран в текущем коде. Здесь — реальная запись, синк, миди-клипы и инструмент дорожки.
> - **T2/T3/T4/T5 + PR1–PR5 + I2** — **не требуют VST**. Базовая запись даёт чистый WAV, барабанные миди-клипы звучат голосами драм-кита.
> - **I1 (InsertChain дорожки)** — переиспользует V6/V7 из Phase 2 (UI/рантайм).
> - **I3 (мелодические клипы)** — требует V8 (VST-инструмент в InsertChain дорожки). Без V8 мелодические клипы не звучат.
> - **«Запись с VST-обработкой»** в acceptance Phase 2 — требует V8 на input-канале.

### Задачи

**Arrange (Timeline) — продолжение существующего скелета:**
- [x] Окно монтажного стола (`TimelinePanel`)
- [x] Аудио-дорожки (структура клипа)
- [x] Временная шкала с зумом и скроллом
- [x] Drag-and-drop клипов, trim, split (через ПКМ-меню и тулбар)
- [x] Undo / Redo (на жестах)
- [x] **T1 — Snap to grid** — привязка клипов и краёв к BPM-сетке (доли / такты), переключаемая *(кнопка ⁞⁞ в тулбаре Timeline; режим Такт/Доля; grid lines в ruler и lanes; 2026-06-08)*
- [x] **T2 — Реальная запись на armed-дорожку** — нативный захват (PortAudio input → buffer) → конверт в WAV → клип на armed-аудиодорожке; пока идёт запись — прокси-клип; по стопу — реальная длительность, proxy:false, blob в clipAudio для экспорта *(recorder.ts; 2026-06-08)*
- [x] **T3 — MP3-кодирование в фоне** — lamejs Web Worker (mp3Encoder.worker.ts), не блокирует UI; ffmpeg-wasm заменён на lamejs (нет SharedArrayBuffer/CDN deps) *(E4, 2026-06-18)*
- [x] **T4 — Синк клипов между участниками** — `clip_add/clip_update/clip_remove` через `syncProtocol`; бинарный WAV через отдельный `clip:file` сокет-event; прокси→реальный при получении файла; hydration для опоздавших участников через `timelineNodes.setPendingTimelineClips` *(2026-06-08)*
- [x] **T5 — Latency compensation** — сдвиг `startSec` клипа назад на `inputLatencyMs / 1000` при disarm; значение берётся из `nativeAudioController.getSnapshot().inputLatencyMs` (заполняется A6 при `openStream`); patch включает `startSec` и транслируется пирам через T4 `clip_update` *(2026-06-08)*

**Piano Roll как редактор миди-клипа:** *(редактор нот клипа на дорожке таймлайна, не самостоятельный модуль)*
- [x] **PR1 — Per-clip note store** — рефактор: ноты живут в `MidiClip`, а не в глобальном `pianoRollStore`. У каждого миди-клипа свой массив `NoteEvent[]`. *(notes?: PianoNote[], clipBars? в TimelineClip; setClipNotes; deep-copy в snap; 2026-06-08)*
- [x] **PR2 — Удаление PianoTransport** — Piano Roll играет от общего `Tone.Transport` проекта, его собственный клок убирается. *(PianoRollPanel — local useState + audioEngine playhead; pianoTransport.ts — dead code; 2026-06-08)*
- [x] **PR3 — Открытие из таймлайна** — двойной клик по миди-клипу → Piano Roll modal с нотами клипа. Контекстное меню «Редактировать ноты…». *(2026-06-08)*
- [x] **PR4 — Piano Roll вне дорожки убран** — нода-источник `piano-roll` удалена из реестра (`BUILTIN_NODES` в `builtins.ts`); кнопка 🎹 Piano убрана из toolbar. Код `pianoRoll/` остаётся — переиспользуется PR3. Селектор «MIDI out →» удалён из `PianoRollPanel.tsx`. *(2026-06-07)*
- [x] **PR5 — Перенос паттерна из Drum в миди-клип** — кнопка «→ Timeline» в DrumMachinePanel; конвертер `drumState → NoteEvent[]` (kick=36, snare=38, hat=42, crash=49); добавляет MIDI-клип с нотами в primaryTimeline. *(2026-06-08)*

**Инструмент дорожки и звук миди-клипа:**
- [x] **I1 — InsertChain на дорожке таймлайна** — `setTrackChain` в vstHost.cc/addon.cc; JS-wiring в insertChainStore.ts (syncTrackChain/resyncAllChains); IPC preload+ipc.js+utilityHost.mjs; electron.d.ts. Chain регистрируется при добавлении VST в track-target. *(E4, 2026-06-18)*
- [x] **I2 — Голос для барабанных клипов (переходный период)** — `midiPlayer.ts`: `scheduleMidiClips(store)` на `Transport.start`; drum pitches (36/38/42/49) → `dm.triggerVoice(track, velocity, time)`; timelineNode.tsx подписывается на 'start'/'dispose'. *(2026-06-08)*
- [x] **I3 — Голос для мелодических клипов** — noteOn/noteOff SPSC-ring в vstHost.cc PluginSlot; дренируется в processChain → Vst::EventList перед process(); Napi VstNoteOn/VstNoteOff/IPC/preload; midiPlayer.ts расписывает ноты через VSTi первого instrument-слота track-chain. *(E4, 2026-06-18)*

**Экспорт:**
- [x] Финальный mixdown в WAV — `mixdown.ts` renderMixdown + encodeWavMono; `exportClip.ts` exportMixdown *(E4, 2026-06-18)*
- [x] Финальный mixdown в MP3 — lamejs worker через encodeMp3 в mixdown.ts *(E4, 2026-06-18)*
- [x] Экспорт проекта (JSON: дорожки/клипы/параметры VST; бинарные пресеты VST base64) — `projectExport.ts` exportProject/downloadProject *(E4, 2026-06-18)*

### Критерий готовности

- [x] Записанный аудио-клип появляется на таймлайне у всех участников (синк T4)
- [x] Двойной клик по миди-клипу открывает Piano Roll, редактирование сохраняется в клип *(PR3, 2026-06-08)*
- [x] Паттерн драм-машины переносится на таймлайн как миди-клип и играется голосами драм-кита *(PR5 + I2, 2026-06-08)*
- [ ] Проект экспортируется в WAV/MP3

---

## Phase 4 — Метроном и драм-машина

**Цель:** все участники слышат метроном и драм-машину синхронно, паттерн экспортируется в MIDI.

**Оценка:** 1–2 недели *(хвост: NTP sync, drift correction; основная функциональность готова)*

> Драм-машина и метроном работают на Web Audio, не зависят от нативного аудиодвижка. NTP-sync/drift — это AUDIT §1.1/§1.3, дорожка Engine, спринт **E3** (см. `SPRINTS.md`).

### Задачи

**Метроном:**
- [x] BPM-контроль (60–240)
- [x] Размер такта (4/4, 3/4, 6/8 и др.) — выбор в транспорте, синхронизирован по комнате
- [ ] Выбор сильной доли
- [x] Длительность preroll (в тактах) в настройках — Off / 1 / 2 / 4 бара, countdown в кнопке Play
- [x] Визуальный клик (мигание интерфейса в такт) — gold на downbeat, crystal на upbeat
- [ ] Режим только sync (звук метронома отключён, сигнал для DAW сохранён)

**Драм-машина:**
- [x] Step sequencer — 4 канала: kick, snare, hat, crash
- [x] 16 шагов по умолчанию
- [x] Встроенные сэмплы (kick, snare, hat, crash)
- [x] Паттерны синхронизированы с BPM комнаты
- [x] Синхронизация паттернов между участниками (LWW)
- [x] Варианты шагов: 8 / 16 / 32 — per-slot, resize сохраняет шаги
- [x] Velocity на каждом шаге — правый клик на шаге, 1–127, визуальная яркость
- [x] Swing / groove параметр — 0–100%, odd-step delay, синхронизирован
- [x] Несколько паттернов с переключением — 8 слотов, bank UI с gold-dot индикатором
- [x] Chaining паттернов — host задаёт цепочку, автопереход в конце паттерна, синхронизирован
- [x] Перенос паттерна → миди-клип на таймлайне *(PR5; кнопка «→ Timeline» реализована 2026-06-08)*

**BPM синхронизация (частично):**
- [x] Единый BPM для всей комнаты (управляет хост)
- [x] BPM синхронизирован с драм-машиной и транспортом
- [ ] NTP-подобная синхронизация тактовой сетки (clock sync)
- [ ] Коррекция дрейфа (drift correction)

### Критерий готовности

- [x] Драм-машина работает и синхронизируется
- [ ] Все участники слышат метроном синхронно *(требует NTP clock sync)*
- [x] Паттерн переносится в миди-клип на таймлайне *(PR5, 2026-06-08)*

---

## Phase 5 — UI и полировка

**Цель:** полный сценарий «репетиция от открытия до экспорта» без ошибок.

**Оценка:** 2–3 недели

> Большая часть UI готова (~60%). Панель настроек аудио уже подключена к A2 (выбор устройства, кнопка Open/Close Stream); добор — Host API UI, Buffer size UI (UI-фасад над готовым бэкендом).

### Задачи

**Стартовый экран:**
- [x] Выбор: создать комнату / присоединиться
- [x] История посещённых комнат — последние 10, быстрый вход одним кликом
- [ ] Открыть сохранённую комнату

**Тулбар:**
- [x] BPM-переключатель (общий для комнаты)
- [x] Запуск / остановка транспорта
- [x] Отдельная кнопка включения/выключения метронома (Click)
- [x] Кнопка настроек метронома — popover с time signature, preroll, sync-only toggle
- [x] Кнопка вызова монтажного стола *(Timeline-нода работает; реальная запись/синк — Phase 3 T-задачи)*
- [x] Кнопка вызова драм-машины *(после G3 — открывается через меню «+» из реестра; быстрая кнопка в тулбаре сохраняется)*

**Чат комнаты:**
- [x] Текстовый мессенджер внутри сессии
- [x] История сообщений на время сессии

**Права участников:**
- [x] Хост может mute любого участника
- [x] Хост может kick (выгнать) участника
- [x] Значки ролей (хост / гость)

**Настройки аудио** *(заготовка UI — данные подключаются после A2)*:
- [x] Экран выбора аудиоустройства (доступен при запуске и из настроек)
- [x] Список устройств: название, доступные Host API, число каналов
- [x] Выбор активного устройства
- [ ] Выбор Host API для устройства: авто / ASIO / WASAPI Exclusive / WASAPI Shared / DirectSound *(UI-фасад над A2 — бэкенд авто-выбора живёт там же)*
- [ ] Настройка размера буфера (buffer size) *(UI-фасад над A3 — addon уже принимает параметр)*
- [x] Выбор формата записи (WAV / MP3)
- [x] Кнопка «Переинициализировать устройство» без перезапуска приложения

**Стабильность:**
- [ ] Автосохранение состояния комнаты
- [ ] Защита от потери данных при крэше
- [ ] Нагрузочное тестирование: комнаты на 4–8 участников
- [ ] Корректная обработка отключения/переподключения аудиоустройства во время сессии

**Визуальный дизайн (реализован):**
- [x] Тёмная тема (Persian Luxury Cyber: чёрный / графит / золото / кристалл)
- [x] Design tokens (CSS переменные)
- [x] Адаптивная вёрстка
- [x] Активный говорящий (gold glow на тайле)

**MIDI-инпут с внешнего устройства** *(низкий приоритет, в самом конце разработки — не критично для основной функциональности)*:
> Делается **после** того, как Phase 2/3 (VST, InsertChain, миди-клипы, Piano Roll-as-editor) стабильны. Не блокирует ничего из основного пути.

- [ ] **MI1 — Развилка: транспорт MIDI** *(решается при подходе к реализации, не сейчас)* — WebMIDI API (нативно в Chromium/Electron, достаточно для большинства USB-MIDI устройств) **vs** нативный PortMidi-bridge через addon (низкая задержка, поддержка устройств за пределами WebMIDI). API в JS-стороне одинаков (`NoteEvent`), решение изолировано от VST-хоста и InsertChain.
- [ ] **MI2 — Перечисление MIDI-устройств** — `navigator.requestMIDIAccess()` (WebMIDI) или `addon.listMidiInputs()` (PortMidi); список в тулбаре «+» → «Add MIDI Input».
- [ ] **MI3 — MIDI-канал в миксере (новый тип strip)** — у канала есть тип `audio | midi`; MIDI-strip визуально как обычный, но без peak-meter (level-meter показывает note-activity), с obligatory instrument-slot
- [ ] **MI4 — Instrument slot на MIDI-канале** — один VST3-инструмент (через InsertChain V3) **или** встроенный синт-заглушка до подключения VST; MIDI → instrument → audio → mixer master.
- [ ] **MI5 — Arm в выделенный клип** — toggle «record arm» на MIDI-канале: входящие NoteEvent пишутся в выделенный клип armed-миди-дорожки таймлайна.
- [ ] **MI6 — Индикатор активности** — visual blink на MIDI-strip при входящих нотах.

### Критерий готовности

- [ ] Полный сценарий: открыть → выбрать устройство → создать комнату → репетиция → запись → экспорт
- [ ] Нет потери данных при обрыве и переподключении
- [ ] Комната с 4 участниками стабильна

---

## Дополнительные фичи

| # | Фича | Статус |
|---|---|---|
| А | Чат комнаты | [x] Готово |
| Б | Права участников (mute / kick хостом) | [x] Готово |
| В | Latency compensation при записи | [ ] Phase 2 |
| Г | Solo в миксере | [x] Реализован |
| Д | Velocity на шагах драм-машины | [x] Готово |
| Е | Индикатор пинга участников | [x] Готово |
| Ж | Swing/groove в драм-машине | [x] Готово |
| З | Визуальный клик метронома | [x] Готово |
| И | Экспорт проекта (mixdown) | [ ] Phase 3 |
| К | Автосохранение состояния комнаты | [ ] Phase 5 |
| **A7** | **Dual-stream: ASIO input + WASAPI output на разных устройствах** — два независимых `Pa_OpenStream`, SPSC ring buffer между RT-потоками, компенсация clock drift (PID-контроль заполненности + линейная интерполяция / r8brain). Нужно когда пользователь хочет ASIO-интерфейс для инструмента, но слушает через обычные USB-наушники или встроенную карту. Реализуется аддитивно поверх существующего API (`secondaryOutputDeviceId` в opts). Отложено до конца разработки, когда понятно какие устройства реально используют музыканты. | [ ] После A6 |

---

## Технический стек

| Слой | Технология | Статус |
|---|---|---|
| Оболочка | Electron (Windows / macOS / Linux) | [x] Работает |
| UI | React + TypeScript + Vite | [x] Работает |
| Аудиодвижок (базовый) | Web Audio API + Tone.js | [x] Работает (прототип) |
| Аудиодвижок (нативный) | PortAudio — ASIO / WASAPI / DirectSound / MME (Win), CoreAudio (macOS), ALSA / JACK (Linux) | [~] A3–A3.5c готовы; **A4a готово** — libopus v1.5.2 (git submodule, BSD-3), per-channel `OpusEncoder*`, PCM-аккумуляция без alloc в RT, TSFN → `kind:'opus-out'` → renderer, `onOpusPacket` / `getStats` / `pushInboundOpus` в preload; **A4.5 готово** — `audio:get-stats` (xrunCount, dropCount, bufferFillPct, cpuLoad); A4b decoder отложен |
| Аудиотранспорт (нативный) | Opus через WebRTC DataChannel (замена `getUserMedia`) | [x] **A5 готово** — `nativeRtcManager.ts`: RTCPeerConnection + DataChannel per peer, бинарный заголовок 13 байт, UDP-семантика (ordered:false, maxRetransmits:0), signal routing через `_kgbAudio` флаг; **A6 готово** — `kgb-ctrl` ping-pong RTT per peer (ordered, reliable), `subscribeRtt()`, PortAudio In/Out latency в SettingsModal |
| VST-хостинг | VST3 SDK (или JUCE) в `utilityProcess` рядом с PortAudio; UI плагина — в собственном OS-окне (без embed в Electron, MVP) | [~] V1/V2/V3/V4/V6/V8/V9/V10 ✅ (E1+E2); V5/V7 (nik N4) `[ ]` |
| Сеть (signalling) | WebRTC + Socket.IO | [x] Работает |
| MIDI | WebMIDI API **или** нативный PortMidi-bridge — развилка MI1, решается при подходе к реализации | [ ] Phase 5 (низкий приоритет) |
| Кодирование | ffmpeg-wasm (фоновый воркер) | [ ] Не начат |

---

## Общий прогресс

| Фаза | Прогресс |
|---|---|
| Phase 1 — Сеть и комнаты | ~98% *(A1–A6 + A2 авто-выбор + перечисление каналов готовы; acceptance — гитара через ASIO end-to-end)* |
| Phase 2 — Миксер и запись | ~65% *(M1–M5 + Send-toggle готовы; V1/V2/V3/V4/V6/V8/V9/V10 VST/InsertChain готовы (E1+E2); V5/V7 у nik (N4); остаток: output-шина, при смене устройства сохранение fader/mute, buffer-size UI)* |
| Phase 3 — Монтажный стол и MIDI | ~60% *(T1–T5 + PR1–PR5 + I2 — готово (Спринт 3–4); впереди I1 InsertChain дорожки, I3 мелодика, экспорт)* |
| Phase 4 — Метроном и драм-машина | ~85% *(перенос паттерна в миди-клип готов (PR5); остаток: NTP sync, drift correction)* |
| Phase 5 — UI и полировка | ~60% *(SettingsModal Native Audio реализован; MIDI-инпут MI1–MI6 — в конце разработки, низкий приоритет)* |

---

*KGB Sound TASKS.md — panels-first; нодовый граф удалён 2026-06-14 (см. REFACTOR_PLAN.md).*

> **UI:** panels-first — каждый модуль самодостаточная плавающая панель (`client/src/panels/`). Нодовый граф и Canvas удалены 2026-06-14 (см. `REFACTOR_PLAN.md`). Аудио-маршрутизация — DAW-модель track→VST→mixer.
