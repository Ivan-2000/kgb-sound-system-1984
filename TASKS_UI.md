# KGB Sound — TASKS_UI.md

Задачи по редизайну UI. Нодовая система с Floating Panels и React Flow Canvas.
`[x]` — реализовано, `[ ]` — предстоит сделать.

Версия: **1.0**
Обновлён: 2026-05-31

---

## Содержание

- [Концепция](#концепция)
- [Поток C — UI Redesign](#поток-c--ui-redesign)
- [C1 — Стартовый экран](#c1--стартовый-экран)
- [C2 — Floating Panels система](#c2--floating-panels-система)
- [C3 — Toolbar](#c3--toolbar)
- [C4 — Меню «+» и реестр модулей](#c4--меню--и-реестр-модулей)
- [C5 — Video Grid панель](#c5--video-grid-панель)
- [C6 — Canvas режим](#c6--canvas-режим)
- [C7 — Синхронизация позиций Panel ↔ Canvas](#c7--синхронизация-позиций-panel--canvas)
- [C8 — Сохранение раскладки](#c8--сохранение-раскладки)
- [C9 — Кабели и NodeRegistry](#c9--кабели-и-noderegistry)
- [Общий прогресс](#общий-прогресс)

---

## Концепция

**Базовый режим:** Floating Panels — панели с drag & resize, macOS-стиль тайтлбар.
**Продвинутый режим:** React Flow Canvas — те же панели как ноды на холсте, зум, мини-карта.
**Кабели между нодами:** 🚧 в разработке (C9, после NodeRegistry + ControlBus).

### Принципы

- Каждый модуль (Mixer, Drum Machine, Chat, Video, Metronome...) — самостоятельная панель
- Панели вызываются через меню «+», не захардкожены в layout
- Mixer открывается по умолчанию при входе в комнату
- Транспорт (BPM / Play / Stop / метроном) — фиксированный toolbar, не панель
- Позиции панелей и canvas-нод сохраняются в localStorage отдельно
- При первом переходе в Canvas — позиции инициализируются из панельных

### Существующие компоненты (переиспользуются без переписывания)

| Компонент | Файл | Статус |
|---|---|---|
| Mixer (local + remote strips) | `LocalMixerStrip.tsx`, `RemoteChannelStrip.tsx`, `MixerChannel.tsx` | ✅ готов |
| Drum Machine | `src/drumMachine/drumMachine.ts` + UI в App.tsx | ✅ готов |
| Chat | `src/components/ChatPanel.tsx` | ✅ готов |
| Video tile | `src/components/VideoTile.tsx` | ✅ готов |
| Metronome | `src/audio/metronome.ts` + UI в App.tsx | ✅ готов |
| Settings | `src/components/SettingsModal.tsx` | ✅ готов |
| Transport bar | В App.tsx (строки ~1162–1356) | ✅ готов |

### Зависимости для установки

| Пакет | Зачем | Когда |
|---|---|---|
| `react-rnd` | Drag + resize панелей | C2 |
| `@xyflow/react` | Canvas холст, ноды, мини-карта | C6 |

---

## Поток C — UI Redesign

```
C1 (стартовый экран — косметика)
C2 (Floating Panels — фундамент) ← главная задача
  ├─ C3 (toolbar — мелкие правки)
  ├─ C4 (+ меню)
  ├─ C5 (video → панель)
  ├─ C8 (сохранение раскладки)
  └─ C6 (canvas)
       └─ C7 (синк позиций)
C9 (кабели + NodeRegistry — отложено)
```

---

## C1 — Стартовый экран

**Суть:** Визуальный редизайн лобби. Функционал уже есть (create/join/history/password).

**Оценка:** 1–2 дня

### Задачи

- [x] Вынести три кнопки (Host Room / Join Room / Recent Rooms) на чистый центрированный экран
- [x] Убрать лишние элементы из текущего лобби-layout, оставить только нужное
- [x] Recent Rooms: карточки с названием комнаты, датой, быстрый вход одним кликом
- [x] Логотип KGB Sound в верхней части экрана
- [x] Стиль: Persian Luxury Cyber (чёрный / графит / золото / кристалл), соответствует существующей теме

### Критерий готовности

- [x] Пользователь видит три кнопки при открытии программы
- [x] Recent Rooms показывает последние 10 комнат (5 сразу, остальные по «Show all»)
- [x] Переход к созданию/входу в комнату работает

---

## C2 — Floating Panels система

**Суть:** Архитектурный фундамент. Заменяет жёсткий CSS Grid + булевые флаги на управляемую систему панелей.

**Оценка:** 5–7 дней

**Зависимость:** установить `react-rnd`

### Задачи

**PanelManager (zustand store):**
- [x] Создать `src/panels/panelStore.ts` на zustand — стейт всех панелей: `{ id, type, position: {x,y}, size: {w,h}, zIndex, isOpen, isMinimized }`
- [x] Методы: `openPanel(type)`, `closePanel(id)`, `focusPanel(id)` (поднять z-index), `movePanel(id, pos)`, `resizePanel(id, size)`
- [x] При `openPanel` — проверять нет ли уже открытой панели этого типа (синглтон для Mixer, Chat; мультиэкземпляр для будущих нод)

**FloatingPanel контейнер:**
- [x] Создать `src/panels/FloatingPanel.tsx` — обёртка над `react-rnd`
- [x] Тайтлбар: три dot-кнопки (close / minimize / —), название панели, иконка типа
- [x] Drag за тайтлбар, resize за края
- [x] Клик по панели → `focusPanel(id)` (z-index +1)
- [x] Минимизация: панель схлопывается до тайтлбара (height → 36px)
- [x] Стиль: Persian Luxury Cyber, `background: #141414`, `border: 1px solid #282828`, `box-shadow: 0 4px 24px rgba(0,0,0,.6)`

**Миграция существующих компонентов:**
- [x] Обернуть Mixer (`LocalMixerStrip` + `RemoteChannelStrip` + `MixerChannel`) в панель типа `'mixer'`
- [x] Обернуть Drum Machine в панель типа `'drum-machine'`
- [x] Обернуть Chat (`ChatPanel.tsx`) в панель типа `'chat'`
- [x] Обернуть Metronome settings в панель типа `'metronome'`
- [x] Обернуть Settings (`SettingsModal.tsx`) в панель типа `'settings'`
- [x] Mixer открывается автоматически при входе в комнату (`openPanel('mixer')` в useEffect при `inRoom`)
- [x] Удалить жёсткий CSS Grid layout (`.workspace-grid`, `.side-stack`, `.sequencer-section`) из App.tsx
- [x] Удалить булевые флаги `showDrumMachine`, `showChat`, `showArrange`, `showMetroSettings`, `showSettings` — заменить на panelStore

### Критерий готовности

- [x] Все существующие панели открываются через panelStore
- [x] Панели можно перетаскивать и ресайзить
- [x] Клик по панели поднимает её поверх остальных
- [x] Mixer открыт автоматически при входе в комнату
- [x] Минимизация работает

---

## C3 — Toolbar

**Суть:** Минимальные правки к уже готовому toolbar.

**Оценка:** 0.5–1 день

**Зависимость:** C2 (кнопка toggle должна знать о режиме)

### Задачи

- [ ] Добавить кнопку `Canvas ⟷ Panels` в правую часть toolbar (переключает `viewMode: 'panels' | 'canvas'` в panelStore)
- [ ] Убрать отдельную кнопку Drum Machine из toolbar (теперь через «+» меню)
- [ ] Убрать кнопку вызова Chat из toolbar (теперь через «+» меню)
- [ ] Кнопка Settings остаётся в toolbar
- [ ] В Canvas режиме кнопка подсвечивается (active state)

### Критерий готовности

- [ ] Кнопка Canvas ⟷ Panels переключает режим
- [ ] Toolbar не содержит кнопок модулей (только транспорт + settings + toggle)

---

## C4 — Меню «+» и реестр модулей

**Суть:** Кнопка «+» открывает popup со списком доступных модулей. Зачаток NodeRegistry без нодовой архитектуры.

**Оценка:** 1–2 дня

**Зависимость:** C2

### Задачи

- [ ] Создать `src/panels/moduleRegistry.ts` — массив `ModuleDefinition[]`:
  ```ts
  { type: string; label: string; icon: string; description: string; component: React.FC }
  ```
  Зарегистрировать: Mixer, Drum Machine, Chat, Video, Metronome, Settings
- [ ] Кнопка «+» в toolbar (рядом с кнопкой toggle)
- [ ] Popup-меню: список модулей из реестра, иконка + название + описание
- [ ] Клик на модуль → `panelStore.openPanel(type)`
- [ ] Если панель уже открыта → `panelStore.focusPanel(id)` (не открывать дубль)
- [ ] Стиль popup: тёмный, `border: 1px solid #c8a84b33`, анимация появления

### Критерий готовности

- [ ] Все модули открываются через «+» меню
- [ ] Повторное нажатие фокусирует, не создаёт дубль

---

## C5 — Video Grid панель

**Суть:** Вырезать видео-секцию из App.tsx и завернуть в FloatingPanel. Компонент VideoTile.tsx уже готов.

**Оценка:** 1–2 дня

**Зависимость:** C2

### Задачи

- [ ] Создать `src/components/VideoGridPanel.tsx` — переносит логику видео-сетки из App.tsx (строки ~1075–1160)
- [ ] Props: `{ participants, localStream, remoteStreams, fullscreenSocketId, onFullscreenToggle }`
- [ ] Поддержать оба существующих режима: grid и theater (fullscreen)
- [ ] Зарегистрировать в `moduleRegistry.ts` как `'video'`
- [ ] Удалить захардкоженную видео-секцию из App.tsx

### Критерий готовности

- [ ] Видео открывается через «+» → Video
- [ ] Theater mode (fullscreen участника) работает внутри панели
- [ ] Локальное и удалённое видео отображаются корректно

---

## C6 — Canvas режим

**Суть:** React Flow холст — те же панели как ноды, зум, мини-карта. Кабели не реализуются.

**Оценка:** 3–4 дня

**Зависимость:** C2; установить `@xyflow/react`

### Задачи

- [ ] Установить `@xyflow/react`
- [ ] Создать `src/canvas/CanvasView.tsx` — `<ReactFlow>` с настройками: точечный grid-фон, `<MiniMap>`, `<Controls>` (zoom in/out/fit)
- [ ] Создать кастомный `nodeTypes.panelNode` — рендерит тот же `FloatingPanel` компонент внутри React Flow ноды
- [ ] При переключении в Canvas режим — конвертировать открытые панели в React Flow nodes (позиции из canvasPositions из C7)
- [ ] При переключении обратно в Panels — конвертировать nodes обратно в панели
- [ ] Drag нод в Canvas обновляет canvasPositions в panelStore
- [ ] В Canvas режиме: toolbar остаётся, но панели исчезают из Panels layout и появляются как ноды
- [ ] Стиль: тёмный фон `#0c0c0c`, grid-точки `#1e1e1e`, MiniMap с цветами по типу панели

### Критерий готовности

- [ ] Переключение Canvas ⟷ Panels работает без потери состояния панелей
- [ ] Ноды можно перемещать на холсте
- [ ] MiniMap показывает все открытые ноды
- [ ] Zoom и fit работают

---

## C7 — Синхронизация позиций Panel ↔ Canvas

**Суть:** Два независимых набора позиций. При первом переходе в Canvas — инициализация из панельных позиций.

**Оценка:** 0.5–1 день

**Зависимость:** C2, C6

### Задачи

- [ ] В panelStore добавить `canvasPositions: Record<panelId, {x: number, y: number}>`
- [ ] При первом `setViewMode('canvas')`: для каждой открытой панели без canvasPosition — скопировать `position.x / position.y` из панельного стейта
- [ ] Drag ноды в Canvas → обновляет `canvasPositions[id]`, не трогает `position` (панельные)
- [ ] При возврате в Panels — панели восстанавливаются на своих panelPositions (независимо от canvas)

### Критерий готовности

- [ ] Mixer открыт слева в Panels → при переходе в Canvas появляется слева
- [ ] Перемещение ноды в Canvas не сдвигает панель в Panels режиме

---

## C8 — Сохранение раскладки

**Суть:** Persist panelStore в localStorage через zustand/middleware.

**Оценка:** 0.5 дня

**Зависимость:** C2

### Задачи

- [ ] Подключить `persist` middleware из `zustand/middleware` к panelStore
- [ ] Сохранять: открытые панели, их позиции, размеры, canvasPositions
- [ ] НЕ сохранять: zIndex (сбрасывается при каждом запуске), isMinimized (спорно, обсудить)
- [ ] Ключ localStorage: `kgb_panel_layout`
- [ ] При входе в комнату: восстановить раскладку, если есть; иначе открыть Mixer по умолчанию

### Критерий готовности

- [ ] Перезапуск программы → панели на тех же местах
- [ ] Mixer всегда открыт (даже если раскладка пустая)

---

## C9 — Кабели и NodeRegistry

**Суть:** Полная нодовая архитектура с визуальными соединениями. Реализуется после Phase 2 и стабилизации C1–C8.

**Оценка:** 3–4 недели

**Статус:** 🚧 В разработке — задачи будут детализированы отдельно

### Предварительный план

- [ ] `ControlBus` (mitt) — типизированная шина событий между нодами
- [ ] `NodeRegistry` — регистрация типов нод с декларацией портов (audio / control / trigger / midi)
- [ ] Рефакторинг `metronome.ts`, `drumMachine.ts`, `mixerEngine.ts` → NodeDefinition
- [ ] React Flow edges — визуальные кабели по типу порта (синий=audio, золото=control, фиолетовый=trigger)
- [ ] UI для соединения нод: drag от output-порта к input-порту
- [ ] Сохранение графа соединений

---

## Общий прогресс

| Задача | Прогресс |
|---|---|
| C1 — Стартовый экран | 100% |
| C2 — Floating Panels система | 100% |
| C3 — Toolbar | 0% |
| C4 — Меню «+» и реестр модулей | 0% |
| C5 — Video Grid панель | 0% |
| C6 — Canvas режим | 0% |
| C7 — Синхронизация позиций | 0% |
| C8 — Сохранение раскладки | 0% |
| C9 — Кабели и NodeRegistry | 🚧 отложено |

---

*KGB Sound TASKS_UI.md v1.0 — UI Redesign: Floating Panels + React Flow Canvas*
