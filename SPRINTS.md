# KGB Sound System 85 — SPRINTS.md

Action plan + paste-ready prompts for both contributors. Boundary, contract and
merge rules live in **`AGENTS.md`** (§ "Two-contributor split"). This file is the
ordered, actionable version.

**Two tracks run in parallel. Every file has one owner — never edit across the line.**

- **Engine track** (Ivan + assistant): native addon / audio engine / VST host.
- **UI+Server+Sync track** (nik): all `.tsx`, `server/`, sync layer.

Each prompt is self-contained (cold session). Always: branch off `main`, push,
merge to `main`, the other does `git pull --rebase` daily. Rebuild locally
(addon `*.node` and VST3 SDK are not in git). Don't push to `origin` without the
human's ok. Verify before marking done (client → run Electron; native → rebuild addon).

---

## Engine track (Ivan)

### E1 — VST3 host foundation (V1–V3)
> Prereq: `KGB_VST3_SDK_DIR` set (run `portaudioAddon/scripts/fetch-vst3-sdk.ps1`).

```
Репо A:\KGB, ветка main. Прочитай CLAUDE.md, AGENTS.md (Two-contributor split),
docs/ADR_native_audio.md §6. Решение: VST3-хост на ПРЯМОМ Steinberg VST3 SDK,
в utilityProcess рядом с PortAudio. Аддон собирается MinGW/GCC (риск: SDK таргетит
MSVC). Зона — только движок (.cc/.mjs/.ts/preload); .tsx и server НЕ трогать.
Каждый шаг с реальной пересборкой (npm run build:vst):
1. V1-сборка: VST3 SDK в CMakeLists через KGB_VST3_SDK_DIR (зеркаль блок ASIO),
   флаги build:vst/build:novst, дефолт VST-OFF; закоммить fetch-vst3-sdk.ps1.
2. V1-спайк: vstProbe() — загрузить .vst3, перечислить классы фабрики; доказать
   компиляцию+линковку под MinGW на реальном плагине (напр. Guitar Rig 7).
3. V1-скелет: IHostApplication, инстанс IComponent/IAudioProcessor, вызов из
   RT-callback с пустой цепочкой; крэш VST → engine-crashed → respawn (A3.5c).
4. V2: addon.scanVst3(paths[]) → [{name,vendor,type:effect|instrument,version}].
5. V3: loadPlugin(path,slotId)→дескриптор+параметры; unloadPlugin(slotId); параметры
   в renderer через MessageChannelMain. Завести insertChainStore (логика, не UI).
Согласуй контракт insertChainStore + window.nativeAudio VST-методы с nik до V3.
```

### E2 — VST runtime + live integration (V6, V4, V8, V9, V10)
```
Репо A:\KGB, main. Продолжаем VST (после E1: хост+scan+load готовы). Зона — движок.
1. V6: InsertChain рантайм — упорядоченный список slotId на точке (target:
   'channel'|'track', id); addon применяет цепочку in-order в RT-callback.
2. V4: openEditor(slotId)/closeEditor — VST3 IPlugView в СОБСТВЕННОМ OS-окне
   (без embed), окно на main-thread utility.
3. V8: InsertChain на input-канале — ASIO input → chain → Opus encode → сеть;
   мониторинг и запись на armed-дорожку = пост-VST сигнал.
4. V9: getPluginState(slotId)→бинарный пресет; параметры (не бинарь) — через стор пирам.
5. V10: при смене устройства/Host API пересоздавать каналы, сохраняя цепочки (state по (channelKey,slotIndex)).
Проверка: гитара через Guitar Rig 7 на входе; бэндмейт слышит обработанный тон;
задержка цепочки видна (getLatencySamples) в сторе.
```

### E3 — Audio-core blockers (AUDIT §1/§2/§4 + latency-half of §5/§8.A.1)
```
Репо A:\KGB, main. Прочитай AUDIT.md §1, §2, §4. Зона — движок/нативка (НЕ server, НЕ .tsx).
- §1.1/§1.3: синхронизация/drift-компенсация на приёме (engine: nativeRtcManager
  receive + jitter в addon) — основа сетевого clock sync.
- §2.1: reinit портит новый Opus-энкодер устаревшим PCM.
- §2.2: хард-клиппинг → лимитер.  §2.3: убрать crashMe→abort() из прод.
- §4.1 tie-break инициатора; §4.2 валидация channelId входящего Opus; §4.3 таймаут
  sendRequest; §4.5 уборка пира на 'disconnected'; §4.7 стейл-порт renderer.
- §8.A.1: запись на РЕАЛЬНОМ sample-rate (брать из nativeAudioController-снапшота,
  не хардкод 48k) — тихая порча записей не на 48k.
```

