# ADR — Native Audio Engine для KGB Sound System 85

- **ID:** ADR-001
- **Статус:** Accepted
- **Дата:** 2026-05-24
- **Контекст задачи:** TASKS.md → Phase 1 → Stream A → **A1**
- **Связанные документы:** `kgb_sound_system_85_application_architecture_v_2.md` §9, §12, §17

---

## 1. Контекст

Текущий аудиотранспорт построен на `navigator.mediaDevices.getUserMedia` + WebRTC `MediaStream`. Это прототип, у которого:

- латентность 50–150 мс (несовместимо с целевыми ≤ 30 мс из §2 архитектуры);
- нет доступа к ASIO/WASAPI Exclusive;
- нет многоканальной маршрутизации (Focusrite 18i20 со всеми восемью входами увидеть нельзя);
- нет управления buffer size.

Stream A блокирует Phase 2 (mixer / запись) и Phase 3 (timeline). До закрытия A3 нельзя двигаться дальше.

В рамках A1 нужно выбрать **bridge-стратегию** между Electron main process и PortAudio:

| Вариант | Что это |
|---|---|
| **naudiodon** (npm) | Готовый PortAudio wrapper, N-API, есть прецеденты с Electron |
| **node-addon-api + PortAudio C++ from scratch** | Свой нативный модуль; полный контроль над PortAudio, Opus, ASIO SDK |

---

## 2. Решение

**Принят гибридный двухшаговый подход:**

1. **Шаг 1 — Spike (1 неделя, throwaway)**
   Использовать `naudiodon` (актуальный форк `naudiodon2`) **только** для валидации сборочной цепочки:
   - `electron-rebuild` корректно собирает нативный модуль под текущую Electron 42 ABI;
   - IPC main → preload → renderer работает с PCM-данными;
   - перечисление устройств / WASAPI Shared capture функционируют end-to-end;
   - можно открыть стрим, прочитать PCM, увидеть уровень в renderer.
   Эта часть кода **не идёт в продакшен** и удаляется в конце A2.

2. **Шаг 2 — Production binding (основная работа A2–A6)**
   Свой нативный addon на `node-addon-api`, который инкапсулирует:
   - PortAudio (собирается из исходников вместе с ASIO/WASAPI/WDM-KS бэкендами);
   - `libopus` encoder/decoder;
   - lock-free SPSC ring buffer между audio thread и worker thread;
   - jitter buffer для входящих пакетов.
   Этот модуль становится **единственным** native bridge в продакшен-сборке.

### Обоснование

| Аргумент | Почему важно для KGB85 |
|---|---|
| **ASIO обязателен** | TASKS.md ставит цель ≤ 30 мс end-to-end. На Windows без ASIO эта планка недостижима, а `naudiodon` поставляется без ASIO из-за лицензии Steinberg. PortAudio с ASIO нужно собирать самим — а раз приходится собирать, разумнее владеть всем addon целиком. |
| **Многоканальность** | Focusrite 18i20: 8 input-каналов, каждый должен быть отдельным Opus-стримом с независимым «Send». API `naudiodon` это не выражает напрямую — оно ориентировано на пары stereo. |
| **Opus в C++** | Если PCM каждые 64 сэмпла будет пересекать JS-границу, мы заплатим тысячи IPC/сек. Кодирование в том же addon оставляет в JS только Opus-пакеты (~50/сек/канал). |
| **Контроль за upstream-риском** | Один мейнтейнер `naudiodon2` ≠ устойчивость. Свой addon = нет блокеров от чужого release cycle. |
| **Spike оправдан** | Самый неприятный риск — Electron + native module pipeline не собирается под Windows у новых разработчиков. Spike ловит это за неделю и не на C++. |

### Что отвергнуто

- **Только `naudiodon` до конца Phase 1** — упрёмся в отсутствие ASIO к моменту A4, выкинем полученный код.
- **Сразу свой addon, без spike** — есть риск 3–4 недели писать на C++ и упереться в `electron-rebuild` / ABI / sandbox-загрузку. Spike стоит дешевле, чем такая ошибка.
- **Web Audio через `AudioWorklet` + `MediaStreamTrackProcessor`** — браузерный путь, не даёт ASIO и многоканальности, нарушает архитектуру §9.

---

## 3. Архитектура IPC: Main ↔ Renderer

### 3.1. Граница процессов

