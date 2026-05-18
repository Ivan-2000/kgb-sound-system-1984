# KGB Sound System 85

## AGENTS.md

AI-agent working guide for the video-integrated collaborative rehearsal platform.

---

## Product Understanding

KGB Sound System 85 is a Windows desktop application for musicians that combines:

- realtime drum sequencing;
- collaborative rhythm editing;
- integrated rehearsal video communication;
- music-oriented voice chat;
- synchronized BPM and transport playback;
- participant audio mixing;
- online rehearsal rooms with invite links.

The product should feel like:

```text
Zoom + Groovebox + Rehearsal Studio
```

It is not a professional DAW, not a true zero-latency internet jamming engine, and not a native UDP rehearsal system in the MVP.

---

## Required Task Workflow

Before starting any implementation task, an agent must:

- read the current documents in `docs/`;
- read `TASKS.md`;
- identify the relevant roadmap phase and checklist items;
- keep the implementation aligned with the latest architecture and roadmap.

After completing a task, an agent must update `TASKS.md`:

- mark completed checklist items;
- add newly discovered subtasks when needed;
- leave unfinished or blocked items unchecked;
- keep acceptance criteria current with the actual project state.

Do not treat `TASKS.md` as static documentation. It is the live project task tracker and must stay synchronized with completed work.

---

## System Priorities

Follow this order when making tradeoffs:

1. Drum synchronization
2. Audio stability
3. Rehearsal video communication
4. UI responsiveness
5. Visual effects

Audio timing, transport stability, and drum synchronization always take priority over video rendering and decorative visuals.

---

## Target Stack

Desktop:

- Electron
- Electron Builder

Frontend:

- React
- TypeScript
- Vite
- Zustand
- TailwindCSS

Audio:

- Tone.js
- Web Audio API

Networking:

- Socket.IO
- WebRTC
- simple-peer

Validation:

- zod

---

## Repository Shape

Expected project structure:

```text
client/
  electron/
  public/
    samples/
  src/
    audio/
    drumMachine/
    networking/
    rtc/
    video/
    mixer/
    protocol/
    hooks/
    store/
    ui/
    components/
    types/
    App.tsx

server/
  rooms/
  socket/
  protocol/
  index.js
```

---

## Architecture Rules

Always keep major subsystems isolated:

- audio;
- drum machine;
- networking;
- RTC;
- video;
- mixer;
- protocol;
- store;
- UI.

Do not place Socket.IO, WebRTC, or sync protocol logic directly inside React UI components. UI components should call hooks or services.

Do not tightly couple video state with audio state. Video can degrade under load, but audio transport must remain stable.

Do not schedule audio with `setTimeout` or UI render loops. Use Tone.js transport and Web Audio timing primitives.

Do not mutate Zustand state directly outside approved store actions.

Do not block the main/rendering thread with heavy synchronous work.

---

## Sync Model

MVP networking uses small room mesh networking for 2-4 participants.

The first participant is the authoritative host:

- BPM authority;
- transport authority;
- playback position authority.

Pattern editing uses Last Write Wins.

Required sync event types:

```text
step_toggle
transport_play
transport_stop
bpm_change
participant_join
participant_leave
camera_toggle
mic_toggle
```

All incoming network payloads must be validated with `zod`.

Prevent event loops: received remote events must not be blindly rebroadcast.

---

## Audio Rules

The Audio Engine owns:

- Tone.js initialization;
- `Tone.Transport`;
- BPM control;
- playback transport;
- timing management.

Audio must be unlocked from a user gesture:

```typescript
await Tone.start()
```

Supported BPM range:

```text
60-240 BPM
```

Drum sounds are generated locally on each client and synchronized through events. Do not stream drum machine output as raw audio in the MVP.

Required sample files:

```text
client/public/samples/kick.wav
client/public/samples/snare.wav
client/public/samples/hat.wav
client/public/samples/crash.wav
```

---

## Drum Machine Rules

MVP drum machine configuration:

- 16 steps;
- 4 tracks;
- 4/4 timing;
- looping playback.

Initial tracks:

- kick;
- snare;
- hat;
- crash.

Pattern state:

```typescript
{
  kick: boolean[];
  snare: boolean[];
  hat: boolean[];
  crash: boolean[];
}
```

---

## RTC And Video Rules

Video is a core rehearsal feature, not an afterthought.

Required MVP video capabilities:

- local camera;
- remote participant cameras;
- responsive participant video grid;
- camera enable/disable;
- fullscreen participant mode;
- active speaker display;
- reconnect recovery.

Supported layout modes:

- grid mode;
- theater mode;
- fullscreen participant;
- floating drummer mode.

Participant video state should include:

```typescript
{
  id: string;
  username: string;
  cameraEnabled: boolean;
  micEnabled: boolean;
  connectionQuality: number;
  isHost: boolean;
}
```

Under high CPU or network load, the app may reduce video FPS, reduce video resolution, or disable effects. It must not freeze audio playback or transport synchronization.

---

## Voice Chat Rules

Use WebRTC through `simple-peer`.

Music mode audio constraints:

```typescript
{
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}
```

Peer manager responsibilities:

- create peers;
- manage media streams;
- track participant state;
- recover from disconnects;
- reconnect streams.

---

## Mixer Rules

Participant audio graph:

```text
MediaStream
-> GainNode
-> StereoPannerNode
-> AnalyserNode
-> Master Bus
```

Per participant controls:

- volume;
- mute;
- solo;
- stereo pan;
- level meter.

Master bus controls:

- master volume;
- compressor.

---

## UI And Design Rules

Main rehearsal layout:

```text
Header
Video Grid
Drum Machine
Transport Controls
Mixer
Participants
```

Design language:

```text
Persian Luxury Cyber
```

Visual themes:

- black;
- graphite;
- gold;
- amber glow;
- crystal highlights.

UI must remain readable, responsive, musician-friendly, and stage-ready.

Heavy animations and visual effects must never interrupt:

- audio playback;
- transport timing;
- video rendering;
- realtime sync.

---

## Implementation Preferences

Prefer:

- typed protocol definitions;
- small services;
- reusable hooks;
- event-driven updates;
- focused components;
- schema validation at boundaries;
- clear module ownership.

Avoid:

- giant components;
- networking inside UI components;
- overengineered sync layers;
- distributed consensus;
- custom UDP transport in MVP;
- premature latency optimization;
- CRDT complexity in MVP.

---

## MVP Boundary

In scope:

- Electron desktop shell;
- local drum machine;
- room server;
- invite links;
- realtime drum sync;
- voice chat;
- integrated video;
- participant mixer;
- session UX;
- Windows installer.

Out of scope for MVP:

- ASIO support;
- native DSP engine;
- VST support;
- MIDI controllers;
- OBS integration;
- recording;
- AI drummer;
- Ableton Link;
- mobile companion app.

---

## Verification Checklist

Before calling work complete, verify the relevant area:

Audio:

- BPM remains stable;
- sequencer loops correctly;
- no duplicate drum triggers;
- autoplay unlock flow works.

Video:

- local camera appears;
- remote streams appear;
- camera toggle works;
- fullscreen participant mode works;
- reconnect recovery works.

Networking:

- rooms create and join;
- invite links work;
- sync events broadcast correctly;
- invalid payloads are rejected;
- no event loops.

UI:

- rehearsal layout is responsive;
- sequencer is usable;
- video grid is stable;
- mixer controls remain responsive.
