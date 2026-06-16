# KGB Sound System 85 — SPRINTS.md

Action plan + paste-ready prompts for both contributors. Boundary/merge rules: **`AGENTS.md`**.
Feature specs (V/I/T): **`TASKS.md`**. Bug findings (§): **`AUDIT.md`**. This file maps
sprints → exact items and is the **completion ledger** (§ "Coverage ledger" below).

**Two tracks run in parallel. Every file has one owner — never edit across the line.**

- **Engine track** (Ivan + assistant): native addon / audio engine / VST host.
- **UI+Server+Sync track** (nik): all `.tsx`, `server/`, sync layer.

Each prompt is self-contained (cold session). Branch off `main` (or work on `main`
directly — files are disjoint), rebuild locally (addon `*.node` + VST3 SDK via
`KGB_VST3_SDK_DIR`, not in git).

---

## ⛳ Definition of Done — обязательно в конце КАЖДОГО пункта

1. **Прочитать спеку** — перед стартом открыть в `TASKS.md` свои V*/I*/T* и в `AUDIT.md`
   свои §-пункты (точный список — в «Coverage ledger» ниже, строка своего спринта).
2. **Верификация** — client: запустить Electron и проверить поведение; native:
   пересобрать аддон и проверить. Не «done» без подтверждения вживую.
3. **Commit** — `git commit`, концовка `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
4. **Отметить готовым — один источник статуса на тип:**
   - фичи **V/I/T** → `[ ]`→`[x]` в `TASKS.md` (единственное место);
   - находки **§-AUDIT** → ✅ напротив ID в «Coverage ledger» ниже (единственное место;
     в самом `AUDIT.md` статус не дублировать — там нет чек-боксов по находкам).
   Колонка V/I/T в ledger — только для маппинга «спринт→фича», статус фич там не ставить.
5. **Merge при необходимости** (если работал в ветке) → **`git push origin main`**.

Дефолтная сборка остаётся **VST-OFF** (`build:asio`) — не ломать билд тем, у кого нет SDK.

---

## Engine track (Ivan)

### E1 — VST3 host foundation (V1–V3)
> SDK установлен/проверен: `KGB_VST3_SDK_DIR = A:\VST_SDK\vst3sdk`. Первый шаг —
> закоммитить незакоммиченный `scripts/fetch-vst3-sdk.ps1` вместе с CMake-обвязкой.

```
Репо A:\KGB, ветка main. Прочитай CLAUDE.md, AGENTS.md (Two-contributor split),
SPRINTS.md (Definition of Done + Coverage ledger строка E1), TASKS.md пункты V1/V2/V3,
docs/ADR_native_audio.md §6. Решение: VST3-хост на ПРЯМОМ Steinberg VST3 SDK, в
utilityProcess рядом с PortAudio. SDK стоит (KGB_VST3_SDK_DIR=A:\VST_SDK\vst3sdk).
Аддон собирается MinGW/GCC (главный риск: SDK таргетит MSVC). Зона — только движок
(.cc/.mjs/.ts/preload); .tsx и server НЕ трогать. Каждый шаг с реальной пересборкой:
1. V1-сборка: VST3 SDK в CMakeLists через KGB_VST3_SDK_DIR (зеркаль блок ASIO),
   флаги build:vst/build:novst, дефолт VST-OFF; закоммитить fetch-vst3-sdk.ps1.
2. V1-спайк (ГЛАВНЫЙ РИСК): vstProbe() — загрузить .vst3, перечислить классы фабрики;
   доказать компиляцию+линковку под MinGW на реальном плагине (напр. Guitar Rig 7).
   Не идёт под GCC — решать ТУТ (минимальный набор .cpp/патчи), не углубляясь дальше.
3. V1-скелет: IHostApplication, инстанс IComponent/IAudioProcessor, вызов из
   RT-callback с пустой цепочкой; крэш VST → engine-crashed → respawn (A3.5c).
4. V2: addon.scanVst3(paths[]) → [{name,vendor,type:effect|instrument,version}].
5. V3: loadPlugin(path,slotId)→дескриптор+параметры; unloadPlugin(slotId); параметры
   в renderer через MessageChannelMain. Завести insertChainStore (логика, не UI).