```
┌────────────────────────────── ELECTRON MAIN PROCESS ──────────────────────────────┐
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │  utilityProcess (изолирован от main — если упадёт, UI жив)                  │  │
│  │                                                                             │  │
│  │  portaudioAddon.node  (наш N-API модуль)                                    │  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                     │  │
│  │  │ PortAudio    │   │ SPSC ring    │   │ libopus      │                     │  │
│  │  │ callback     │──▶│ buffer       │──▶│ encoder      │                     │  │
│  │  │ (RT thread)  │   │ (no malloc)  │   │ (worker thr) │                     │  │
│  │  └──────────────┘   └──────────────┘   └──────┬───────┘                     │  │
│  │                                               │                             │  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────▼───────┐                     │  │
│  │  │ PortAudio    │◀──│ jitter       │◀──│ libopus      │                     │  │
│  │  │ output cb    │   │ buffer       │   │ decoder      │                     │  │
│  │  └──────────────┘   └──────────────┘   └──────────────┘                     │  │
│  │         ▲                                     ▲                             │  │
│  │         │ inbound PCM                         │ inbound Opus packets        │  │
│  └─────────┼─────────────────────────────────────┼─────────────────────────────┘  │
│            │                                     │                                │
│            │      MessagePortMain (бинарный канал, transferable ArrayBuffer)      │
│            ▼                                     │                                │
│  ┌─────────────────────────── main.js ──────────────────────────────────────────┐ │
│  │  - lifecycle utilityProcess                                                  │ │
│  │  - ipcMain.handle('audio:*') ← invoke от renderer                            │ │
│  │  - порт MessagePort пробрасывается в renderer через postMessage              │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                   │
└─────────────────────────────────────┬─────────────────────────────────────────────┘
                                      │
                                      │ ipcRenderer (control plane)
                                      │ MessagePort  (data plane — Opus, levels)
                                      ▼
┌──────────────────────────── RENDERER PROCESS ──────────────────────────────┐
│                                                                            │
│  preload.js  (contextIsolation: true, sandbox: false для preload only)     │
│  contextBridge.exposeInMainWorld('kgbAudio', api)                          │
│                                                                            │
│  React / rtc / mixer                                                       │
│  ─ window.kgbAudio.listDevices()                                           │
│  ─ window.kgbAudio.openStream({ ... })                                     │
│  ─ window.kgbAudio.onOpusPacket(handler)  ── data plane через MessagePort  │
│  ─ window.kgbAudio.onLevel(handler)                                        │
│  ─ window.kgbAudio.pushInboundOpus(peerId, channelId, packet)              │
│                                                                            │
│  rtc/ — пересылает window.kgbAudio.onOpusPacket → DataChannel.send         │
│  rtc/ — принимает DataChannel.onmessage → window.kgbAudio.pushInboundOpus  │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.2. Почему utilityProcess, а не сам main

`app.requireNonNullable` style рассуждение: PortAudio callback работает в RT-потоке, любая ошибка в C++ → segfault → весь процесс падает. Если addon в main, падает всё окно. Electron 28+ предоставляет `utilityProcess.fork()`, который изолирует нативный модуль; main общается с ним через `MessagePortMain`. Это даёт нам:

- падение audio engine ≠ потеря UI и комнаты;
- возможность перезапустить движок без перезапуска приложения (требование §A3);
- ASIO driver enumeration (известный источник BSOD на старых драйверах) изолируется.

### 3.3. Control plane — `ipcMain.handle` / `ipcRenderer.invoke`

Низкочастотные запросы из renderer (типовые единицы в секунду). Все payloads — JSON-сериализуемые.

| Канал | Направление | Payload | Ответ |
|---|---|---|---|
| `audio:list-devices` | R→M | `{}` | `DeviceDescriptor[]` |
| `audio:open-stream` | R→M | `OpenStreamRequest` | `{ ok: true, streamId } \| { ok: false, error }` |
| `audio:close-stream` | R→M | `{ streamId }` | `{ ok }` |
| `audio:set-send` | R→M | `{ channelIndex, enabled }` | `{ ok }` |
| `audio:set-monitor-gain` | R→M | `{ channelIndex, gainDb }` | `{ ok }` |
| `audio:reinit` | R→M | `OpenStreamRequest` | `{ ok }` *(см. требование §A3)* |
| `audio:get-stats` | R→M | `{}` | `{ xrunCount, bufferFillPct, cpuLoad }` |

```ts
type DeviceDescriptor = {
  id: string                 // PortAudio device index, stringified
  name: string
  hostApis: HostApiInfo[]    // ASIO, WASAPI-Exclusive, WASAPI-Shared, ...
  maxInputChannels: number
  maxOutputChannels: number
  defaultSampleRate: number
}

