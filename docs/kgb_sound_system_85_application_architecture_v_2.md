# KGB Sound System 85

# APPLICATION_ARCHITECTURE.md

## Video-Integrated Collaborative Rehearsal Platform

### Version 3.0
### Architecture Specification
### Updated: 2026-05-18 — Native audio architecture (PortAudio / ASIO / WASAPI)

---

# 1. SYSTEM OVERVIEW

KGB Sound System 85 is a Windows desktop application for:

- online music rehearsals;
- collaborative rhythm creation;
- realtime drum sequencing;
- integrated rehearsal video communication;
- synchronized BPM playback;
- participant audio mixing.

The application combines:

```text
Video Conferencing
+ Drum Machine
+ Collaborative Sequencer
+ Music-Oriented Audio Chat
+ Rehearsal Workspace
```

The platform is designed for:

- bands;
- producers;
- rehearsal groups;
- songwriting sessions;
- groove collaboration.

---

# 2. PRODUCT POSITIONING

## WHAT THE PRODUCT IS

KGB Sound System 85 is:

- a collaborative rehearsal platform;
- a musician-oriented communication tool;
- a synchronized groove workstation;
- a realtime rhythm collaboration system.

---

# WHAT THE PRODUCT IS NOT

The application does NOT attempt to:

- replace professional DAWs (Pro Tools, Logic, Ableton);
- provide a full mixing and mastering suite;
- compete with SFU-based broadcast platforms.

The application DOES provide:

- professional-grade instrument audio transport via native drivers (ASIO / WASAPI / CoreAudio);
- latency suitable for live instrument play over LAN (target ≤ 30 ms round-trip);
- a collaborative rehearsal workspace, not just a conferencing call.

The product prioritizes:

- audio latency and quality above all;
- stability and reconnect resilience;
- synchronization of transport and rhythm;
- collaborative workflow.

---

# 3. CORE SYSTEM PRIORITIES

```text
1. Drum Synchronization
2. Audio Stability
3. Video Communication
4. UI Responsiveness
5. Visual Effects
```

Audio synchronization always takes priority over visual rendering.

---

# 4. HIGH-LEVEL ARCHITECTURE

```text
┌──────────────────────────────────┐
│          ELECTRON APP            │
├──────────────────────────────────┤
│                                  │
│        React UI Layer            │
│                                  │
├──────────────────────────────────┤
│      Realtime Sync Layer         │
├──────────────────────────────────┤
│         RTC Layer                │
├──────────────────────────────────┤
│       Video System               │
├──────────────────────────────────┤
│       Mixer Engine               │
├──────────────────────────────────┤
│       Drum Machine               │
├──────────────────────────────────┤
│        Audio Engine              │
└──────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────┐
│        SIGNALING SERVER          │
│        Node.js + Socket.IO       │
└──────────────────────────────────┘
```

---

# 5. TECHNOLOGY STACK

## Desktop Layer

### Electron

Responsibilities:
- Windows desktop application;
- native executable;
- packaging;
- hardware access.

---

# Frontend Layer

## React

Responsibilities:
- rendering UI;
- component architecture;
- realtime updates.

---

## TypeScript

Responsibilities:
- typed networking;
- maintainability;
- scalable architecture.

---

## Zustand

Responsibilities:
- application state;
- synchronized session state;
- participant state.

---

# Audio Stack

## PortAudio (via Electron native addon)

Responsibilities:
- enumerate all audio devices and their available Host APIs;
- capture PCM from instrument inputs via the selected driver;
- play back decoded PCM to output channels via the selected driver;
- reinitialize device without restarting the application.

Supported Host APIs (Windows, in priority order):

| Host API | Target latency | Notes |
|----------|---------------|-------|
| ASIO | < 10 ms | Professional interfaces with dedicated ASIO driver |
| WASAPI Exclusive | 10–30 ms | Modern sound cards, Windows Vista+ |
| WASAPI Shared | 30–50 ms | Device shared with other applications |
| DirectSound | 50–100 ms | Broad compatibility, legacy devices |
| MME | 100+ ms | Last resort fallback |