Согласуй контракт insertChainStore + window.nativeAudio VST-методы с nik до V3.
Закрой каждый пункт по Definition of Done (вкл. ✅ в Coverage ledger + [x] в TASKS.md
+ git push). Закрывает: TASKS V1,V2,V3.
```

### E2 — VST runtime + live integration (V4,V6,V8,V9,V10)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger E2), TASKS.md V4,V6,V8,V9,V10.
После E1 (хост+scan+load готовы). Зона — движок.
1. V6: InsertChain рантайм — список slotId на точке (target:'channel'|'track', id);
   addon применяет цепочку in-order в RT-callback.
2. V4: openEditor/closeEditor — VST3 IPlugView в СОБСТВЕННОМ OS-окне, на main-thread utility.
3. V8: InsertChain на input-канале — ASIO input → chain → Opus → сеть; мониторинг и
   запись на armed-дорожку = пост-VST сигнал.
4. V9: getPluginState(slotId)→пресет; параметры (не бинарь) через стор пирам.
5. V10: при смене устройства/Host API пересоздавать каналы, сохраняя цепочки.
Проверка: гитара через Guitar Rig 7 на входе; бэндмейт слышит обработанный тон;
задержка цепочки (getLatencySamples) видна в сторе.
Закрой по DoD. Закрывает: TASKS V4,V6,V8,V9,V10.
```

### E3 — Audio-core blockers (AUDIT §1/§2/§4/§8.A)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger E3), AUDIT.md §1,§2,§4,§8.A.
Зона — движок/нативка (НЕ server, НЕ .tsx).
- §1.1/§1.3 (CRIT): синхронизация/drift-компенсация на приёме (nativeRtcManager
  receive + jitter в addon) — сетевой clock sync.  §1.4 (HIGH): не терять реальный SR.
- §2.1 (HIGH): reinit портит новый Opus-энкодер устаревшим PCM.  §2.2/§2.3: лимитер
  вместо хард-клипа; убрать crashMe→abort() из прод.
- §4.1/§4.2/§4.3 (HIGH): tie-break инициатора; валидация channelId входящего Opus;
  таймаут sendRequest.  §4.5/§4.7: уборка пира на 'disconnected'; стейл-порт.
- §8.A.1 (HIGH): WAV на РЕАЛЬНОМ SR из result.sampleRate (не хардкод 48k) — тихая
  порча не-48k записей.  §8.A.2: одна opus-константа, mono 24–48 kbps.  §8.A.3:
  Pa_AbortStream в закрытии (зависший ASIO не морозит utility).
Закрой по DoD. Закрывает CRIT/HIGH: §1.1,§1.3,§1.4,§2.1,§4.1,§4.2,§4.3,§8.A.1,§8.A.2,§8.A.3;
+ MED §2.2,§2.3,§4.5,§4.7. LOW (§2.4,§4.4,§4.6,§4.8,§4.9,§8.A.4–9) — попутно/deferred.
```

### E4 — Track instruments + export + RT-perf (I1/I3/T3/export, §9.A/§9.D)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger E4), TASKS.md I1,I3,T3 + «Финальный
mixdown WAV/MP3», «Экспорт проекта»; AUDIT.md §9.A,§9.D. Зона — движок/логика
(export-логика наша; export-диалог в TimelinePanel — у nik).
1. I1 рантайм: InsertChain дорожки при воспроизведении клипов → mixer master.
2. I3: голос мелодических миди-клипов через VST3-ИНСТРУМЕНТ (VSTi) в слоте дорожки.
3. Экспорт: T3 MP3 (ffmpeg-wasm Web Worker); финальный mixdown (все клипы + голоса
   драм/VSTi) WAV→MP3; проект-JSON.
4. §9.A.1/§9.A.2 (CRIT): Opus в worker-thread (addon — single-owner) + encode-once.
   §9.A.3–5 (HIGH). §9.D.1 (CRIT)/§9.D.2/§9.D.3: чистка clipAudio/bufferCache при
   удалении клипа, аллокации.  §9.B.2: Opus bitrate вниз (с §8.A.2).
Закрой по DoD. Закрывает: TASKS I1,I3,T3,mixdown,project-export; AUDIT §9.A.1,§9.A.2,
§9.A.3,§9.A.4,§9.A.5,§9.B.2,§9.D.1,§9.D.2,§9.D.3,§1.5. LOW (§2.4,§8.A.4–9,§9.A.6–12,§9.D.4–10) deferred.
```

---

## UI + Server + Sync track (nik)

