# KGB Sound System 85

# ROADMAP_V2.md

## AI-Agent Optimized Development Roadmap
## Video-Integrated Rehearsal Architecture Edition

---

# PROJECT SUMMARY

KGB Sound System 85 is a Windows desktop rehearsal platform for musicians.

The application combines:

- realtime drum sequencing;
- collaborative rhythm editing;
- integrated rehearsal video communication;
- voice chat;
- synchronized BPM playback;
- participant mixing;
- online rehearsal rooms.

The platform should feel like:

```text
Zoom + Groovebox + Rehearsal Studio
```

—not a drum machine with optional cameras.

---

# CORE PRODUCT GOALS

## 1. Collaborative Rehearsal

Musicians must be able to:

- see each other;
- hear each other;
- coordinate visually;
- edit rhythms together;
- rehearse arrangements remotely.

---

## 2. Shared Groove System

All participants share:

- drum pattern;
- BPM;
- transport state;
- playback timing.

---

## 3. Stable Desktop Experience

The system prioritizes:

- reliability;
- synchronization;
- responsive UI;
- stable networking.

The MVP does NOT attempt to:

- provide perfect zero-latency live jamming;
- replace professional DAWs;
- compete with native UDP audio engines.

---

# SYSTEM PRIORITIES

```text
1. Drum Synchronization
2. Audio Stability
3. Rehearsal Video Communication
4. Visual Effects
```

Video is a core feature.

However:
- audio synchronization;
- transport stability;
- playback timing

always take priority over visual rendering.

---

# TECH STACK

## Desktop

- Electron
- Electron Builder

## Frontend

- React
- TypeScript
- Vite
- Zustand

## Audio

- Tone.js
- Web Audio API

## Networking

- Socket.IO
- WebRTC
- simple-peer

## Validation

- zod

## Styling

- TailwindCSS

---

# REPOSITORY STRUCTURE

```text
root/
├── client/
│   ├── electron/
│   ├── public/
│   │   └── samples/
│   ├── src/
│   │   ├── audio/
│   │   ├── drumMachine/
│   │   ├── rtc/
│   │   ├── networking/
│   │   ├── mixer/
│   │   ├── video/
│   │   ├── protocol/
│   │   ├── hooks/
│   │   ├── store/
│   │   ├── ui/
│   │   ├── components/
│   │   ├── types/
│   │   └── App.tsx
│   └── package.json
│
├── server/
│   ├── rooms/
│   ├── socket/
│   ├── protocol/
│   └── index.js
│
├── ROADMAP.md
├── ARCHITECTURE.md
├── AGENTS.md
└── TASKS.md
```

---

# VIDEO SYSTEM ARCHITECTURE

## PURPOSE

Video communication is required for:

- timing cues;
- hand visibility;
- visual synchronization;
- rehearsal interaction;
- conducting signals;
- musician communication.

---

# VIDEO FEATURES

## MVP FEATURES

Required:

- local camera;
- remote participant cameras;
- participant video grid;
- camera enable/disable;
- fullscreen participant mode;
- active speaker display;
- reconnect recovery.

---

# VIDEO LAYOUT MODES

Supported modes:

- grid mode;
- theater mode;
- fullscreen participant;
- floating drummer mode.

---

# PARTICIPANT VIDEO STATE

```typescript
{
  id: string,
  username: string,
  cameraEnabled: boolean,
  micEnabled: boolean,
  connectionQuality: number,
  isHost: boolean
}
```

---

# VIDEO ROUTING

```text
WebRTC Video Stream
        ↓
Peer Manager
        ↓
Video Grid Renderer
        ↓
Participant Tiles
```

---

# VIDEO PERFORMANCE STRATEGY

Under high CPU/network load:

The application may automatically:

- reduce FPS;
- reduce video resolution;
- disable effects;
- prioritize audio.

Audio and transport synchronization must NEVER freeze because of video rendering.

---

# DEVELOPMENT PRINCIPLES

## RULE 1

DO NOT prematurely optimize latency.

The app should:
- work reliably;
- synchronize correctly;
- remain stable.

---

## RULE 2

Keep architecture modular.

Every subsystem isolated:

- audio;
- RTC;
- video;
- networking;
- mixer;
- drum machine;
- UI.

---

## RULE 3

Prefer simplicity over theoretical perfection.

Use:
- authoritative host;
- last-write-wins sync;
- small room mesh networking.

Avoid:
- distributed consensus;
- custom UDP transport;
- overengineered sync layers.

---

# PHASE 0 — PROJECT BOOTSTRAP

## GOAL

Create working Electron shell.

---

## ACCEPTANCE CRITERIA

- Electron launches
- React renders correctly
- Dev mode works
- Build pipeline works

---

# PHASE 1 — AUDIO ENGINE

## GOAL

Create stable transport/audio engine.

---

## TASKS

Create:

```text
src/audio/audioEngine.ts
```

Responsibilities:

- Tone.js initialization;
- BPM control;
- playback transport;
- timing management.

---

## ACCEPTANCE CRITERIA

- BPM updates correctly
- Transport stable
- Audio initializes properly

---

# PHASE 2 — DRUM MACHINE

## GOAL

Implement local realtime sequencer.

---

## TASKS

Features:

- 16-step sequencer;
- kick;
- snare;
- hi-hat;
- crash;
- looping playback;
- BPM sync.

---

## ACCEPTANCE CRITERIA

- Sequencer loops
- Samples trigger correctly
- BPM affects playback
- Pattern editable

---

