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
| `SPRINTS.md` | Ordered action plan + paste-ready prompts, per contributor track |
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

---

## Two-contributor split (zero shared files)

Two people work in parallel. The boundary is drawn so **every file has exactly one
owner** — the two former hot spots (`addon.cc`, `App.tsx`) each became single-owner.

| Track | Owner | Owns (edits) |
|---|---|---|
| **Engine / Native / VST** | Ivan (+assistant) | `client/electron/nativeAudio/**` (`addon.cc`, `utilityHost.mjs`, `ipc.js`, `preload.js`), `electron.d.ts`, audio engine modules (`audioEngine`, `recorder`, `nativeAudioController`, `nativeRtcManager`, `midiPlayer`, `audioClipPlayer`, `metronome`, `drumMachine` engine class), `exportClip` logic, `insertChainStore`, the whole VST3 host |
| **UI / Server / Sync** | nik | all `.tsx` (incl. `App.tsx` orchestration: record/transport/sync handlers), `server/**`, sync layer (`syncProtocol.ts`, `schemas.js`, `roomSyncClient.ts`, `timelineSync.ts`, `networking/**`, `drumNodes.ts` sync glue), `timelineStore` (UI+sync data model), React-render perf, App decomposition |

**Rule:** never edit the other track's files. Cross-needs go through the contract,
not by editing across the line:
- UI calls **engine modules / `window.nativeAudio` API** and reads **stores** (zustand).
- Engine reads `timelineStore` (read-only, in `audioClipPlayer`) and imports
  `syncProtocol` **types** (read-only). It does not mutate them.
- Need a new field/method? The owner of that file adds it; the other consumes it.

**Contract surface (agree once, then build to it):** `insertChainStore` shape
(slots / params / bypass / per-insert latency) + `window.nativeAudio` VST methods
(`scanVst3`, `loadPlugin`, `unloadPlugin`, `openEditor`, `getParam`, `setParam`,
`getPluginState`). The sync event schema (`syncProtocol.ts` ↔ `schemas.js`) is nik's;
the engine only imports its types.

### Merge workflow (the divergence killer)

The 2026-06-16 reconciliation cost a 4000-line manual merge because changes were
swapped as **folders**, not through git. Never again:
1. Single shared remote: `origin` (`github.com/Ivan-2000/kgb-sound-system-1984`). It is
   the integration point — **no folder hand-offs**.
2. Short-lived branches per item → push → merge to `main` → the other runs
   `git pull --rebase` **daily**. Small and frequent, never a big-bang drop.
3. The native addon binary (`*.node`) and the VST3 SDK are git-ignored / env-var
   (`KGB_VST3_SDK_DIR`) — each rebuilds locally; no binaries in git.

### Build order (dependencies between the tracks)

```
Engine:  E1 VST host (V1–V3,V6,V9) → E2 VST integ (V4,V8,V10,I1/I3) →
         E3 audio blockers (§1,§2,§4) → E4 export + §9.A worker-thread + §9.D memory
nik:     §3 server (CRITICAL, first) → §5 sync correctness (clip LWW, late-joiner audio)
         → §8.C App decomposition → InsertChain UI (V5/V7 on our store) → §9.C render → Phase 5 UI
```

`§9.A` (Opus worker-thread, `addon.cc`) is now single-owner (Engine) — no cross-track
sequencing needed. VST default build stays **OFF** (`build:asio` needs no VST SDK).