macOS: CoreAudio only. Linux: ALSA or JACK.

Auto-selection picks the best available Host API for the chosen device. User can override.

---

## Tone.js

Responsibilities:
- drum machine and metronome sequencer transport;
- timing engine for step scheduling;
- BPM management;
- sample playback for drum sounds.

Note: Tone.js manages drum/metronome timing only. Instrument audio is handled by PortAudio, not Web Audio.

---

## Web Audio API

Responsibilities:
- mixer graph for incoming remote audio streams (gain, pan, analyse);
- VU-meter analysis via AnalyserNode;
- master bus compressor.

Note: Web Audio API processes decoded PCM received over the network. It does NOT capture local instrument input — that is PortAudio's responsibility.

---

# Networking Stack

## WebRTC

Responsibilities:
- voice communication;
- video communication;
- peer streams.

---

## Socket.IO

Responsibilities:
- room management;
- signaling;
- synchronization events.

---

# Validation

## zod

Responsibilities:
- validating network payloads;
- protecting signaling server;
- enforcing protocol schemas.

---

# Styling

## TailwindCSS

Responsibilities:
- layout system;
- utility styling;
- responsive UI.

---

# 6. NETWORK TOPOLOGY

## MVP TOPOLOGY

```text
Small Room Mesh Networking
```

Supported room size:

```text
2–4 participants
```

Reason:
- simpler architecture;
- faster implementation;
- lower infrastructure complexity.

---

# FUTURE TOPOLOGY

Future versions may migrate to:

```text
SFU Architecture
```

Possible technologies:

- LiveKit;
- mediasoup;
- Janus.

---

# 7. ROOM SYSTEM ARCHITECTURE

## ROOM CREATION FLOW

```text
1. Host creates room
2. Server generates room ID
3. Invite link generated
4. Participants join room
5. Host initializes transport authority
```

---

# INVITE FORMAT

```text
https://kgb85.app/join/ROOM_ID
```

Room IDs:

```text
UUID v4
```

---

# HOST MODEL

## AUTHORITATIVE HOST

The first participant becomes:

- session host;
- BPM authority;
- transport authority.

The host synchronizes:

- BPM;
- playback state;
- current sequencer step.

---

# 8. REALTIME SYNCHRONIZATION

## SYNCHRONIZATION STRATEGY

MVP prioritizes:

- simplicity;
- reliability;
- realtime collaboration.

Instead of:

- distributed consensus;
- CRDT complexity;
- advanced clock recovery systems.

---

# TRANSPORT SYNCHRONIZATION

Host authoritative.

Host controls:

- play;
- stop;
- BPM;
- transport position.

---

# PATTERN SYNCHRONIZATION

Synchronization model:

```text
Last Write Wins (LWW)
```

Latest valid event overwrites previous state.

---

# JOIN SNAPSHOT SYNCHRONIZATION

When a participant joins an existing room, the server returns a sync snapshot with:

- pattern state;
- BPM;
- transport playing/stopped state;
- current step position.

This prevents late joiners from starting with stale local defaults.

---

# EVENT TYPES

```typescript
step_toggle
transport_play
transport_stop
bpm_change
participant_join
participant_leave
camera_toggle
mic_toggle
```

---

# EXAMPLE EVENT

```json
{
  "type": "step_toggle",
  "track": "kick",
  "step": 7,
  "value": true,
  "timestamp": 1715510100
}
```

---

# 9. AUDIO ENGINE ARCHITECTURE

## TWO-LAYER DESIGN

The audio engine has two independent layers with distinct responsibilities:

```text
┌─────────────────────────────────────────────┐
│           LAYER 1 — NATIVE AUDIO            │
│                                             │
│  PortAudio (Electron main process)          │
│  ┌─────────────┐      ┌─────────────┐       │
│  │  INPUT      │      │  OUTPUT     │       │
│  │  Instrument │      │  Monitors / │       │
│  │  → ASIO /   │      │  Headphones │       │
│  │    WASAPI   │      │  ← ASIO /   │       │
│  │  → PCM buf  │      │    WASAPI   │       │
│  └──────┬──────┘      └──────▲──────┘       │
│         │  IPC (contextBridge)│              │
└─────────┼────────────────────┼──────────────┘
          │                    │
┌─────────▼────────────────────┼──────────────┐
│           LAYER 2 — NETWORK TRANSPORT       │
│                                             │
│  Renderer process                           │
│  PCM → Opus encode → WebRTC DataChannel     │
│  WebRTC DataChannel → Opus decode → PCM     │
│                                             │
│  Web Audio API (remote streams only)        │
│  PCM → GainNode → PannerNode → AnalyserNode │
│      → Master Bus                           │
└─────────────────────────────────────────────┘
```

---

## SIGNAL PATH — LOCAL INSTRUMENT TO REMOTE PARTICIPANT

```text
Instrument
  → Physical audio device (input)
  → PortAudio (ASIO / WASAPI / CoreAudio / ALSA)
  → PCM buffer in Electron main process
  → IPC → renderer process
  → Opus encode
  → WebRTC DataChannel
  → network
  → remote peer DataChannel
  → Opus decode
  → PCM
  → PortAudio output (remote participant's device)
  → Monitors / headphones
```

---

## SEQUENCER / METRONOME TRANSPORT

```text
Tone.Transport
```

Used for:

- BPM management;
- drum machine step scheduling;
- metronome click scheduling;
- transport play / stop / position.

Tone.js does NOT touch instrument input/output. It runs entirely in the renderer process using Web Audio API oscillators and Tone.Player for drum samples.

---

## AUDIO INITIALIZATION

Native layer (PortAudio) — initialized in Electron main process at app start, or when user selects a device.

Sequencer layer (Tone.js) — requires user gesture:

```typescript
await Tone.start()
```

---

## BPM RANGE

```text
60–240 BPM
```

---

## CURRENT STATE (PROTOTYPE)

The current implementation uses browser `getUserMedia` + WebRTC `MediaStream` as a temporary prototype. This path has ~50–150 ms latency and does not support professional audio interfaces properly.

The native PortAudio path is Phase 1 / Track A and will replace `getUserMedia` entirely. See TASKS.md for implementation stages A1–A6.

---

# 10. DRUM MACHINE ARCHITECTURE

## CORE CONFIGURATION

```text
16 Steps
4 Tracks
4/4 Timing
```

---

# TRACKS

Initial channels:

1. Kick
2. Snare
3. Hi-Hat
4. Crash

---

# PATTERN STATE

```typescript
{
  kick: boolean[];
  snare: boolean[];
  hat: boolean[];
  crash: boolean[];
}
```

---

# SAMPLE STORAGE

```text
public/samples/
```

Required files:

- kick.wav
- snare.wav
- hat.wav
- crash.wav

---

# DRUM ROUTING STRATEGY

Drum sounds are:

- generated locally;
- synchronized through events;
- NOT streamed as raw audio.

Benefits:

- lower bandwidth;
- simpler synchronization;
- lower CPU/network load.

---

# 11. VIDEO SYSTEM ARCHITECTURE

## PURPOSE

Video is a core rehearsal feature.

Musicians rely on:

- visual timing;
- gestures;
- eye contact;
- conducting cues;
- hand movement.

---

# VIDEO FEATURES

## MVP FEATURES

Required:

- local camera;
- remote cameras;
- participant video grid;
- fullscreen participant;
- active speaker display;
- camera enable/disable;
- reconnect recovery.

---

# VIDEO LAYOUT MODES

Supported:

- grid mode;
- theater mode;
- fullscreen mode;
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
Video Renderer
        ↓