# PHASE 3 — REHEARSAL UI FOUNDATION

## GOAL

Build functional rehearsal workspace.

---

## REQUIRED UI SECTIONS

```text
Header
Video Grid
Drum Machine
Transport Controls
Mixer
Participants
```

---

## ACCEPTANCE CRITERIA

- Sequencer visible
- Video area visible
- Controls functional
- Layout responsive

---

# PHASE 4 — ROOM SERVER

## GOAL

Create signaling backend.

---

## TASKS

Responsibilities:

- room creation;
- peer signaling;
- invite links;
- room cleanup;
- event broadcasting.

---

## ACCEPTANCE CRITERIA

- Rooms work
- Multiple users connect
- Events broadcast correctly

---

# PHASE 5 — REALTIME DRUM SYNC

## GOAL

Synchronize drum machine state.

---

## SYNC MODEL

Host authoritative for:

- BPM;
- transport;
- playback position.

Pattern sync:

```text
Last Write Wins
```

---

## EVENTS

```typescript
step_toggle
transport_play
transport_stop
bpm_change
```

---

## IMPLEMENTATION NOTES (CURRENT)

- Sync protocol is typed on client and validated with zod on server.
- Host authority is enforced server-side for `transport_play`, `transport_stop`, and `bpm_change`.
- LWW step updates are applied client-side for `step_toggle`.
- Room join returns a sync snapshot so new participants immediately receive:
  - current pattern;
  - current BPM;
  - transport playing/stopped state;
  - current step position.

All later phases must preserve compatibility with this join snapshot flow.

---

## ACCEPTANCE CRITERIA

- Patterns sync
- BPM syncs
- Play/stop syncs
- No event loops

---

# PHASE 6 — VOICE COMMUNICATION

## GOAL

Implement rehearsal voice chat.

---

## TASKS

Use:

```text
simple-peer
```

Audio settings:

```typescript
{
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}
```

---

## ACCEPTANCE CRITERIA

- Participants hear each other
- Reconnect stable
- No crashes on disconnect

---

# PHASE 7 — INTEGRATED VIDEO SYSTEM

## GOAL

Implement realtime rehearsal video communication.

---

## TASKS

### Camera Access

Implement:

```typescript
video: true
```

---

### Video Grid

Requirements:

- local camera tile;
- remote participant tiles;
- responsive grid layout;
- participant labels;
- active speaker highlight.

---

### Camera Controls

Required:

- enable camera;
- disable camera;
- mute video;
- fullscreen participant.

---

### Reconnect Recovery

Requirements:

- peer reconnect;
- stream recovery;
- camera reinitialization.

---

## ACCEPTANCE CRITERIA

- Video visible
- Multiple participants visible
- Camera toggles functional
- Fullscreen mode works
- Reconnect stable

---

# PHASE 8 — MIXER SYSTEM

## GOAL

Implement participant audio mixer.

---

## AUDIO GRAPH

```text
MediaStream
→ GainNode
→ StereoPannerNode
→ AnalyserNode
→ Master Bus
```

---

## FEATURES

Per participant:

- volume slider;
- mute;
- solo;
- stereo pan;
- level meter.

---

## ACCEPTANCE CRITERIA

- Volume adjustable
- Mute works
- Meter active
- Master stable

---

# PHASE 9 — SESSION EXPERIENCE

## GOAL

Improve room usability.

---

## FEATURES

- invite links;
- usernames;
- host indicator;
- participant status;
- reconnect handling.

---

## ACCEPTANCE CRITERIA

- Invite links functional
- Participants visible
- Reconnect stable

---

# PHASE 10 — VISUAL DESIGN

## GOAL

Apply KGB Sound System 85 identity.

---

# DESIGN LANGUAGE

## Persian Luxury Cyber

Themes:

- black;
- graphite;
- gold;
- amber glow;
- crystal highlights.

---

## REQUIREMENTS

- readable controls;
- luxury appearance;
- stage-ready layout;
- responsive video grid;
- low CPU impact.

---

# PHASE 11 — BUILD & DISTRIBUTION

## GOAL

Generate Windows installer.

---

## OUTPUT

```text
KGB Sound System 85 Setup.exe
```

---

## ACCEPTANCE CRITERIA

- Installer generated
- App launches correctly
- Assets packaged correctly

---

# AI AGENT RULES

## ALWAYS

- keep systems modular;
- isolate RTC logic;
- separate video rendering from audio logic;
- validate network payloads;
- use typed protocols.

---

## NEVER

- place networking inside UI components;
- schedule audio with setTimeout;
- block rendering thread;
- tightly couple video/audio state.

---

## PREFER

- reusable hooks;
- service architecture;
- event-driven updates;
- small focused components.

---

# TESTING CHECKLIST

## AUDIO

- BPM stable
- Sequencer loops
- No duplicate triggers

---

## VIDEO

- Cameras reconnect
- Fullscreen works
- Grid updates correctly
- Multiple streams visible

---

## NETWORKING

- Rooms connect
- Sync stable
- Invite links work

---

## UI

- Responsive layout
- Mixer responsive
- Video layout stable

---

# FUTURE FEATURES

NOT MVP.

Possible future upgrades:

- ASIO support
- native DSP engine
- VST support
- MIDI controllers
- OBS integration
- recording
- AI drummer
- Ableton Link
- mobile companion app

---

# FINAL TARGET

Deliver a:

- stable;
- collaborative;
- visually unique;
- musician-oriented;
- video-integrated rehearsal platform

that works as a real Windows desktop application today.
