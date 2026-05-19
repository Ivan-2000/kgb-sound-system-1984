# CLAUDE.md

Project rules for Claude Code working on this repo.

This file is read by Claude Code at the start of every session. Keep it short.
Source of truth for phases, status, and acceptance criteria: **`TASKS.md`**.

---

## Project

**KGB Sound System 85** — Electron desktop app for online music rehearsal.
Musicians connect over the internet: shared drum machine, real-time audio/video, mixer, recording, timeline.

Stack: Electron + React + TypeScript + Vite (client), Node.js + Socket.IO (signaling server), WebRTC via simple-peer, Tone.js + Web Audio API.

> **Current audio transport is a prototype.** Audio runs through browser `getUserMedia` + WebRTC MediaStream. The target architecture is native: PortAudio (ASIO / WASAPI / CoreAudio / ALSA) in the Electron main process, with Opus over WebRTC DataChannel. The native engine is the critical block of Phase 1 (Stream A in TASKS.md).

Key docs:
- `TASKS.md` — phase checklist, parallel streams, what's done and what's next (**authoritative**)
- `kgb_sound_roadmap.md` — full spec with phases and acceptance criteria

**Read TASKS.md before writing any code.** If a task spans multiple layers, read both sides first.

---

## Repo structure

```
KGB_SOUND/
├── client/                  # Electron + React app
│   ├── electron/main.js     # Electron main process (ESM)
│   ├── src/
│   │   ├── App.tsx          # Root component, room state, event wiring
│   │   ├── audio/           # Tone.js engine, BPM, transport, clockSync (NTP drift correction)
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
- **A1 — native audio binding strategy** (naudiodon vs. node-addon-api + PortAudio C++, IPC schema between main and renderer) — Phase 1, Stream A
- A bug that Sonnet attempted twice without solving
- Architectural decisions that span 3+ layers

Other heavy architectural work starts on Sonnet 4.6. Escalate to Opus only if Sonnet stalls — don't pre-assign Opus.

**Switch back to Sonnet immediately after the Opus task is done.**

If you think Opus is needed, say so explicitly:
> "This needs Opus because [reason]. Switch with `/model opus`, then back to Sonnet after."

If the user is on Opus and the task is routine, suggest:
> "This task is fine for Sonnet. Want to switch with `/model sonnet`?"

---

## Parallel streams

Work follows two parallel streams — check `TASKS.md` "Схема работы" before starting any new task.

- **Stream A** — Native audio engine (critical path, sequential: A1 → A2 → A3 → A4 → A5 → A6). Blocks Phase 2 and Phase 3.
- **Stream B** — Independent tasks that don't depend on the native engine (signaling polish, drum machine, UI). Can be picked up any time.

> Phase 2 and Phase 3 only start after A3 (capture works). Phase 3 additionally requires Phase 2.

If the user asks for something out of order within Stream A, ask whether to defer or skip ahead deliberately.

---

## Session hygiene

Long sessions burn the usage limit faster — every reply re-reads the whole conversation.

**Tell the user to open a new session when:**
- A phase or sub-task from `TASKS.md` just completed
- The conversation has grown past ~30 back-and-forth turns
- The topic shifts significantly (e.g. from audio engine to UI, or from networking to recording)
- A long file dump has filled context with material no longer needed

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
- **Room events are host-gated** — `transport_play`, `transport_stop`, `bpm_change`, `time_signature_change`, `metronome_toggle`, `swing_change`, `step_count_change`, `pattern_switch`, `chain_set`, `strong_beat_change`, `sync_only_toggle` are rejected by the server if sender is not host. Full list in `server/socket/registerSocketHandlers.js` → `hostOnlyTypes`. Don't bypass on the client.

---

## Critical build facts

These are non-obvious and have caused bugs before — don't skip them:

1. `base: './'` in `vite.config.ts` is mandatory. Without it, Electron shows a black screen (assets load as absolute `file:///assets/...` and 404).
2. `electron` and `electron-builder` must be in `devDependencies`, not `dependencies`. Electron-builder enforces this.
3. Sample paths in `drumMachine.ts` must be `./samples/*.wav` (relative), not `/samples/*.wav`.
4. The signaling server URL comes from `VITE_SIGNALING_URL` env var. Dev: `.env.development` (localhost). Prod: `.env.production` (Render URL).
5. Render.com ignores `render.yaml` if the service was created manually via UI — fix Build Command to `npm install` and Start Command to `node server/index.js` in the dashboard.