### N1 — Server security (AUDIT §3, §8.B) — CRITICAL, первым
```
Репо A:\KGB, main. Прочитай CLAUDE.md, AGENTS.md, SPRINTS.md (DoD + ledger N1),
AUDIT.md §3,§8.B. Зона — server/ (+ sync-слой). НЕ трогать .cc/utility/preload/движок.
Сервер — CommonJS, Zod на каждом событии.
- §3.1 (CRIT): захостгейтить clip_add/update/remove, step_toggle, velocity_change.
- §3.2 (CRIT): clip:file — лимит размера + rate-limit (DoS).  §3.3 (CRIT): утечка
  комнат при повторном room:create.  §3.4 (HIGH): капы роста состояния.  §3.5 (HIGH):
  пароль/проверка.  §3.6/§3.7: прочее, chat XSS/username.  §8.B.1 (HIGH).
Проверка: гость не удаляет чужой клип; пере-create не плодит комнаты.
Закрой по DoD. Закрывает: §3.1,§3.2,§3.3,§3.4,§3.5,§8.B.1; + §3.6,§3.7,§8.B.2–6 (MED/LOW).
```

### N2 — Sync correctness & record timing (AUDIT §5)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger N2), AUDIT.md §5. Зона — sync-слой
(syncProtocol/roomSyncClient/timelineSync/server) + record/transport-оркестрация в App.tsx.
Координация: реальный SR и latency-ЗНАЧЕНИЯ даёт Engine (§8.A.1); ты владеешь синком и
таймингом записи.
- §5.1 (CRIT): арифметика latency-компенсации.  §5.2: не транслировать локальную
  компенсацию пирам.  §5.3 (CRIT): опоздавшие получают записанное аудио (гидрация WAV).
  §5.5 (CRIT): LWW/дедуп клипов.  §5.6: хост-гейт clip-событий (со §3.1).
- §5.7–5.10 (HIGH): выравнивание записи к позиции 0; BPM во время записи; отмена
  преролла; дрейф из-за позиционной компенсации.  §5.15 (HIGH): гонки proxy→real.
Проверка: опоздавший видит и слышит ранее записанные клипы; запись бьётся по тактам.
Закрой по DoD. Закрывает: §5.1,§5.2,§5.3,§5.5,§5.6,§5.7,§5.8,§5.9,§5.10,§5.15; + §5.16,§5.17,§5.18 (MED/LOW).
```

### N3 — App.tsx decomposition (AUDIT §8.C + §5.4 + §5.11–5.14,5.19)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger N3), AUDIT.md §8.C,§5.4. Зона —
App.tsx + новые хуки/.tsx. Вынеси оркестрацию в хуки (useRecording/useTransport/
useRoomSync), App → тонкий UI; хуки ЗОВУТ движковые модули (их API не меняешь).
- §8.C.1 (CRIT): HMR-дубль подписок Tone 'start'/'stop'.  §8.C.2/§8.C.3 (HIGH): потеря
  MIDI-нот при гидрации; прочее.  §5.4 (CRIT): setState/store-write в Tone-колбэках.
- §5.11/§5.12/§5.13/§5.14 (MED): live-waveform пишет store часто; гонка Stop;
  double-record теряет аудио; утечки записи.  §5.19: setState-in-render TimelinePanel/PianoRoll.
Закрой по DoD. Закрывает: §8.C.1,§8.C.2,§8.C.3,§5.4; + §8.C.4–6,§5.11,§5.12,§5.13,§5.14,§5.19.
```

### N4 — InsertChain UI + module UI (V5,V7, AUDIT §8.D)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger N4), TASKS.md V5,V7; AUDIT.md §8.D.
Зона — .tsx. Контракт от Engine: insertChainStore + window.nativeAudio VST-методы (E1).
1. V5: generic-params UI — слайдеры/комбобоксы по типам (float/enum/bool), getParam/setParam.
2. V7: InsertChain-компонент — список, drag-reorder, +, ПКМ bypass/remove, dblclick→V4/V5;
   показывать задержку каждого инсерта и суммарную. Переиспользуется в MixerStrip и TrackHeader.
