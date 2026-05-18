# KGB Sound System 85

Десктопная платформа для онлайн-репетиций музыкантов: видео + голос + совместный драм-секвенсор.

## Что находится в репозитории

- `client/` — Electron + React + TypeScript приложение.
- `server/` — Socket.IO сервер комнат и сигналинга.
- `docs/` — архитектура и roadmap.

## Требования

- Node.js 20+ (рекомендуется LTS).
- npm 10+.
- Windows, macOS или Linux.

## Важно для пользователей Windows

В Windows-терминале используйте `npm.cmd` вместо `npm`.

Примеры:

- `npm.cmd install`
- `npm.cmd run dev:server`
- `npm.cmd run dev`

Если ваш shell уже корректно резолвит `npm`, могут работать оба варианта, но `npm.cmd` надежнее.

## Первая установка

Установите зависимости в корневом пакете и в `client/`.

macOS/Linux:

```bash
npm install
npm --prefix client install
```

Windows (PowerShell или cmd):

```bat
npm.cmd install
npm.cmd --prefix client install
```

## Запуск в режиме разработки

Проект запускается двумя процессами:

1. Socket.IO сервер.
2. Electron клиент (поднимает Vite + Electron).

Откройте два терминала в корне репозитория.

Терминал 1 — сервер:

macOS/Linux:

```bash
npm run dev:server
```

Windows:

```bat
npm.cmd run dev:server
```

Терминал 2 — десктоп-приложение:

macOS/Linux:

```bash
npm run dev
```

Windows:

```bat
npm.cmd run dev
```

Что происходит под капотом:

- `dev:server` запускает `node server/index.js`.
- `dev` делегируется в `client`, запускает Vite на `http://127.0.0.1:5173`, затем открывает Electron, подключенный к dev-серверу.

## Сборка

### Сборка клиентской части

macOS/Linux:

```bash
npm run build
```

Windows:

```bat
npm.cmd run build
```

### Сборка Windows-инсталлятора (NSIS)

macOS/Linux:

```bash
npm run build-win
```

Windows:

```bat
npm.cmd run build-win
```

Артефакты сборки сохраняются в `dist/` (настроено в Electron Builder).

## Запуск собранного Electron-приложения

macOS/Linux:

```bash
npm run start
```

Windows:

```bat
npm.cmd run start
```

## Проверка линтером

macOS/Linux:

```bash
npm run lint
```

Windows:

```bat
npm.cmd run lint
```

## Аудио-семплы

Обязательные семплы лежат в `client/public/samples/`:

- `kick.wav`
- `snare.wav`
- `hat.wav`
- `crash.wav`

Также могут присутствовать дополнительные варианты семплов для экспериментов.

## Типовые проблемы

- Если Electron открылся раньше, чем поднялся Vite, перезапустите `npm run dev`.
- Если не хватает модулей, переустановите зависимости в корне и в `client/`.
- Если в Windows не резолвится команда, используйте явный вызов `npm.cmd`.