### E4 — Track instruments + export + perf (I1/I3 runtime, export, §9.A/§9.D)
```
Репо A:\KGB, main. Зона — движок/логика (export-логика наша; export-диалог в
TimelinePanel — у nik, он уже зовёт exportClipFile).
1. I1 рантайм: применять InsertChain дорожки при воспроизведении клипов → mixer master.
2. I3: голос мелодических миди-клипов через VST3-ИНСТРУМЕНТ (VSTi) в слоте дорожки.
3. Экспорт: T3 MP3 через ffmpeg-wasm Web Worker; финальный mixdown (рендер всех
   клипов + голоса драм/VSTi) в WAV→MP3; проект-JSON (дорожки/клипы/VST-параметры,
   бинарь-пресеты отдельным файлом).
4. §9.A: Opus encode/decode в worker-thread (addon.cc — теперь single-owner, без
   очерёдности). §9.D: чистка clipAudio/bufferCache при удалении клипа.
```

---

## UI + Server + Sync track (nik)

### N1 — Server security (AUDIT §3, CRITICAL) ← первым
```
Репо A:\KGB, main. Прочитай CLAUDE.md, AGENTS.md (Two-contributor split), AUDIT.md §3.
Зона — server/ (+ sync-слой). НЕ трогать .cc/utility/preload/аудио-движок. Сервер — CommonJS, Zod на каждом событии.
- §3.1 хост-гейтинг фиктивен: захостгейтить clip_add/update/remove, step_toggle,
  velocity_change (сейчас только transport_*/bpm/drum). Любой гость стирает чужой таймлайн.
- §3.2 clip:file без лимита размера и rate-limit → DoS: лимит + throttle.
- §3.3 утечка комнат при повторном room:create.  §3.4 капы на рост состояния.
- §3.5 пароль в открытом виде + слабая проверка.  §3.6/§3.7 chat blind-relay/XSS, username.
Проверка: гость не может удалить чужой клип; пере-create не плодит комнаты.
```

### N2 — Sync correctness (AUDIT §5 sync-half, CRITICAL)
```
Репо A:\KGB, main. Прочитай AUDIT.md §5. Зона — sync-слой (syncProtocol/roomSyncClient/
timelineSync/server) + sync-обработчики в App.tsx. Координация: latency-ЗНАЧЕНИЯ и
recorder — у Engine-дорожки; ты владеешь синком клипов.
- §5.3 опоздавшие НИКОГДА не получают записанное аудио — гидрация WAV-файлов клипов.
- §5.5 у клипов нет LWW/дедупа — добавить.  §5.6 хост-гейт clip-событий (со §3.1).
- §5.2 НЕ транслировать локальную latency-компенсацию пирам.
Проверка: опоздавший участник видит и слышит ранее записанные клипы.
```

### N3 — App.tsx decomposition (AUDIT §8.C + §5.4)
```
Репо A:\KGB, main. Прочитай AUDIT.md §8.C. Зона — App.tsx + новые хуки/.tsx.
App.tsx — монолит ~2000 строк; вынеси оркестрацию в хуки (useRecording/useTransport/
useRoomSync), App становится тонким UI. Хуки ЗОВУТ движковые модули (audioEngine,
recorder, nativeAudioController) — их API не меняешь, только потребляешь.
- §8.C.2: потеря MIDI-нот при гидрации снапшота у опоздавших — починить.
- §5.4: setState/store-write внутри Tone.js-колбэков — вынести (нарушение CLAUDE.md).
- §8.C.1: HMR-дубль подписок (Tone 'start'/'stop') — снять.
```

### N4 — InsertChain UI + module UI (V5, V7, AUDIT §8.D)
```
Репо A:\KGB, main. Зона — .tsx. Контракт от Engine-дорожки: insertChainStore +
window.nativeAudio VST-методы (согласован в E1).
1. V5: generic-params UI — React-fallback для headless: слайдеры/комбобоксы по типам
   (float/enum/bool), читают getParam/setParam слота.
2. V7: InsertChain-компонент — список инсертов, drag-reorder, +, ПКМ bypass/remove,
   dblclick→окно V4 или V5; показывать задержку каждого инсерта и суммарную.
   Переиспользуется в MixerStrip и Timeline TrackHeader.
3. §8.D: корректность drum/piano/mixer/timeline-UI (по находкам аудита).
```

### N5 — Render perf + Phase 5 UI (AUDIT §9.C + Phase 5)
```
Репо A:\KGB, main. Прочитай AUDIT.md §9.C и раздел Phase 5 в TASKS.md. Зона — .tsx.
- §9.C: ~55 ре-рендеров App/с при playback + негейтированные RAF — мемоизация,
  гейтинг RAF, дробление монолита (после N3).
- Phase 5 UI: селекторы Host API + размер буфера в SettingsModal (фасады над готовым
  A2/A3-бэкендом); выбор сильной доли; «открыть сохранённую комнату»; UI отключения
  устройства; автосохранение состояния.
```

---

## Coordination (see AGENTS.md for full rules)

- **Contract surface** (agree once): `insertChainStore` shape + `window.nativeAudio`
  VST methods. Sync schema (`syncProtocol`↔`schemas.js`) is nik's; Engine imports types only.
- **No shared files.** Cross-needs via store/API; the file owner adds the field, the other consumes.
- **Daily `git pull --rebase`**, short branches, small merges. No folder hand-offs.
- `§9.A` (worker-thread, addon.cc) is single-owner (Engine) — no cross-track sequencing.