3. §8.D.1 (CRIT)/§8.D.2–4 (HIGH): корректность drum/piano/mixer/timeline-UI/RTC-видео.
Закрой по DoD. Закрывает: TASKS V5,V7; AUDIT §8.D.1,§8.D.2,§8.D.3,§8.D.4; + §8.D.5–12 (MED/LOW).
```

### N5 — Render perf + scale + Phase 5 UI (AUDIT §9.C/§9.B, Phase 5)
```
Репо A:\KGB, main. Прочитай SPRINTS.md (DoD + ledger N5), AUDIT.md §9.C,§9.B; TASKS.md Phase 5.
Зона — .tsx (+ §9.B сеть/масштаб, где UI/sync).
- §9.C.1–4 (CRIT): ~55 ре-рендеров App/с при playback, негейтированные RAF, мемоизация,
  дробление монолита (после N3).  §9.C.5–9 (HIGH).
- §9.B.1 (CRIT) SFU vs mesh / §9.B.3 (HIGH) — масштаб на 8 (часть сеть — согласуй с Engine).
- Phase 5 UI: Host API + buffer-size селекторы в SettingsModal; выбор сильной доли;
  «открыть сохранённую комнату»; UI отключения устройства; автосохранение.
Закрой по DoD. Закрывает: §9.C.1–9,§9.B.1,§9.B.3 + Phase 5 UI пункты; §9.C.10–15,§9.B.4–8 (MED/LOW).
```

---

## Coverage ledger — каждая находка AUDIT + фича назначена в спринт

Отмечай ✅ напротив ID при закрытии (DoD шаг 4). CRIT/HIGH — поимённо; MED/LOW группой.

| Спринт | TASKS (V/I/T) | AUDIT CRIT/HIGH | AUDIT MED/LOW (попутно) |
|---|---|---|---|
| **E1** | V1,V2,V3 | — | — |
| **E2** | V4,V6,V8,V9,V10 | — | — |
| **E3** | — | §1.1 §1.3 §1.4 §2.1 §4.1 §4.2 §4.3 §8.A.1 §8.A.2 §8.A.3 | §2.2 §2.3 §4.5 §4.7 / §2.4 §4.4 §4.6 §4.8 §4.9 §8.A.4–9 |
| **E4** | I1,I3,T3, mixdown WAV/MP3, project-export | §1.5 §9.A.1 §9.A.2 §9.A.3 §9.A.4 §9.A.5 §9.B.2 §9.D.1 §9.D.2 §9.D.3 | §9.A.6–12 §9.D.4–10 |
| **N1** | — | §3.1 §3.2 §3.3 §3.4 §3.5 §8.B.1 | §3.6 §3.7 §8.B.2–6 |
| **N2** | — | §5.1 §5.2 §5.3 §5.5 §5.6 §5.7 §5.8 §5.9 §5.10 §5.15 | §5.16 §5.17 §5.18 |
| **N3** | — | §8.C.1 §8.C.2 §8.C.3 §5.4 | §8.C.4–6 §5.11 §5.12 §5.13 §5.14 §5.19 |
| **N4** | V5,V7 | §8.D.1 §8.D.2 §8.D.3 §8.D.4 | §8.D.5–12 |
| **N5** | Phase 5 UI (Host API, buffer, downbeat, saved room, device-disconnect, autosave) | §9.C.1 §9.C.2 §9.C.3 §9.C.4 §9.C.5 §9.C.6 §9.C.7 §9.C.8 §9.C.9 §9.B.1 §9.B.3 | §9.C.10–15 §9.B.4–8 |

**Не код-фиксы (закрываются автоматически / справочные):** §1.2 (web-audio reality — станет
правдой по мере §1.1/§1.5 + нативной генерации), §6 (doc vs code — обновить доки по мере
закрытия ссылочных пунктов), §7 (репо-гигиена: 7.1 housekeeping, 7.3 «нет тестов» — позже),
§9.E/§9.F (аналитика/ROI, не задачи). Все CRITICAL и HIGH из §1–§9 присутствуют в строках выше.

---

## Coordination (see AGENTS.md for full rules)

- **Contract surface** (agree once): `insertChainStore` shape + `window.nativeAudio`
  VST methods. Sync schema (`syncProtocol`↔`schemas.js`) is nik's; Engine imports types only.
- **No shared files.** Cross-needs via store/API; the file owner adds the field, the other consumes.
- **Daily `git pull --rebase`**, short branches, small merges. No folder hand-offs.
- `§9.A` (worker-thread, addon.cc) is single-owner (Engine) — no cross-track sequencing.
