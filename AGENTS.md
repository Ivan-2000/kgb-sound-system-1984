# KGB Sound System 85 — AGENTS.md

AI-agent working guide. **Read this first, then the authoritative docs below.**

> The node-graph / React-Flow canvas UI was **removed 2026-06-14** (see
> `REFACTOR_PLAN.md`). The product is now **panels-first**. Ignore any cached
> memory describing a "node graph", "cables", "Canvas view", or "ControlBus" —
> that code no longer exists.

---

## Authoritative documents

| Doc | Owns |
|---|---|
| `CLAUDE.md` | Hard rules (TypeScript, build facts, coding constraints, model policy) |
| `TASKS.md` | Phase status, acceptance criteria, what's done / next (single source of truth) |
| `docs/kgb_sound_system_85_application_architecture_v_2.md` | System architecture & signal path |
| `docs/ADR_native_audio.md` | Native-audio decision record (PortAudio/IPC/process model) |
| `AUDIT.md` | Code-audit findings (bugs to fix — "Wave 2") |
| `REFACTOR_PLAN.md` | Log of the graph-removal refactor |

If anything below conflicts with these, the docs win — and fix this file.

---

## Core strategy — panels-first

Each module is a **self-contained floating panel**: mixer, drum machine, timeline,
metronome, video, chat, settings. There are **no links between modules** except the
**shared project transport** (one BPM / clock / time-signature per room).

- Window state (which panels are open, position, size, z, minimize) lives in
  `client/src/panels/panelStore.ts` — **local only**, never synced.
- Drum machine and timeline are **singletons** (`drumMachine/drumSingleton.ts`,
  `timeline/timelineSingleton.ts`), imported directly. `drumNodes.ts` keeps only
  the room-sync glue (`emitDrumSync` / `connectDrumRoom` / editable observable).
- Room sync covers **engine/room state only** — transport/BPM/time-signature (host-gated),
  drum pattern (LWW), timeline clips, chat, channel metadata. Not window layout.

**Audio model:** instrument input → PortAudio → Opus → WebRTC DataChannel → peers.
Tone.js/Web Audio drives the metronome/drums/timeline and is bridged into PortAudio
output ("softmix"). See the architecture doc for the full path.

---

## State

For phase status and what's done/next, see **`TASKS.md`** (do not duplicate it here).
For known bugs and their severity, see **`AUDIT.md`**.

---

## Technical guardrails

The hard rules (TypeScript/no-`any`, Zod on every socket event, audio timing off the
React render path, relative asset paths, `base: './'`, host-gated room events) live in
**`CLAUDE.md`** — that's the single source, not duplicated here. Two panels-era reminders
on top of it: keep subsystems isolated (no Socket.IO/WebRTC/sync logic inside React
components), and sync room state, not signals (collaborative edits use Last-Write-Wins;
remote events are never blindly rebroadcast).

---

## Workflow

Before a task: read `CLAUDE.md`, `TASKS.md`; find the relevant phase/stream.
After a task: update `TASKS.md` (mark done, add discovered subtasks, keep acceptance
criteria current). TASKS.md is the live tracker, not static.