type HostApiInfo = {
  kind: 'ASIO' | 'WASAPI_EXCLUSIVE' | 'WASAPI_SHARED' | 'DirectSound' | 'MME' | 'CoreAudio' | 'ALSA' | 'JACK'
  recommendedBufferSizes: number[]   // в сэмплах: [64, 128, 256, ...]
  minLatencyMs: number
}

type OpenStreamRequest = {
  deviceId: string
  hostApi: HostApiInfo['kind']
  sampleRate: 48000 | 44100
  bufferSize: number          // сэмплов на буфер (ASIO: 64 предпочтительно)
  inputChannels: number[]     // индексы физических входов
  outputChannels: number[]    // индексы физических выходов
  opus: { bitrate: number; complexity: number; frameMs: 10 | 20 }
}
```

### 3.4. Data plane — `MessagePortMain` с transferable ArrayBuffer

`ipcRenderer.invoke` копирует payload через structured clone — для 50 пакетов/сек/канал × N каналов × N peers это создаст давление на event loop. Решение: один раз при `audio:open-stream` main создаёт `MessageChannelMain`, отдаёт один порт в utilityProcess, второй пробрасывает в renderer через `webContents.postMessage('audio:port', null, [port])`. Дальше bulk-данные летят минуя `ipcMain`/`ipcRenderer`.

Через этот порт ходят:

```ts
type OutboundOpusPacket = {
  kind: 'opus-out'
  channelIndex: number
  sequence: number       // u32, монотонный per-channel
  timestampUs: bigint    // PortAudio stream time, для latency compensation
  payload: ArrayBuffer   // transferable — без копирования
}

type LevelUpdate = {
  kind: 'level'
  channelIndex: number
  rmsDb: number          // -∞ .. 0
  peakDb: number
}

type EngineState = {
  kind: 'state'
  status: 'running' | 'stopped' | 'xrun' | 'error'
  detail?: string
}

type InboundOpusPacket = {
  kind: 'opus-in'
  peerId: string
  channelId: string      // peer's channel identifier
  sequence: number
  timestampUs: bigint
  payload: ArrayBuffer   // transferable
}
```

`InboundOpusPacket` идёт **в обратную сторону**: renderer получил пакет с DataChannel — пушит в порт — utilityProcess декодирует и проигрывает.

### 3.5. preload bridge — contextBridge

```js
// client/electron/nativeAudio/preload.js
import { contextBridge, ipcRenderer } from 'electron'

let audioPort = null
const outHandlers = new Set()
const levelHandlers = new Set()
const stateHandlers = new Set()

ipcRenderer.on('audio:port', (event) => {
  audioPort = event.ports[0]
  audioPort.onmessage = (ev) => {
    const msg = ev.data
    if (msg.kind === 'opus-out') outHandlers.forEach((h) => h(msg))
    else if (msg.kind === 'level') levelHandlers.forEach((h) => h(msg))
    else if (msg.kind === 'state') stateHandlers.forEach((h) => h(msg))
  }
  audioPort.start()
})

