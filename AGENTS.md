# KGB Sound System 85 — AGENTS.md

AI-agent working guide. **Read this first, then the authoritative docs below.**

> **This file was rewritten 2026-06-01 to match the current strategy.** An older
> version described an MVP "Zoom + Groovebox" with ASIO/VST/MIDI/recording
> explicitly *out of scope* and a fixed UI layout. That is obsolete and was
> contradicting the real project. Ignore any cached memory of it.

---

## Authoritative documents

| Doc | Owns |
|---|---|
| `CLAUDE.md` | Hard rules (TypeScript, build facts, coding constraints, model policy) |
| `TASKS.md` | Audio/network/recording phases — native engine (Stream A), mixer, recording, MIDI |
| `TASKS_UI.md` | **The node-graph UI — the foundation (stream G).** Node contract, panels/canvas, node specs |
| `client/src/graph/types.ts` | The node contract third-party nodes implement |

If anything below conflicts with these, the docs win — and fix this file.

---

## Core strategy — the node graph IS the UI foundation

**Every element/instrument is a NODE** — mixer, metronome, drum machine, timeline,
piano roll, math/utility nodes, and more. Nodes:

- have typed **inputs/outputs** that differ per node (`audio` / `control` /
  `trigger` / `value` / `midi`);
- **exchange data** over connections;
- can be authored by **third parties** — a developer who knows the contract writes
  a node as a JS/TS module, drops it in, and the program understands and accepts it.

This node graph is the data model. There are **two views over the same graph**:

- **Panels** — nodes shown as floating panels, no visible cables, in a preset
  layout. For less-advanced users.
- **Canvas** — the same nodes on a React-Flow board with cables, zoom, minimap.
  For advanced users.

Switching the view never changes the graph. The graph is shared per room
(topology + params + positions sync); the chosen view and physical audio-device
binding are personal. See `TASKS_UI.md` for the full design and `node-spec.md` /
`ui-graph-first` in memory for decisions.

**Signal model (hybrid):** `control`/`trigger`/`value`/`midi` flow locally through
a `ControlBus` in the renderer; `audio` ports are routing *declarations* — real
audio is mixed natively in the PortAudio engine, never through the JS graph.

---

## Current state (2026-06-01)

- **Native audio engine** (PortAudio: ASIO / WASAPI / DirectSound / MME, CoreAudio,
  ALSA) is **built through A6** — capture, Opus encode/decode, WebRTC DataChannel
  transport, jitter buffer, round-trip latency. ASIO/VST/MIDI/recording/timeline are
  **in scope** (roadmap), not excluded.
- **Graph core G1–G3 done**: `client/src/graph/` (contract, ControlBus, NodeRegistry,
  graphStore with a single synced mutation funnel). PanelsView + FloatingPanel render
  from `graphStore`; `panelStore` was removed. Mixer/metronome/drum are built-in nodes.
- **Mixer node** = horizontal rack of vertical strips; each strip = vertical volume
  fader + peak meter + M/S/→ buttons + small pan knob + round record button; tinted by
  the participant's deterministic color. Master = same strip (volume + pan + record),
  no slots. Per-channel record → timeline track (lands with the Timeline node).
- Next per build order: Timeline skeleton → Piano Roll + drum midi-in → math/util nodes.

---

## Still-valid technical guardrails

- **TypeScript only, no `any`** in client code. Server is CommonJS.
- **Zod-validate every socket event** on the server (`safeParse`) before touching room state.
- **Audio timing is independent from React renders** — no `setState` inside Tone.js
  callbacks or audio loops; use refs for values read in audio callbacks. Schedule with
  Tone.js / Web Audio primitives, not `setTimeout`/render loops.
- **Keep subsystems isolated** — audio, drum machine, networking, RTC, video, mixer,
  protocol, graph, UI. No Socket.IO/WebRTC/sync logic directly inside React components.
- **Sync the graph, not the signals** — host gates transport/BPM; collaborative edits
  use Last-Write-Wins; received remote events are never blindly rebroadcast.
- **Asset paths relative** (`./samples/...`); `base: './'` in vite.config.ts; Electron
  renderer has no Node access (contextIsolation/sandbox on).

---

## Workflow

Before a task: read `CLAUDE.md`, `TASKS.md`, `TASKS_UI.md`; find the relevant phase/stream.
After a task: update the relevant TASKS doc (mark done, add discovered subtasks, keep
acceptance criteria current). The TASKS docs are the live tracker, not static.
