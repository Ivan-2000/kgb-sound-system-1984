# CLAUDE.md

Project rules for Claude Code working on this repo.

This file is read by Claude Code at the start of every session. Keep it short.

---

## Project

**KGB Sound System 85** — Electron desktop app for online music rehearsal.
Musicians connect over the internet: shared drum machine, real-time audio/video, mixer, recording, timeline.

Stack: Electron + React + TypeScript + Vite (client), Node.js + Socket.IO (signaling server), WebRTC via simple-peer, Tone.js + Web Audio API.

Key docs:
- `TASKS.md` — phase checklist, what's done and what's next
- `kgb_sound_roadmap.md` — full spec with phases and acceptance criteria

Read the relevant doc before writing code. If a task spans multiple layers, read both sides first.

---

## Repo structure

```
KGB_SOUND/
├── client/                  # Electron + React app
│   ├── electron/main.js     # Electron main process (ESM)
│   ├── src/
│   │   ├── App.tsx          # Root component, room state, event wiring
│   │   ├── audio/           # Tone.js engine, BPM, transport
│   │   ├── drumMachine/     # Step sequencer logic
│   │   ├── mixer/           # Web Audio mixer (GainNode, Panner, Analyser)
│   │   ├── networking/      # Socket.IO client, room state
│   │   ├── rtc/             # WebRTC via simple-peer
│   │   ├── components/      # VideoTile, MixerChannel, etc.
│   │   └── protocol/        # Shared event types (TypeScript)
│   └── public/samples/      # kick.wav, snare.wav, hat.wav, crash.wav
├── server/
│   ├── index.js             # HTTP + Socket.IO server (CommonJS)
│   ├── rooms/               # Room manager, short code generation
│   ├── socket/              # Socket event handlers
│   └── protocol/schemas.js  # Zod validation schemas
└── render.yaml              # Render.com deploy config
```

---

## Model usage policy

Default: **Sonnet 4.6**. Use Opus rarely.

### Use Haiku 4.5 for
- CSS tweaks, App.css edits
- Config files (vite.config.ts, tsconfig, package.json)
- Boilerplate React components with no logic
- Renaming variables or files
- Reading and summarizing files
- Lint and format fixes

### Use Sonnet 4.6 (default) for
- React components and hooks
- Audio engine wiring (Tone.js, Web Audio API)
- WebRTC peer setup and stream handling
- Socket.IO event handlers (client and server)
- Mixer logic (GainNode, StereoPannerNode, AnalyserNode)
- Electron main process changes
- Build pipeline and packaging
- Most debugging

### Use Opus 4.7 only when
- Designing native audio architecture (ASIO / CoreAudio / PortAudio) — Phase 2
- NTP-like clock sync and drift correction — Phase 4
- Designing the recording pipeline with latency compensation — Phase 2
- Designing the timeline / arrange window architecture — Phase 3
- A bug that Sonnet attempted twice without solving
- Architectural decisions that span 3+ layers

**Switch back to Sonnet immediately after the Opus task is done.**

If you think Opus is needed, say so explicitly:
> "This needs Opus because [reason]. Switch with `/model opus`, then back to Sonnet after."

If the user is on Opus and the task is routine, suggest:
> "This task is fine for Sonnet. Want to switch with `/model sonnet`?"

---

## Session hygiene

Long sessions burn the usage limit faster — every reply re-reads the whole conversation.

**Tell the user to open a new session when:**
- A phase from `TASKS.md` just completed
- The conversation has grown past ~30 back-and-forth turns
- The topic shifts significantly (e.g. from audio engine to UI, or from networking to recording)
- A long file dump has filled context with material no longer needed
- The user is starting a new phase from the roadmap

Phrase it plainly:
> "This is a good point to start a fresh session. Current context is large and the next task is unrelated to what we just did. New session = lower token usage per reply."

Do not nag. One suggestion per natural breakpoint. If the user says "keep going", drop it.

---

## Token economy

Read whatever you need to write correct code. Correctness first, economy second.

- Before editing a function, check where it's called. Before changing a type, check who imports it.
- Read only the relevant section of large files using line ranges.
- Prefer `str_replace` for small edits. For rewrites touching most of a file, rewrite cleanly.
- Batch related edits across files in one turn.
- If you're unsure whether to read a file, **read it**. A few extra tokens beat a broken build.

---

## Coding rules

Non-negotiables:

- **TypeScript only, no `any`** — client code is fully typed
- **Asset paths must be relative** — use `./samples/kick.wav`, never `/samples/kick.wav`. Electron loads from `file://` — absolute paths break silently.
- **`base: './'` in vite.config.ts** — required for Electron. Never remove it.
- **Audio timing is independent from React renders** — no `setState` inside Tone.js callbacks or Web Audio `onaudioprocess`
- **No store writes in audio loops** — use refs for values read inside audio callbacks
- **Zod validation on every socket event** — all `socket.on(...)` handlers on the server validate with `safeParse` before touching room state
- **Server is CommonJS** (`require`) — `server/` uses Node.js CommonJS. Do not add `import` syntax there.
- **Client is ESM** (`import`) — `client/src/` and `client/electron/` use ES modules.
- **Electron renderer has no Node.js access** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. All APIs are Web APIs.
- **Room events are host-gated** — `transport_play`, `transport_stop`, `bpm_change` are rejected by the server if sender is not host. Don't bypass this on the client.

---

## Critical build facts

These are non-obvious and have caused bugs before — don't skip them:

1. `base: './'` in `vite.config.ts` is mandatory. Without it, Electron shows a black screen (assets load as absolute `file:///assets/...` and 404).
2. `electron` and `electron-builder` must be in `devDependencies`, not `dependencies`. Electron-builder enforces this.
3. Sample paths in `drumMachine.ts` must be `./samples/*.wav` (relative), not `/samples/*.wav`.
4. The signaling server URL comes from `VITE_SIGNALING_URL` env var. Dev: `.env.development` (localhost). Prod: `.env.production` (Render URL).
5. Render.com ignores `render.yaml` if the service was created manually via UI — fix Build Command to `npm install` and Start Command to `node server/index.js` in the dashboard.

---

## Phase discipline

Work on one phase at a time, in the order in `TASKS.md`.
Check acceptance criteria before moving to the next phase.
If the user asks for something out of order, ask whether to defer or skip ahead deliberately.

Current phase order:
1. Сеть и комнаты
2. Миксер и запись
3. Монтажный стол и MIDI
4. Метроном и драм-машина (доработка)
5. UI и полировка