Participant Tiles
```

---

# VIDEO PERFORMANCE STRATEGY

Under high load:

The system may automatically:

- reduce FPS;
- reduce video resolution;
- disable visual effects.

Audio stability always remains priority.

---

# 12. AUDIO TRANSPORT ARCHITECTURE

## FINAL ARCHITECTURE — PortAudio + DataChannel

Instrument audio is captured natively and transmitted as compressed Opus frames over WebRTC DataChannel:

```text
[Capture]  PortAudio input → PCM → Opus encode → DataChannel packet → network
[Playback] network → DataChannel packet → Opus decode → PCM → PortAudio output
```

No browser `getUserMedia`. No `MediaStream` for instrument audio.

---

## MULTI-CHANNEL SUPPORT

PortAudio exposes all physical input/output channels of the selected device.
Each active input channel is encoded independently and transmitted as a separate Opus stream.
Remote participants see one mixer channel per transmitted input of each participant.

Example — Focusrite Scarlett 18i20:
- 8 physical inputs available
- user enables "Send" on inputs 1 and 2
- remote participants see "Alice — Input 1" and "Alice — Input 2" in their mixer

---

## DEVICE AND DRIVER SELECTION

Each participant independently selects:

1. Audio device (from PortAudio enumeration)
2. Host API for that device (auto or manual: ASIO / WASAPI / DirectSound)
3. Buffer size (samples)

Selection is stored locally. Other participants are not affected by this choice.

---

## JITTER BUFFER

Network jitter causes packets to arrive out of order or with variable delay.
A jitter buffer in the receiver smooths playback by buffering a small number of frames before output.
Target buffer size: configurable, default 2–4 frames (~10–20 ms at 48 kHz).

---

## PROTOTYPE (CURRENT STATE — TO BE REPLACED)

The current implementation uses:

```typescript
// PROTOTYPE ONLY — will be removed
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
})
```

This produces a browser `MediaStream` routed through a WebRTC `MediaStreamTrack`.
Latency: 50–150 ms. No ASIO. No multi-channel. No device selection beyond browser defaults.

This code path is temporary and will be fully replaced by the PortAudio native addon (TASKS.md Phase 1, Track A).

---

## PEER MANAGER RESPONSIBILITIES

- create and manage WebRTC peer connections;
- manage DataChannels for audio transport (final) and MediaStreams for video;
- reconnect handling on network interruption;
- track participant connection state.

---

# 13. MIXER ARCHITECTURE

## CHANNEL TYPES

The mixer has two distinct channel sections:

```text
┌─────────────────────────────────┐
│  LOCAL CHANNELS                 │
│  (own device inputs)            │
│                                 │
│  Input 1 [Send] [Rec] [Fader]   │
│  Input 2 [Send] [Rec] [Fader]   │
│  ...                            │
├─────────────────────────────────┤
│  REMOTE CHANNELS                │
│  (incoming from other peers)    │
│                                 │
│  Alice — Input 1  [Fader]       │
│  Alice — Input 2  [Fader]       │
│  Bob — Input 1    [Fader]       │
│  ...                            │
├─────────────────────────────────┤
│  MASTER BUS                     │
└─────────────────────────────────┘
```

Local channels are sourced from PortAudio.
Remote channels are sourced from decoded Opus streams over DataChannel.

---

## AUDIO GRAPH — REMOTE CHANNELS

```text
DataChannel packet
→ Opus decode → PCM
→ Web Audio API:
    MediaStreamSourceNode (or AudioBufferSourceNode)
    → GainNode          (volume / mute)
    → StereoPannerNode  (pan)
    → AnalyserNode      (VU-meter)
    → Master Bus GainNode
    → DynamicsCompressorNode
    → AudioContext destination