contextBridge.exposeInMainWorld('kgbAudio', {
  listDevices: () => ipcRenderer.invoke('audio:list-devices'),
  openStream: (req) => ipcRenderer.invoke('audio:open-stream', req),
  closeStream: (id) => ipcRenderer.invoke('audio:close-stream', { streamId: id }),
  reinit: (req) => ipcRenderer.invoke('audio:reinit', req),
  setSend: (channelIndex, enabled) =>
    ipcRenderer.invoke('audio:set-send', { channelIndex, enabled }),
  setMonitorGain: (channelIndex, gainDb) =>
    ipcRenderer.invoke('audio:set-monitor-gain', { channelIndex, gainDb }),
  getStats: () => ipcRenderer.invoke('audio:get-stats'),

  onOpusPacket: (h) => { outHandlers.add(h); return () => outHandlers.delete(h) },
  onLevel: (h) => { levelHandlers.add(h); return () => levelHandlers.delete(h) },
  onEngineState: (h) => { stateHandlers.add(h); return () => stateHandlers.delete(h) },

  pushInboundOpus: (packet /* InboundOpusPacket */) => {
    if (!audioPort) return false
    audioPort.postMessage(packet, [packet.payload])
    return true
  },
})
```

### 3.6. Изменения в `main.js`

В существующем `client/electron/main.js` сейчас стоит `sandbox: true`. Preload, использующий `MessagePort`, требует `sandbox: false`. Это допустимо: `contextIsolation: true` и `nodeIntegration: false` сохраняются, а сам renderer всё равно без Node-доступа. Менять флаги нужно одной строкой, и закрепить причину комментарием рядом с `webPreferences` (см. правила CLAUDE.md — комментарии только когда «почему» не очевидно).

```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,  // preload требует MessagePort/transferables для audio data plane
  preload: join(__dirname, 'nativeAudio/preload.js'),
}
```

---

## 4. Зависимости сборки

### 4.1. Windows (основная платформа)

| Компонент | Версия | Источник |
|---|---|---|
| Visual Studio Build Tools | 2022, workload «Desktop development with C++» (MSVC v143) | Microsoft |
| Windows 11 SDK | 10.0.22621+ | через VS Installer |
| Python | 3.11.x | nodejs.org или python.org |
| node-gyp | ^10 | `npm i -g node-gyp` |
| @electron/rebuild | ^3.7 | dev-dep клиента |
| prebuildify + prebuildify-cross | latest | dev-dep, для CI |
| **ASIO SDK** | 2.3.3 | Steinberg (см. §6 Риски) |
| **PortAudio** | v19.7.0+ | `third_party/portaudio` git submodule (commit pinned) |
| **libopus** | 1.4+ | `third_party/opus` git submodule (commit pinned) |

`binding.gyp` собирает PortAudio с флагами:
```
PA_USE_ASIO=1
PA_USE_WASAPI=1
PA_USE_WDMKS=1
PA_USE_DS=1
PA_USE_WMME=1
```

ASIO SDK подключается через `<(asio_sdk_dir)` — переменная читается из `process.env.KGB_ASIO_SDK_DIR`. Если её нет, сборка валится с понятной ошибкой и ссылкой на `scripts/fetch-asio-sdk.ps1`.

### 4.2. macOS (вторичная)

| Компонент | Версия |
|---|---|
| Xcode Command Line Tools | latest |
| CoreAudio.framework | системный, link-only |
| (ASIO не применяется) | — |

### 4.3. Linux (вторичная)

| Компонент | Пакет |
|---|---|
| ALSA dev headers | `libasound2-dev` |
| (опционально) JACK | `libjack-jackd2-dev` |
| build-essential | gcc/g++ ≥ 11 |

### 4.4. Изменения в `client/package.json`

```jsonc
{
  "dependencies": {
    "@kgb/portaudio-addon": "file:./electron/nativeAudio/portaudioAddon"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.7.0",
    "node-addon-api": "^8.0.0",
    "prebuildify": "^6.0.0",
    "node-gyp": "^10.2.0"
  },
  "scripts": {
    "rebuild:native": "electron-rebuild -f -w @kgb/portaudio-addon",
    "postinstall": "npm run rebuild:native"
  }
}
```

`@electron/rebuild` запускается в `postinstall`, чтобы любая `npm install` сразу пересобирала addon под текущий Electron ABI. Для CI/выпуска — `prebuildify` создаёт бинарники в `prebuilds/`, electron-builder включает их в `dist/`.

---

## 5. Структура файлов `client/electron/nativeAudio/`

```
client/electron/nativeAudio/
├── README.md                          // build-инструкция, как получить ASIO SDK
├── preload.js                         // contextBridge → window.kgbAudio
├── ipc.js                             // main-side: ipcMain.handle('audio:*'),
│                                      // создание utilityProcess, проброс MessagePort
├── types.d.ts                         // TS-декларации для window.kgbAudio
├── utilityHost.mjs                    // entry для utilityProcess.fork():
│                                      // загружает addon, держит MessagePort,
│                                      // транслирует события audio thread ↔ port
├── portaudioAddon/                    // ── С++ нативный модуль
│   ├── package.json                   // name: "@kgb/portaudio-addon", main: "index.js"
│   ├── binding.gyp                    // node-gyp build config
│   ├── index.js                       // require('node-gyp-build')(__dirname)
│   ├── src/
│   │   ├── addon.cc                   // napi_module init, экспорт классов/функций
│   │   ├── engine.h | engine.cc       // RAII над Pa_OpenStream, lifecycle
│   │   ├── deviceEnumerator.cc        // Pa_GetDeviceInfo / Pa_GetHostApiInfo
│   │   ├── audioCallback.cc           // PaStreamCallback, RT-safe
│   │   ├── ringBuffer.h               // header-only lock-free SPSC ring
│   │   ├── encoderWorker.cc           // worker thread: ring → libopus → port
│   │   ├── decoderWorker.cc           // worker thread: inbound queue → libopus → ring
│   │   ├── jitterBuffer.h | .cc       // re-order по sequence, drop-too-late
│   │   ├── levelMeter.cc              // RMS/peak, throttled 30 Hz
│   │   └── napiBridge.cc              // ThreadSafeFunction → JS events
│   ├── third_party/
│   │   ├── portaudio/                 // git submodule
│   │   ├── opus/                      // git submodule
│   │   └── ASIOSDK2.3.3/              // NOT committed; путь из env
│   └── prebuilds/                     // prebuildify output, в .gitignore
└── scripts/
    ├── fetch-asio-sdk.ps1             // диалог: укажи путь / открой Steinberg
    ├── rebuild.ps1                    // electron-rebuild wrapper с диагностикой
    └── verify-toolchain.ps1           // проверяет MSVC, Python, node-gyp
