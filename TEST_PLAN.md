# KGB Sound System 85 — TEST_PLAN.md

Минимальный набор тестов под **AUDIT §7.3** («тестов нет вообще»).

> **СТАТУС (2026-07-22): Tier 0 реализован и зелёный** — `npm test` (Vitest, корень),
> 45 тестов в `test/server/{schemas,roomManager,handlers}.test.js`. Помимо исходного плана
> покрывает и закрытые пункты N2: §5.5 (clip LWW/rev), §5.3 (хранение/replay аудио),
> §5.8 (tempo-lock при записи). **Tier 1/2 (клиентские §5.5 LWW-стор, latency, drum, WAV) —
> НЕ реализованы:** нужен отдельный client-Vitest проект (jsdom/тон-моки) — следующий заход.
>
> Философия: покрываем места, где баг **молчаливый и дорогой** — безопасность сервера,
> порча данных синка, чистая арифметика тайминга. RT-C++ (`addon.cc`), реальные устройства
> и сквозной WebRTC — **вне минимума** (нужны стенды, отдельный уровень).

---

## Инструментарий (минимальные зависимости)

- **Клиент** (ESM+TS+Vite) → **Vitest**, окружение `node` (jsdom не нужен для чистой логики).
- **Сервер** (CommonJS) → тот же Vitest (node-окружение) либо встроенный `node:test`.
- Один раннер: Vitest с двумя `projects` (node для клиента и сервера).
- Скрипты: `"test": "vitest run"` в корне и в `client/`. Цель CI: зелёный прогон < 5 сек
  (всё чистое, без I/O, без моков PortAudio/WebRTC).

**Границы минимума:** только детерминированные функции без устройства/сети/аудиоконтекста.

---

## Tier 0 — безопасность и целостность данных (обязательно) — ✅ РЕАЛИЗОВАН

### 1. `server/socket/registerSocketHandlers.test.js` — host-gating (§3.1, N1 CRITICAL)
Самый важный файл: одновременно документирует нужное поведение и ловит текущую дыру.
Фейковый `socket` (`{ id, emit, on }`) + подставной `roomManager`.
- [ ] Гость шлёт `clip_remove` / `clip_add` / `step_toggle` → сервер **отклоняет**
      (сейчас пропустит — красный тест = спека N1).
- [ ] Хост шлёт то же → **применяется**.
- [ ] `transport_play` / `bpm_change` от гостя → отклонено (уже работает — регресс-защита,
      `hostOnlyTypes` в `registerSocketHandlers.js:185`).

### 2. `server/protocol/schemas.test.js` — Zod-валидация (§3.2)
- [ ] `clipPayloadSchema` / `clientEventSchema`: валидный payload проходит; `durSec < 0`,
      `id` длиннее 64, неизвестный `type`, лишние поля — отклоняются.
- [ ] `createRoomSchema`: `maxParticipants` вне `[2..8]` отклоняется; `username` пустой /
      только пробелы / > 32 символов — отклоняются.
- [ ] `clip:file`: тест на **лимит размера** буфера (сейчас лимита нет → красный = спека N1).

### 3. `server/rooms/roomManager.test.js` — состояние комнат (§3.3/§3.4)
- [ ] `createRoom` дважды одним `hostSocketId` не плодит комнаты-сироты (§3.3 утечка).
- [ ] `MAX_CLIPS_PER_TIMELINE`: добавление сверх капа игнорируется, `clip_update`
      существующего — проходит (`roomManager.js:313` — регресс-защита).
- [ ] `generateShortCode()`: длина 4, разрешённый алфавит, нет коллизии на заполненном наборе.
- [ ] `passwordMatches`: верный / неверный / пустой пароль.
- [ ] `applySyncEvent` `clip_remove` несуществующего клипа/таймлайна не роняет структуру.

---

## Tier 1 — корректность синка и тайминга (высокий ROI) — ⬜ не реализован (нужен client-Vitest)

### 4. `client/src/timeline/timelineSync.test.ts` — LWW/дедуп (§5.5 CRITICAL, N2)
- [ ] Слияние клипа по `(id, updatedAt)`: старый апдейт не затирает свежий.
- [ ] Дубль `clip_add` того же `id` не создаёт второй клип.
      (Сейчас LWW нет → красный = спека N2.)

### 5. `client/src/audio/recorder.test.ts` — latency-компенсация (§5.1 CRITICAL, N2)
Вынести арифметику сдвига `startSec` в чистую функцию, затем:
- [ ] сдвиг = `inputLatencyMs / 1000`, **не** `input + output`;
- [ ] результат не уходит в отрицательный `startSec`;
- [ ] нулевая latency → no-op.

### 6. `client/src/drumMachine/drumMachine.test.ts` — drum → `NoteEvent[]` (PR5)
- [ ] Маппинг kick→36, snare→38, hat→42, crash→49.
- [ ] Шаг с `velocity` / `swing` даёт ноту с правильным `time` / `velocity`.
- [ ] Пустой паттерн → пустой массив.

---

## Tier 2 — кодеки/форматы (по желанию) — ⬜ не реализован (нужен client-Vitest)

### 7. `client/src/timeline/mixdown.test.ts` — WAV-заголовок (§8.A.1)
- [ ] `encodeWavMono`: RIFF / `WAVE` / `fmt ` / `data` на месте (ассерты по байтовым офсетам).
- [ ] Поле sampleRate в заголовке = переданному SR, **не** хардкод 48000
      (§8.A.1 — тихая порча не-48k записей).

---

## Вне минимума (следующий уровень — требует инфраструктуры)

- RT-логика `addon.cc`: SPSC-кольца, jitter-buffer, PLC — нужен C++ harness (Catch2/GoogleTest).
- Сквозной WebRTC-синк двух пиров, гидрация опоздавших (§5.3).
- Реальные аудиоустройства, ASIO end-to-end acceptance Phase 1.

---

## Маппинг тест → находка AUDIT

| Тест | Закрывает | Спринт |
|---|---|---|
| 1. host-gating | §3.1 | N1 |
| 2. Zod schemas | §3.2 | N1 |
| 3. roomManager | §3.3, §3.4 | N1 |
| 4. timelineSync LWW | §5.5 | N2 |
| 5. latency-компенсация | §5.1 | N2 |
| 6. drum → NoteEvent | PR5 (регресс) | — |
| 7. WAV-заголовок | §8.A.1 | E3 (регресс) |
