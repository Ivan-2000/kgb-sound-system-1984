# N1 / §3.1 — авторизация clip/step-событий (proposal для nik)

> **СТАТУС: реализовано по модели B (2026-07-21) по прямому запросу владельца.**
> `roomManager.applySyncEvent(…, senderId)` + `getClipOwner`, `ownerId` на клипе, gate в
> `registerSocketHandlers` (`NOT_CLIP_OWNER`). Драм оставлен общим. Стабильный id владельца
> (сейчас `ownerId = socketId`, теряется при reconnect) — follow-up в N2. nik: сделать
> `git pull --rebase`, при желании поменять модель — код изолирован, см. диффы ниже.
>
> Подготовлено Engine-треком как **точечный дифф на выбор**. Зона файлов — nik (`server/`).
> Связано с тестом №1 в `TEST_PLAN.md` (host-gating) и с §5.5/§5.6 (LWW) из спринта N2.

## Проблема (текущее состояние)

В [`server/socket/registerSocketHandlers.js:185`](../server/socket/registerSocketHandlers.js)
`hostOnlyTypes` покрывает только 9 транспортно-паттерновых событий. Мутирующие события
**`clip_add` / `clip_update` / `clip_remove` / `step_toggle` / `velocity_change` не
авторизуются** — любой гость добавляет/правит/удаляет чужие клипы и правит драм-паттерн.
Схемы для них есть ([`schemas.js:79,123`](../server/protocol/schemas.js)), сервер их
валидирует и слепо ретранслирует.

Остальная часть N1 уже закрыта в коде (§3.2 cap 16 MB + rate-limit, §3.3 leaveRoom при
пересоздании, §3.5 `timingSafeEqual`, §3.4 `MAX_CLIPS_PER_TIMELINE`) — осталось это.

## Развилка: какую модель авторизации выбрать

| | Модель | Клипы | Драм (step/velocity) | Стоимость | Когда |
|---|---|---|---|---|---|
| **A** | **Full host-gate** | правит только хост | правит только хост | 1 строка | Нужна быстрая заглушка безопасности; коллаборация не важна |
| **B** | **Ownership** (рекоменд.) | гость правит **свои**, хост — любые; `clip_add` всегда свой | остаётся общим (LWW) *или* host-gate — на выбор | handler + roomManager | DAW-коллаборация: каждый пишет свои дорожки |
| **C** | Open + LWW | любой правит любые, но с LWW/дедупом | LWW | переносится в N2 §5.5 | Полностью совместное редактирование, дисциплина только через LWW |

**Рекомендация:** **B** как целевая (совместная репетиция → каждый владеет своими клипами),
драм оставить общим. **A** годится как немедленный security-стопгэп, если B не успеваете к
дедлайну N1 — тогда B доезжает в N2 вместе с LWW.

---

## Патч A — Full host-gate (drop-in, 1 место)

`server/socket/registerSocketHandlers.js`, строка 185:

```diff
-      const hostOnlyTypes = new Set(['transport_play', 'transport_stop', 'bpm_change', 'step_count_change', 'time_signature_change', 'metronome_toggle', 'swing_change', 'pattern_switch', 'chain_set'])
+      const hostOnlyTypes = new Set(['transport_play', 'transport_stop', 'bpm_change', 'step_count_change', 'time_signature_change', 'metronome_toggle', 'swing_change', 'pattern_switch', 'chain_set',
+        'clip_add', 'clip_update', 'clip_remove', 'step_toggle', 'velocity_change'])
```

Готово. Гость получает `HOST_AUTHORITY_REQUIRED` на любую правку таймлайна/драма.

---

## Патч B — Ownership (клипы), драм оставляем общим

### 1) `registerSocketHandlers.js` — проверка владения перед apply

После блока `hostOnlyTypes` (после строки 189), перед `roomManager.applySyncEvent(...)`:

```diff
       if (hostOnlyTypes.has(parsed.data.type) && room.hostSocketId !== socket.id) {
         ack?.({ ok: false, error: 'HOST_AUTHORITY_REQUIRED' })
         return
       }
+
+      // §3.1 ownership: гость правит/удаляет только свои клипы; хост — любые.
+      // clip_add всегда разрешён (создаёт собственный клип, владелец проставляется в apply).
+      if (room.hostSocketId !== socket.id &&
+          (parsed.data.type === 'clip_update' || parsed.data.type === 'clip_remove')) {
+        const { timelineNodeId, clipId } = parsed.data.payload
+        const owner = roomManager.getClipOwner(roomId, timelineNodeId, clipId)
+        if (owner && owner !== socket.id) {
+          ack?.({ ok: false, error: 'NOT_CLIP_OWNER' })
+          return
+        }
+      }

-      roomManager.applySyncEvent(roomId, parsed.data)
+      roomManager.applySyncEvent(roomId, parsed.data, socket.id)
```

### 2) `server/rooms/roomManager.js` — хранить владельца + геттер

В `applySyncEvent(roomId, event)` → добавить параметр `senderId`, и в ветке `clip_add`
(строка ~314) проставлять `ownerId`:

```diff
-  applySyncEvent(roomId, event) {
+  applySyncEvent(roomId, event, senderId = null) {
```

```diff
     if (event.type === 'clip_add') {
       const { timelineNodeId, trackKey, trackName, trackColor, trackKind, clip } = event.payload
       const tl = (s.timelineClips[timelineNodeId] ||= {})
       if (!(clip.id in tl) && Object.keys(tl).length >= MAX_CLIPS_PER_TIMELINE) return
-      tl[clip.id] = { ...clip, trackKey, trackName, trackKind, trackColor }
+      tl[clip.id] = { ...clip, trackKey, trackName, trackKind, trackColor,
+        ownerId: tl[clip.id]?.ownerId ?? senderId }
       return
     }
```

Добавить метод (рядом с `getRoom`):

```js
  getClipOwner(roomId, timelineNodeId, clipId) {
    const room = this.rooms.get(roomId)
    return room?.syncState?.timelineClips?.[timelineNodeId]?.[clipId]?.ownerId ?? null
  }
```

> Примечание: `getSyncState()` теперь отдаст клиентам поле `ownerId` в клипах — безвредно,
> но если хотите не светить socketId, отфильтруйте его в `getSyncState` при сериализации.

### 3) Драм (step_toggle / velocity_change)
В патче B **остаются общими** (единый паттерн комнаты, LWW — модель владения к ним не
применима). Если решите запереть драм на хоста — добавьте `'step_toggle', 'velocity_change'`
в `hostOnlyTypes` (это подмножество патча A). Клипы при этом остаются ownership-based.

---

## Как проверить (→ TEST_PLAN.md, тест №1)

- Гость шлёт `clip_remove` чужого клипа → `NOT_CLIP_OWNER` (B) / `HOST_AUTHORITY_REQUIRED` (A).
- Гость шлёт `clip_remove` **своего** клипа → применяется (B).
- Хост шлёт `clip_remove` любого → применяется.
- `transport_play` от гостя → `HOST_AUTHORITY_REQUIRED` (регресс-защита, не менять).

## Взаимодействие с N2
§5.5 (LWW/дедуп клипов) и §5.6 (host-gate clip — «со §3.1») закрываются в N2. Патч B
совместим: ownership — про «кто может править», LWW — про «какая версия побеждает». Оба нужны.