```

`utilityHost.mjs` важен потому, что addon живёт не в main, а в дочернем `utilityProcess`. main только пробрасывает порт, ловит crash, перезапускает.

Интеграция с существующим кодом:
- `client/src/rtc/` подписывается на `window.kgbAudio.onOpusPacket` и пересылает в DataChannel;
- `client/src/mixer/` подписывается на `window.kgbAudio.onLevel` для VU-метров локальных каналов;
- старый `getUserMedia`-путь оборачивается флагом `USE_NATIVE_AUDIO` (см. §6.2).

---

## 6. Риски и план отката

### 6.1. Риски

| # | Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|---|
| R1 | ASIO SDK нельзя коммитить (Steinberg License запрещает редистрибуцию) | Высокая (это факт) | Среднее | SDK не в репозитории. `scripts/fetch-asio-sdk.ps1` ведёт разработчика через регистрацию у Steinberg. CI хранит SDK в защищённом артефакт-реестре, монтирует в build-job. README документирует. |
| R2 | Electron major upgrade (42 → 43) ломает ABI native modules | Средняя | Высокое | `prebuildify` matrix по Electron ABI; `postinstall: electron-rebuild`. Заморозить версию Electron до окончания Phase 1. |
| R3 | Старые ASIO-драйверы вызывают BSOD при enumeration | Низкая, но катастрофическая | Высокое | Enumeration в `utilityProcess`. Whitelist известных проблемных драйверов с предупреждением в UI. |
| R4 | Лицензия libopus (BSD-3) vs наша лицензия — конфликта нет, но указать в NOTICE | Низкая | Низкое | Добавить NOTICE-файл с атрибуциями PortAudio (MIT-style) и libopus (BSD-3). |
| R5 | Sandbox: false для preload расширяет attack surface | Низкая (renderer всё равно `nodeIntegration: false`) | Среднее | Preload минимальный, только bridge. Никакого `fs`/`child_process` в preload. Code review на каждое изменение `preload.js`. |
| R6 | macOS/Linux пути отстают и провалят cross-platform claims | Высокая | Среднее | Документировать «Windows-first» в README. macOS/Linux после A6 на Windows. |
| R7 | Spike на `naudiodon` показывает несовместимость с Electron 42 ABI | Средняя | Высокое (рушит план шага 1) | Если spike не идёт за 3 дня — пропускаем шаг 1, идём сразу на свой addon. Spike — таймбокс, не бесконечный. |
| R8 | Audio-thread leaks или malloc внутри callback → xrun | Средняя | Высокое | RT-safety code review: preallocate всё в `Pa_OpenStream`, без `new`/`malloc` в callback. Auto-test: 60 секунд capture с проверкой `xrunCount == 0`. |
| R9 | IPC backpressure при 8 каналах × N peers | Низкая | Среднее | MessagePort с transferable ArrayBuffer (zero-copy). Метрика `bufferFillPct` через `audio:get-stats`. |
| R10 | Spike-код наудионы случайно попадает в продакшн | Средняя | Низкое | Пометить spike-ветку как `spike/A1-naudiodon`, явный TODO в shutdown задаче A2. |

### 6.2. План отката

Отказ от нативного движка должен быть возможным в любой точке Phase 1, потому что Phase 1 уже даёт работающий прототип (getUserMedia). План:

1. **Feature flag.** Ввести `USE_NATIVE_AUDIO` в `client/src/audio/config.ts`. По умолчанию `false`, переключается на `true` начиная с A3.
2. **Параллельные пути.** До закрытия A6 НЕ удалять `getUserMedia` / `MediaStream` ветку из `client/src/rtc/`. Старый код-путь остаётся живым, переключается флагом.
3. **Триггеры отката:**
   - R1 (ASIO SDK недоступен) — оставить только WASAPI Exclusive путь, ASIO выключить. Цель ≤ 30 мс становится «best effort», аудит в TASKS.md.
   - R2 (Electron ABI conflict) — отложить миграцию Electron, заморозить версию до окончания A6.
   - R7 (spike провалился) — пропустить шаг 1, идти сразу на свой addon с +1 неделей риска.
   - Полный провал (addon крашится систематически) — `USE_NATIVE_AUDIO=false`, продолжать на прототипе, открыть новое ADR с альтернативой (например, miniaudio как замена PortAudio).
4. **Точка невозврата.** После закрытия A6 + 2 недели стабильности на канареечных тестерах — удалить `getUserMedia` ветку и обновить архитектурный документ (§12 уже описывает финальное состояние).
5. **Откат данных не требуется.** Native engine не пишет в persistent state до Phase 2 (запись). До тех пор откат — это просто смена флага.

---

## 7. Связь с TASKS.md

| Stage | Что закрывает это ADR |
|---|---|
| A1 | Полностью (это его deliverable) |
| A2 | Определяет, в каком модуле жить enumeration / Host API selection |
| A3 | IPC-схема data plane, lifecycle через `utilityProcess`, требование reinit без перезапуска приложения |
| A4 | libopus встроен в тот же addon, не отдельный npm |
| A5 | DataChannel в renderer; `pushInboundOpus` / `onOpusPacket` — точки интеграции |
| A6 | `timestampUs` в обе стороны — основа для round-trip latency measurement |

---

## 7.1. E5 — реализация worker-thread (2026-06-19)

Спринт **E5** довёл RT-safety до исходного замысла этого ADR (§2 «lock-free SPSC
ring между audio thread и worker thread», §5 `encoderWorker.cc`/`decoderWorker.cc`)
и закрыл **AUDIT §9.A.1** (malloc/new в RT-колбэке) и **§1.5** (Opus encode+decode
на одном JS-потоке utility). Реализовано целиком в `addon.cc` (а не отдельными
файлами `*.cc` из §5 — единый модуль удобнее для общих atomics):

- Один `std::thread` на процесс (`opusWorkerMain`), запускается в `Init`,
  join через `env.AddCleanupHook` (joinable-глобал не роняет `std::terminate`).
- **Encode:** RT-колбэк копирует готовый Opus-фрейм в lock-free SPSC `g_encRing`
  (без malloc); worker зовёт `opus_encode_float()` и доставляет пакет в JS через
  `g_opusTsfn`.
- **PCM tap:** RT пишет сырой блок в SPSC `g_pcmRing`; worker отдаёт его в
  `g_pcmTsfn` (recorder/VU) — второй malloc из RT тоже убран.
- **Decode:** `pushInboundOpus` (JS) только кладёт пакет в `g_decodeQueue`; worker
  гоняет jitter-buffer + `opus_decode_float()` и пишет в per-peer `PeerRing`
  (RT-потребитель не изменился).
- **Sync:** `g_opusMx` сериализует использование кодеков воркером против их
  создания/уничтожения (open/closeStream) и Release TSFN — RT-поток мьютекс не
  трогает (только lock-free кольца). Поколение потока (`g_streamGen`) в каждом
  слоте кольца защищает reinit от ABA при переиспользовании указателя энкодера
  (усиление фикса §2.1).
- **Верификация (R8):** пересборка `build:asio` (VST+ASIO ON) чистая; live-тест в
  Electron-ABI duplex WASAPI@48k — `onPcm`/`onOpus` текут, **xrunCount == 0,
  dropCount == 0**; reinit и loopback-decode (144 пакета → 2 peer-канала)
  проходят; процесс выходит с кодом 0 (worker join без зависания).

R8 («malloc в callback → xrun») — закрыт.

---

## 8. Открытые вопросы (для следующих ADR)

- **VST-хостинг** (Phase 2) — JUCE/VST3 SDK будет жить в том же addon или отдельным? Откладывается до Phase 2 kick-off.
- **MIDI bridge** (Phase 3) — отдельный native module или интеграция через PortMidi в наш addon? Откладывается.
- **Clock sync / NTP** (Phase 4) — требует timestamp из audio thread; addon уже его предоставляет (`timestampUs`), детальный протокол — отдельный ADR.