```

---

## AUDIO GRAPH — LOCAL CHANNELS (after Phase 1 complete)

```text
PortAudio PCM → IPC
→ AudioWorkletNode (inject PCM into Web Audio graph for monitoring)
→ GainNode (monitor volume)
→ AudioContext destination (local monitoring, zero-latency preferred)
```

Recording taps directly from PortAudio PCM in main process, bypassing Web Audio.

---

## MIXER FEATURES

Per channel:

- volume fader;
- mute;
- solo;
- stereo pan;
- VU-meter (RMS level via AnalyserNode);
- Send button (local channels only — enables transmission to room);
- Record button (local channels only — starts WAV capture).

---

## MASTER BUS

Controls:

- master volume (GainNode);
- compressor (DynamicsCompressorNode).

---

# 14. STATE MANAGEMENT

## ZUSTAND STORE STRUCTURE

### localUI

Local UI state.

---

### syncedSession

Shared synchronized state:

- BPM;
- transport;
- drum patterns.

---

### peers

Connected participant state.

---

# SYNC MIDDLEWARE

Responsibilities:

- intercept synced changes;
- emit network events;
- prevent event loops.

---

# 15. SECURITY MODEL

## MVP SECURITY

Basic protections:

- HTTPS/WSS only;
- UUID room IDs;
- room isolation;
- schema validation;
- rate limiting.

---

# NETWORK VALIDATION

All incoming payloads validated using:

```text
zod
```

---

# 16. UI ARCHITECTURE

## DESIGN LANGUAGE

### Persian Luxury Cyber

Themes:

- black;
- graphite;
- gold;
- amber glow;
- crystal highlights.

---

# UI GOALS

The interface should feel:

- luxurious;
- futuristic;
- stage-oriented;
- musician-friendly.

---

# MAIN UI LAYOUT

```text
┌──────────────────────────────┐
│ HEADER                       │
├──────────────────────────────┤
│ VIDEO GRID                   │
├──────────────────────────────┤
│ DRUM MACHINE                 │
├──────────────────────────────┤
│ MIXER                        │
├──────────────────────────────┤
│ PARTICIPANTS                 │
└──────────────────────────────┘
```

---

# PERFORMANCE RULE

Heavy animations must NEVER interrupt:

- audio playback;
- transport timing;
- video rendering.

---

# 17. FOLDER STRUCTURE

```text
client/
├── electron/
│   ├── main.js              — Electron main process
│   └── nativeAudio/         — PortAudio native addon bridge (Phase 1 / Track A)
│       ├── portaudioAddon/  — C++ node-addon-api binding
│       └── ipc.js           — IPC handlers exposed to renderer via contextBridge
├── public/
│   └── samples/             — drum machine WAV samples
├── src/
│   ├── audio/               — Tone.js engine, BPM, transport (sequencer only)
│   ├── drumMachine/         — step sequencer logic
│   ├── networking/          — Socket.IO client, room state
│   ├── rtc/                 — WebRTC peer connections, DataChannels
│   ├── video/               — camera capture, video tile rendering
│   ├── mixer/               — Web Audio mixer graph (remote channels)
│   ├── protocol/            — shared event types (TypeScript)
│   ├── hooks/               — React hooks
│   ├── store/               — Zustand state
│   ├── ui/                  — design system components
│   ├── components/          — VideoTile, MixerChannel, etc.
│   ├── types/               — shared TypeScript types
│   └── App.tsx
│
server/
├── rooms/                   — room manager, short code generation
├── socket/                  — socket event handlers
├── protocol/                — Zod validation schemas
└── index.js                 — HTTP + Socket.IO server
```

---

# 18. BUILD SYSTEM

## ELECTRON BUILDER

Target:

```text
Windows Setup.exe
```

---

# BUILD OUTPUT

```text
dist/
└── KGB Sound System 85 Setup.exe
```

---

# 19. FUTURE EXPANSION

Items below are out of scope for the current roadmap phases.

## In roadmap (planned, not yet started)

- VST/AU plugin host on mixer channels (Phase 2);
- MIDI input via WebMIDI API and native bridge (Phase 3);
- Timeline / Arrange window with audio clips (Phase 3);
- Piano Roll editor (Phase 3);
- WAV / MP3 mixdown export (Phase 3).

## Post-roadmap (not planned)

- OBS integration;
- AI drummer / generative patterns;
- Ableton Link sync;
- SFU migration (LiveKit / mediasoup) for rooms > 8 participants;
- mobile companion app.

---

# 20. FINAL TARGET

KGB Sound System 85 should become:

- a collaborative rehearsal environment;
- a synchronized groove platform;
- a musician-first communication system;
- a visually unique alternative to generic conferencing software.

The MVP goal is:

> build a stab
