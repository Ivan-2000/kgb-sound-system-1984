# Рефактор: удаление графа → floating-панели (ЗАВЕРШЁН)

**Статус: Волна 1 + 1.5 выполнены и верифицированы (2026-06-14).** Это лог завершённого
рефактора — не план к исполнению. Детальный пошаговый план свёрнут; ниже — итог.

## Что сделано

Нодовый граф / React-Flow Canvas удалён из кода **целиком** (не «заморожен»):
- удалены `client/src/graph/**`, `client/src/canvas/**`, обёртки `*Node.tsx`,
  `pianoRoll/pianoTransport.ts`, `timeline/timelineNodes.ts`;
- зависимость `@xyflow/react` убрана из `client/package.json` и `package-lock.json`;
- `graph_*` события вырезаны из `protocol/syncProtocol.ts`, `roomSyncClient.ts` и
  сервера (`schemas.js`, `roomManager.js`).

Целевая архитектура (panels-first) — действует:
- окна → `client/src/panels/panelStore.ts` (локально, без синка позиций);
- `DrumMachine` и `timelineStore` — синглтоны (`drumMachine/drumSingleton.ts`,
  `timeline/timelineSingleton.ts`), импортируются напрямую;
- `drumNodes.ts` — только room-sync glue (`emitDrumSync`/`connectDrumRoom`/editable);
- room-sync покрывает состояние движков (transport/BPM host-gated, drum LWW, клипы,
  чат, channel meta), но не раскладку окон.

**1.5a** — схлопнуты `Map`-реестры драма/таймлайна (один инстанс на сессию).
**1.5b** — `nodeId` убран из drum-протокола; серверный `s.drums` → единый `s.drum`.

## Верификация (2026-06-14)

`tsc -b` зелёный, `vite build` зелёный (≈774 kB), сервер `node --check` чист, лобби
стартует без ошибок консоли. Граф-символов в коде нет (остаточные комментарии-призраки
вычищены). **Не прогонялось в Electron:** полный room-flow (панели в комнате, запись на
таймлайн, каналы микшера, нативный звук) — за ручным прогоном `npm run dev`.

## Что дальше

Рефактор сознательно **не чинил баги** (принцип «сначала упрощаем, потом латаем»).
Все известные баги и перф-находки — в **`AUDIT.md`** («Волна 2»), фиксятся отдельными
заходами. Архитектурная сводка для агентов — в `AGENTS.md`, статус фаз — в `TASKS.md`.
