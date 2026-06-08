import { useEffect, useRef, useState, lazy, Suspense, type CSSProperties } from 'react'
import { audioEngine } from './audio/audioEngine'
import { metronome, COMMON_TIME_SIGNATURES, type MetronomeState, type TimeSignature } from './audio/metronome'
import {
  getDrum,
  forEachDrum,
  connectDrumRoom,
  disconnectDrumRoom,
  setDrumEditable,
  type DrumSyncCmd,
} from './drumMachine/drumNodes'
import { roomSyncClient, type RoomState, type RoomParticipant } from './networking/roomSyncClient'
import { peerManager } from './rtc/peerManager'
import { nativeRtcManager } from './rtc/nativeRtcManager'
import { nativeAudioController, type NativeAudioSnapshot } from './audio/nativeAudioController'
import { mixerEngine } from './mixer/mixerEngine'
import { VideoTile } from './components/VideoTile'
import { MixerChannel } from './components/MixerChannel'
import { LocalMixerStrip } from './components/LocalMixerStrip'
import { RemoteChannelStrip } from './components/RemoteChannelStrip'
import { MixerStrip } from './components/MixerStrip'
import { getTimeline, setPendingTimelineClips } from './timeline/timelineNodes'
import {
  sendClipAdd, sendClipUpdate, sendClipFile as sendClipFileSync,
  applyClipAdd, applyClipUpdate, applyClipRemove, applyClipFile,
} from './timeline/timelineSync'
import { usePianoRollStore } from './pianoRoll/pianoRollStore'
import { participantColor } from './utils/participantColor'
import { ChatPanel } from './components/ChatPanel'
import { SettingsModal } from './components/SettingsModal'
import { DeviceSetupModal } from './components/DeviceSetupModal'
import { recorder, clipAudio } from './audio/recorder'
import type { SyncEvent } from './protocol/syncProtocol'
import type { SyncStateSnapshot } from './networking/roomSyncClient'
import './App.css'
import { PanelsView } from './panels/PanelsView'
import type { PanelContentFn } from './panels/PanelsView'
import { useGraphStore, nodeRegistry, registerBuiltinNodes, setClientTag, connectGraphSync, disconnectGraphSync, hydrateGraph } from './graph'

// Canvas view (G4) is lazy-loaded so React Flow stays out of the startup bundle.
const CanvasView = lazy(() => import('./canvas/CanvasView'))

// The drum machine is a singleton node → its node id equals its type. App reaches
// the per-node engine through the drumNodes registry (getDrum / forEachDrum).
const DRUM_NODE_ID = 'drum-machine'
// Primary Timeline node id (singleton); the Mixer's Record button targets it.
const TIMELINE_NODE_ID = 'timeline'

type LocalParticipant = RoomParticipant & { micEnabled: boolean; cameraEnabled: boolean; hostMuted: boolean }
type RemoteChannelMeta = { channelCount: number; channelNames: string[] }
type RemoteChannelGainState = { gain: number; muted: boolean }

type RoomHistoryEntry = {
  shortCode: string
  lastUsername: string
  lastJoinedAt: number
}

function loadRoomHistory(): RoomHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem('kgb_room_history') ?? '[]') as RoomHistoryEntry[]
  } catch {
    return []
  }
}

function addToRoomHistory(shortCode: string, username: string) {
  const history = loadRoomHistory()
  const next = [
    { shortCode, lastUsername: username, lastJoinedAt: Date.now() },
    ...history.filter((h) => h.shortCode !== shortCode),
  ].slice(0, 10)
  localStorage.setItem('kgb_room_history', JSON.stringify(next))
}

function friendlyError(code: string): string {
  if (code === 'WRONG_PASSWORD') return 'Wrong password'
  if (code === 'ROOM_FULL') return 'Room is full'
  if (code === 'ROOM_NOT_FOUND') return 'Room not found'
  if (code === 'USERNAME_REQUIRED') return 'Enter your name first'
  return code
}

type RemoteParticipantGroupProps = {
  participant: LocalParticipant
  channelMeta: RemoteChannelMeta | undefined
  channelGains: ReadonlyMap<string, RemoteChannelGainState>
  onGainChange: (channelIdx: number, gain: number) => void
  onMuteToggle: (channelIdx: number) => void
  /** M5: per-channel RMS levels from native addon (index = channelIdx). */
  peerLevels: number[]
  armed: ReadonlySet<string>
  onToggleRecord: (key: string) => void
}

function RemoteParticipantGroup({
  participant,
  channelMeta,
  channelGains,
  onGainChange,
  onMuteToggle,
  peerLevels,
  armed,
  onToggleRecord,
}: RemoteParticipantGroupProps) {
  if (!channelMeta || channelMeta.channelCount === 0) {
    const key = `peer:${participant.socketId}`
    return (
      <MixerChannel
        socketId={participant.socketId}
        username={participant.username}
        isHost={participant.isHost}
        recording={armed.has(key)}
        onRecord={() => onToggleRecord(key)}
      />
    )
  }

  return (
    <>
      {Array.from({ length: channelMeta.channelCount }, (_, i) => {
        const gsKey = `${participant.socketId}:${i}`
        const gs = channelGains.get(gsKey) ?? { gain: 1, muted: false }
        return (
          <RemoteChannelStrip
            key={i}
            peerId={participant.socketId}
            channelIdx={i}
            label={channelMeta.channelNames[i] ?? `${participant.username} ${i + 1}`}
            level={peerLevels[i] ?? 0}
            gain={gs.gain}
            muted={gs.muted}
            onGainChange={(g) => onGainChange(i, g)}
            onMuteToggle={() => onMuteToggle(i)}
            recording={armed.has(`peer:${participant.socketId}:${i}`)}
            onRecord={() => onToggleRecord(`peer:${participant.socketId}:${i}`)}
          />
        )
      })}
    </>
  )
}

function App() {
  const [bpm, setBpm] = useState(() => audioEngine.getBpm())
  const [bpmText, setBpmText] = useState(() => String(audioEngine.getBpm()))
  const [metronomeState, setMetronomeState] = useState<MetronomeState>(() => metronome.getState())
  const [beatFlash, setBeatFlash] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [roomState, setRoomState] = useState<RoomState>(() => roomSyncClient.getState())
  const [username, setUsername] = useState(() => localStorage.getItem('kgb_username') || '')
  const [codeInput, setCodeInput] = useState('')
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [participants, setParticipants] = useState<LocalParticipant[]>([])
  // Local camera stream — kept in state so VideoTile re-renders when it changes
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  // Remote streams keyed by socketId
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<string, MediaStream>>(new Map())
  // Track mic/camera state via refs to avoid stale closures in async handlers
  const micEnabledRef = useRef(true)
  const cameraEnabledRef = useRef(true)
  const [micEnabled, setMicEnabled] = useState(true)
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [fullscreenSocketId, setFullscreenSocketId] = useState<string | null>(null)
  // Ref keeps the subscribeParticipants closure up-to-date without re-subscribing
  // every time fullscreenSocketId changes (avoids a teardown/re-attach race).
  const fullscreenSocketIdRef = useRef(fullscreenSocketId)
  fullscreenSocketIdRef.current = fullscreenSocketId
  const [masterVolume, setMasterVolume] = useState(100)
  // Master pan is visual for now — there is no master-bus pan in the engine yet.
  const [masterPan, setMasterPan] = useState(0)
  const [activeSpeakerSocketId, setActiveSpeakerSocketId] = useState<string | null>(null)
  const [rtts, setRtts] = useState<ReadonlyMap<string, number>>(new Map())
  const [nativeRttMap, setNativeRttMap] = useState<Record<string, number>>({})
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeAudioSnapshot>(() => nativeAudioController.getSnapshot())
  // Show device setup modal once per room session when stream is not yet active.
  const [showDeviceSetup, setShowDeviceSetup] = useState(false)
  const [sendEnabled, setSendEnabled] = useState<ReadonlySet<number>>(new Set())
  const [remoteChannelMeta, setRemoteChannelMeta] = useState<ReadonlyMap<string, RemoteChannelMeta>>(() => new Map())
  const [remoteChannelGains, setRemoteChannelGains] = useState<ReadonlyMap<string, RemoteChannelGainState>>(() => new Map())
  // M5: per-channel RMS levels from native addon, polled at ~30fps.
  const [nativeRemoteLevels, setNativeRemoteLevels] = useState<Record<string, number[]>>({})
  // Record-arm state per channel key ('master' | 'local:i' | 'peer:id:i').
  // Visual for now — actual capture + timeline track lands with the Timeline node.
  const [armed, setArmed] = useState<ReadonlySet<string>>(() => new Set())
  // Rapid-click guard: keys currently mid-arm (between click and microtask cleanup).
  const pendingArmRef = useRef(new Set<string>())
  const [hostPassword, setHostPassword] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [maxParticipants, setMaxParticipants] = useState(8)
  const [roomHistory, setRoomHistory] = useState<RoomHistoryEntry[]>(() => loadRoomHistory())
  const [lobbyPanel, setLobbyPanel] = useState<'host' | 'join' | 'history' | null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [prerollBars, setPrerollBars] = useState(2)

  const [syncOnly, setSyncOnly] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

  const stepLwwRef = useRef(new Map<string, number>())
  const logicalClockRef = useRef(0)

  // Persist username to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('kgb_username', username)
  }, [username])

  // Close the "+" add-node menu on outside click / Escape.
  useEffect(() => {
    if (!addMenuOpen) return
    const onDown = (e: PointerEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddMenuOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [addMenuOpen])

  // Keep bpmText field in sync when bpm changes from slider or network
  useEffect(() => {
    setBpmText(String(bpm))
  }, [bpm])

  // Wire peerManager signal sender once on mount
  useEffect(() => {
    peerManager.setSignalSender((targetSocketId, signal) => {
      void roomSyncClient.sendRtcSignal(targetSocketId, signal)
    })
  }, [])

  // 5a: Wire nativeRtcManager signal sender once on mount
  useEffect(() => {
    nativeRtcManager.setSendSignal((targetSocketId, signal) => {
      void roomSyncClient.sendRtcSignal(targetSocketId, signal)
    })
  }, [])

  // 5e: Keep nativeRtcManager in sync with nativeAudioController stream state
  useEffect(() => {
    return nativeAudioController.subscribeState((snap) => {
      setNativeSnapshot(snap)
      nativeRtcManager.setActive(snap.streamActive)
    })
  }, [])

  // Phase 2: sync sendEnabled with stream lifecycle — default ch 0 on open, clear on close
  useEffect(() => {
    if (!nativeSnapshot.streamActive) {
      // Stop any in-progress recordings when the stream closes.
      recorder.stopAll()
      setArmed(new Set())
      setSendEnabled(new Set())
      nativeRtcManager.clearSendChannels()
      return
    }
    const defaults = new Set([0])
    setSendEnabled(defaults)
    nativeRtcManager.clearSendChannels()
    nativeRtcManager.setSendEnabled(0, true)
  }, [nativeSnapshot.streamActive, nativeSnapshot.activeInputChannels])

  // Broadcast local channel config to peers in the room.
  // Fires on stream open/close and on sendEnabled change (ensures new peers get fresh state).
  useEffect(() => {
    if (!roomState.roomId) return
    void roomSyncClient.sendChannelMeta(
      nativeSnapshot.activeInputChannels,
      nativeSnapshot.inputChannelNames,
    ).catch(() => { /* fire-and-forget: no room to send to yet is expected */ })
  }, [roomState.roomId, nativeSnapshot.streamActive, nativeSnapshot.activeInputChannels, sendEnabled])

  // Active speaker detection — polls mixer levels via requestAnimationFrame
  useEffect(() => {
    const THRESHOLD = 0.04  // RMS level to be considered "speaking"
    let rafId: number

    const tick = () => {
      let topId: string | null = null
      let topLevel = THRESHOLD

      for (const p of participants) {
        const level = mixerEngine.getLevelRms(p.socketId)
        if (level !== null && level > topLevel) {
          topLevel = level
          topId = p.socketId
        }
      }

      setActiveSpeakerSocketId((prev) => (prev === topId ? prev : topId))
      rafId = requestAnimationFrame(tick)
    }

    if (participants.length > 0) {
      rafId = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [participants])

  // M5: poll native addon stats at ~30fps to drive remote channel VU meters.
  // getStats() is a lightweight IPC call (<1ms round-trip); 33ms interval is safe.
  useEffect(() => {
    const id = setInterval(() => {
      window.nativeAudio?.getStats().then((stats) => {
        setNativeRemoteLevels(stats.remoteChannelLevels ?? {})
      }).catch(() => { /* engine not running — keep previous levels */ })
    }, 33)
    return () => clearInterval(id)
  }, [])

  // Remote stream events → React state + Web Audio mixer
  useEffect(() => {
    return peerManager.subscribeStreams((socketId, stream) => {
      setRemoteStreams((prev) => {
        const next = new Map(prev)
        if (stream === null) {
          next.delete(socketId)
          mixerEngine.removeChannel(socketId)
        } else {
          next.set(socketId, stream)
          mixerEngine.addChannel(socketId, stream)
        }
        return next
      })
    })
  }, [])

  // 5b: RTC signal relay — route by _kgbAudio flag to avoid conflicts with SimplePeer
  useEffect(() => {
    return roomSyncClient.subscribeRtcSignals(({ fromSocketId, signal }) => {
      if ((signal as { _kgbAudio?: boolean })?._kgbAudio) {
        nativeRtcManager.handleSignal(fromSocketId, signal)
      } else {
        peerManager.handleSignal(fromSocketId, signal as Parameters<typeof peerManager.handleSignal>[1])
      }
    })
  }, [])

  // 5c/5d: Participant join/leave → update list + peer connections (SimplePeer + nativeRtcManager)
  useEffect(() => {
    return roomSyncClient.subscribeParticipants((event) => {
      if (event.type === 'participant_join') {
        const { socketId, username: joinedUsername } = event.payload
        setParticipants((prev) => {
          if (prev.some((p) => p.socketId === socketId)) return prev
          return [...prev, { socketId, username: joinedUsername, isHost: false, micEnabled: true, cameraEnabled: true, hostMuted: false }]
        })
        // Existing participant initiates WebRTC with the newcomer.
        // The newcomer gets existing peers from the join ACK (setParticipants) and
        // never calls addPeer for them via this handler — so the existing participant
        // is always the sole initiator, matching peerManager's pattern.
        peerManager.addPeer(socketId, true)
        nativeRtcManager.addPeer(socketId, true) // 5c
        return
      }

      if (event.type === 'participant_leave') {
        const { socketId } = event.payload
        setParticipants((prev) => prev.filter((p) => p.socketId !== socketId))
        peerManager.removePeer(socketId)
        nativeRtcManager.removePeer(socketId) // 5d
        if (fullscreenSocketIdRef.current === socketId) setFullscreenSocketId(null)
        setNativeRttMap((prev) => {
          const next = { ...prev }
          delete next[socketId]
          return next
        })
        setRemoteChannelMeta((prev) => {
          if (!prev.has(socketId)) return prev
          const next = new Map(prev)
          next.delete(socketId)
          return next
        })
        setRemoteChannelGains((prev) => {
          const keysToDelete = [...prev.keys()].filter((k) => k.startsWith(`${socketId}:`))
          if (keysToDelete.length === 0) return prev
          const next = new Map(prev)
          keysToDelete.forEach((k) => next.delete(k))
          return next
        })
      }
    })
  }, [])

  useEffect(() => {
    return roomSyncClient.onChannelMeta(({ senderId, channelCount, channelNames }) => {
      setRemoteChannelMeta((prev) => {
        const next = new Map(prev)
        next.set(senderId, { channelCount, channelNames })
        return next
      })
    })
  }, [])

  useEffect(() => roomSyncClient.subscribeRoomState(setRoomState), [])
  useEffect(() => metronome.subscribe((state) => {
    setMetronomeState(state)
  }), [])

  // Short visual flash on each beat tick
  useEffect(() => {
    if (!isPlaying || !metronomeState.enabled) return
    setBeatFlash(true)
    const t = setTimeout(() => setBeatFlash(false), 80)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metronomeState.currentBeat])

  // Auto-fill code from invite hash: #join/ABCD
  useEffect(() => {
    const hash = window.location.hash
    if (hash.startsWith('#join/')) {
      const code = hash.slice(6, 10).toUpperCase()
      if (/^[A-Z0-9]{4}$/.test(code)) {
        setCodeInput(code)
      }
    }
  }, [])

  useEffect(
    () =>
      roomSyncClient.subscribeRtt(({ socketId, rtt }) => {
        setRtts((prev) => {
          const next = new Map(prev)
          next.set(socketId, rtt)
          return next
        })
      }),
    [],
  )

  useEffect(() => {
    return nativeRtcManager.subscribeRtt((peerId, rttMs) => {
      setNativeRttMap((prev) => {
        if (rttMs === null) {
          const next = { ...prev }
          delete next[peerId]
          return next
        }
        return { ...prev, [peerId]: rttMs }
      })
    })
  }, [])

  useEffect(
    () =>
      roomSyncClient.subscribeHostMuted(({ socketId, muted }) => {
        const self = roomSyncClient.getState().socketId
        if (socketId === self) {
          // Forced mute/unmute of our own mic by the host
          micEnabledRef.current = !muted
          setMicEnabled(!muted)
          peerManager.setMicEnabled(!muted)
        }
        setParticipants((prev) =>
          prev.map((p) => (p.socketId === socketId ? { ...p, hostMuted: muted } : p)),
        )
      }),
    [],
  )

  useEffect(
    () =>
      roomSyncClient.subscribeKicked(() => {
        nativeRtcManager.removeAllPeers() // 5f
        setNetworkError('You were removed from the room by the host.')
        setParticipants([])
        setNativeRttMap({})
      }),
    [],
  )

  // 5f: Clean up native RTC peers on unmount
  useEffect(() => () => { nativeRtcManager.removeAllPeers() }, [])

  useEffect(
    () =>
      roomSyncClient.subscribeSyncEvents(async (event) => {
        if (event.type === 'step_toggle') {
          const id = event.payload.nodeId ?? DRUM_NODE_ID
          const lwwKey = `${id}:${event.payload.track}-${event.payload.step}`
          const previousTimestamp = stepLwwRef.current.get(lwwKey) ?? 0
          if (event.timestamp >= previousTimestamp) {
            stepLwwRef.current.set(lwwKey, event.timestamp)
            getDrum(id)?.toggleStep(event.payload.track, event.payload.step, event.payload.value)
          }
          return
        }

        if (event.type === 'bpm_change') {
          const safeBpm = audioEngine.setBpm(event.payload.bpm)
          setBpm(safeBpm)
          return
        }

        if (event.type === 'transport_play') {
          // App owns the project transport; each drum just arms its sequencer.
          await audioEngine.play({ position: 0 })
          const starts: Promise<void>[] = []
          forEachDrum((d) => starts.push(d.start({ step: event.payload.step })))
          await Promise.all(starts)
          metronome.start()
          setIsPlaying(true)
          return
        }

        if (event.type === 'transport_stop') {
          audioEngine.stop()
          forEachDrum((d) => d.stop())
          metronome.stop()
          setIsPlaying(false)
          return
        }

        if (event.type === 'mic_toggle' && event.senderId) {
          const { senderId } = event
          setParticipants((prev) =>
            prev.map((p) =>
              p.socketId === senderId ? { ...p, micEnabled: event.payload.enabled } : p,
            ),
          )
          return
        }

        if (event.type === 'step_count_change') {
          getDrum(event.payload.nodeId ?? DRUM_NODE_ID)?.setStepCount(event.payload.stepCount)
          return
        }

        if (event.type === 'swing_change') {
          getDrum(event.payload.nodeId ?? DRUM_NODE_ID)?.setSwing(event.payload.swing)
          return
        }

        if (event.type === 'pattern_switch') {
          const id = event.payload.nodeId ?? DRUM_NODE_ID
          getDrum(id)?.switchPattern(event.payload.patternIndex)
          // Clear only this drum's LWW so stale timestamps from its previous pattern don't bleed
          clearDrumLww(id)
          return
        }

        if (event.type === 'velocity_change') {
          try {
            getDrum(event.payload.nodeId ?? DRUM_NODE_ID)?.setVelocity(event.payload.track, event.payload.step, event.payload.velocity)
          } catch {
            // step out of range for current pattern length — stale event, ignore
          }
          return
        }

        if (event.type === 'time_signature_change') {
          metronome.setTimeSignature({ beats: event.payload.beats, division: event.payload.division })
          return
        }

        if (event.type === 'metronome_toggle') {
          metronome.setEnabled(event.payload.enabled)
          return
        }

        if (event.type === 'chain_set') {
          getDrum(event.payload.nodeId ?? DRUM_NODE_ID)?.setChain(event.payload.chain)
          return
        }

        if (event.type === 'camera_toggle' && event.senderId) {
          const { senderId } = event
          setParticipants((prev) =>
            prev.map((p) =>
              p.socketId === senderId ? { ...p, cameraEnabled: event.payload.enabled } : p,
            ),
          )
          return
        }

        if (event.type === 'clip_add') { applyClipAdd(event); return }
        if (event.type === 'clip_update') { applyClipUpdate(event); return }
        if (event.type === 'clip_remove') { applyClipRemove(event); return }
      }),
    [],
  )

  // T4: receive binary WAV files from peers
  useEffect(() => roomSyncClient.subscribeClipFile(applyClipFile), [])


  const nextLogicalTimestamp = () => {
    logicalClockRef.current += 1
    return logicalClockRef.current
  }

  // step_toggle LWW is keyed `${nodeId}:${track}-${step}`. On a pattern switch we
  // drop only the switching drum's entries so stale timestamps don't bleed.
  const clearDrumLww = (nodeId: string) => {
    for (const key of [...stepLwwRef.current.keys()]) {
      if (key.startsWith(`${nodeId}:`)) stepLwwRef.current.delete(key)
    }
  }

  const emitSyncEvent = async (
    partial: Omit<SyncEvent, 'timestamp' | 'eventId'> & { timestamp?: number },
  ) => {
    if (!roomState.roomId) return

    const logicalTimestamp = partial.timestamp ?? nextLogicalTimestamp()

    try {
      await roomSyncClient.sendSyncEvent({
        ...partial,
        timestamp: logicalTimestamp,
        eventId: `${roomState.username ?? 'user'}-${logicalTimestamp}`,
      } as SyncEvent)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'SYNC_EVENT_REJECTED')
    }
  }

  // App owns the project transport: it starts/stops audioEngine once, then arms
  // every drum instance's sequencer. The drums no longer touch Tone.Transport.
  const startAllDrums = async () => {
    await audioEngine.play({ position: 0 })
    const starts: Promise<void>[] = []
    forEachDrum((d) => starts.push(d.start()))
    await Promise.all(starts)
    metronome.start()
  }

  const handlePlayStop = async () => {
    if (roomState.roomId && !roomState.isHost) return

    // Mid-preroll: the button acts as Cancel. metronome.stop() rejects the
    // pending preroll promise (PREROLL_CANCELLED), whose handler resets isStarting.
    if (isStarting) {
      metronome.stop()
      setIsStarting(false)
      return
    }

    if (isPlaying) {
      const step = getDrum(DRUM_NODE_ID)?.getState().currentStep ?? 0
      audioEngine.stop()
      forEachDrum((d) => d.stop())
      metronome.stop()
      setIsPlaying(false)
      await emitSyncEvent({ type: 'transport_stop', payload: { step } })
      return
    }

    setIsStarting(true)

    if (prerollBars > 0) {
      try {
        await metronome.startPreroll(prerollBars)
        await startAllDrums()
        setIsPlaying(true)
        await emitSyncEvent({ type: 'transport_play', payload: { step: 0 } })
      } catch (err) {
        // Ensure the engine is stopped regardless of where in the sequence it failed.
        // audioEngine.stop() is a no-op if it wasn't started yet (preroll cancel path).
        audioEngine.stop()
        forEachDrum((d) => d.stop())
        metronome.stop()
        if (!(err instanceof Error && err.message === 'PREROLL_CANCELLED')) {
          setNetworkError(err instanceof Error ? err.message : 'TRANSPORT_FAILED')
        }
      } finally {
        setIsStarting(false)
      }
      return
    }

    try {
      await startAllDrums()
      setIsPlaying(true)
      await emitSyncEvent({ type: 'transport_play', payload: { step: 0 } })
    } catch (err) {
      audioEngine.stop()
      forEachDrum((d) => d.stop())
      metronome.stop()
      setNetworkError(err instanceof Error ? err.message : 'TRANSPORT_FAILED')
    } finally {
      setIsStarting(false)
    }
  }

  const handleBpmChange = async (nextBpm: number) => {
    if (roomState.roomId && !roomState.isHost) return
    const safeBpm = audioEngine.setBpm(nextBpm)
    setBpm(safeBpm)
    await emitSyncEvent({ type: 'bpm_change', payload: { bpm: safeBpm } })
  }

  const handleMetronomeToggle = async () => {
    if (roomState.roomId && !roomState.isHost) return
    const next = !metronomeState.enabled
    metronome.setEnabled(next)
    await emitSyncEvent({ type: 'metronome_toggle', payload: { enabled: next } })
  }

  const handleTimeSignatureChange = async (ts: TimeSignature) => {
    if (roomState.roomId && !roomState.isHost) return
    metronome.setTimeSignature(ts)
    await emitSyncEvent({ type: 'time_signature_change', payload: { beats: ts.beats, division: ts.division as unknown as 4 | 8 | 16 } })
  }

  const handleSyncOnlyToggle = () => {
    const next = !syncOnly
    setSyncOnly(next)
    metronome.setSoundEnabled(!next)
  }

  // Drum room glue: the self-contained DrumNodePanel mutates its OWN instance,
  // then asks App (via emitDrumSync) to broadcast the intent as a room event.
  // Host-gating is enforced in the panel (disabled), driven by setDrumEditable.
  // A latest-ref keeps the closure fresh (emitSyncEvent closes over roomState)
  // while connectDrumRoom is wired only once.
  const drumEmitRef = useRef<(nodeId: string, cmd: DrumSyncCmd) => void>(() => {})
  drumEmitRef.current = (nodeId: string, cmd: DrumSyncCmd) => {
    switch (cmd.type) {
      case 'step_toggle': {
        const timestamp = nextLogicalTimestamp()
        stepLwwRef.current.set(`${nodeId}:${cmd.track}-${cmd.step}`, timestamp)
        void emitSyncEvent({ type: 'step_toggle', payload: { nodeId, track: cmd.track, step: cmd.step, value: cmd.value }, timestamp })
        break
      }
      case 'velocity_change':
        void emitSyncEvent({ type: 'velocity_change', payload: { nodeId, track: cmd.track, step: cmd.step, velocity: cmd.velocity } })
        break
      case 'pattern_switch':
        clearDrumLww(nodeId)
        void emitSyncEvent({ type: 'pattern_switch', payload: { nodeId, patternIndex: cmd.patternIndex } })
        break
      case 'step_count_change':
        void emitSyncEvent({ type: 'step_count_change', payload: { nodeId, stepCount: cmd.stepCount } })
        break
      case 'swing_change':
        void emitSyncEvent({ type: 'swing_change', payload: { nodeId, swing: cmd.swing } })
        break
      case 'chain_set':
        void emitSyncEvent({ type: 'chain_set', payload: { nodeId, chain: cmd.chain } })
        break
    }
  }

  useEffect(() => {
    connectDrumRoom({ emit: (nodeId, cmd) => drumEmitRef.current(nodeId, cmd) })
    return () => disconnectDrumRoom()
  }, [])

  // Host-gating: only the host edits drum params in a room; offline/solo is open.
  useEffect(() => {
    setDrumEditable(!(roomState.roomId && !roomState.isHost))
  }, [roomState.roomId, roomState.isHost])

  const handleHostMute = async (targetSocketId: string) => {
    try {
      await roomSyncClient.sendHostMute(targetSocketId)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'MUTE_FAILED')
    }
  }

  const handleHostKick = async (targetSocketId: string) => {
    try {
      await roomSyncClient.sendHostKick(targetSocketId)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'KICK_FAILED')
    }
  }

  const handleClear = () => {
    // Local-only, host-gated via the button (existing behaviour — not synced).
    getDrum(DRUM_NODE_ID)?.clearPattern()
  }

  const acquireLocalStream = async () => {
    setMediaError(null)
    try {
      const stream = await peerManager.startLocalStream(true)
      setLocalStream(stream)
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'MEDIA_ACCESS_DENIED')
    }
  }

  const handleCreateRoom = async () => {
    if (!username.trim()) {
      setNetworkError(friendlyError('USERNAME_REQUIRED'))
      return
    }
    setNetworkError(null)
    await acquireLocalStream()

    // ── Local mode: no server connection ──────────────────────
    if (!roomState.connected) {
      const { shortCode } = roomSyncClient.createLocalRoom(username.trim())
      addToRoomHistory(shortCode, username.trim())
      setRoomHistory(loadRoomHistory())
      // No remote participants in local mode
      setParticipants([])
      return
    }

    // ── Normal mode: server-connected ─────────────────────────
    try {
      const result = await roomSyncClient.createRoom(username.trim(), {
        password: hostPassword.trim() || undefined,
        maxParticipants,
      })
      setInviteLink(result.inviteLink)
      if (result.shortCode) {
        addToRoomHistory(result.shortCode, username.trim())
        setRoomHistory(loadRoomHistory())
      }
      const selfSocketId = roomSyncClient.getState().socketId
      setParticipants(
        result.participants
          .filter((p) => p.socketId !== selfSocketId)
          .map((p) => ({ ...p, micEnabled: true, cameraEnabled: true, hostMuted: p.muted ?? false })),
      )
      await applySyncSnapshot(result.syncState)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'FAILED_TO_CREATE_ROOM'
      setNetworkError(friendlyError(msg))
    }
  }

  const handleJoinByCode = async (overrideCode?: string, overrideUsername?: string, overridePassword?: string) => {
    const name = (overrideUsername ?? username).trim()
    if (!name) {
      setNetworkError(friendlyError('USERNAME_REQUIRED'))
      return
    }
    const code = (overrideCode ?? codeInput).trim().toUpperCase()
    if (code.length !== 4) {
      setNetworkError('Enter a 4-character room code')
      return
    }
    setNetworkError(null)
    await acquireLocalStream()

    try {
      const pw = overridePassword ?? (joinPassword.trim() || undefined)
      const result = await roomSyncClient.joinByCode(code, name, pw)
      addToRoomHistory(code, name)
      setRoomHistory(loadRoomHistory())
      const selfSocketId = roomSyncClient.getState().socketId
      setParticipants(
        result.participants
          .filter((p) => p.socketId !== selfSocketId)
          .map((p) => ({ ...p, micEnabled: true, cameraEnabled: true, hostMuted: p.muted ?? false })),
      )
      await applySyncSnapshot(result.syncState)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'FAILED_TO_JOIN_ROOM'
      setNetworkError(friendlyError(msg))
    }
  }

  const handleCopyCode = () => {
    const code = roomState.shortCode
    if (!code) return
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Use refs to avoid stale closures — actual toggle reads ref, then syncs state
  const handleMicToggle = async () => {
    const nextEnabled = !micEnabledRef.current
    micEnabledRef.current = nextEnabled
    setMicEnabled(nextEnabled)
    peerManager.setMicEnabled(nextEnabled)
    await emitSyncEvent({ type: 'mic_toggle', payload: { enabled: nextEnabled } })
  }

  const handleMasterVolume = (v: number) => {
    setMasterVolume(v)
    mixerEngine.setMasterVolume(v / 100)
  }

  const handleSendToggle = (channelIndex: number) => {
    setSendEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(channelIndex)) {
        next.delete(channelIndex)
        nativeRtcManager.setSendEnabled(channelIndex, false)
      } else {
        next.add(channelIndex)
        nativeRtcManager.setSendEnabled(channelIndex, true)
      }
      return next
    })
  }

  const handleRemoteGainChange = (socketId: string, channelIdx: number, gain: number) => {
    setRemoteChannelGains((prev) => {
      const next = new Map(prev)
      const key = `${socketId}:${channelIdx}`
      const cur = next.get(key) ?? { gain: 1, muted: false }
      const next2 = { ...cur, gain }
      next.set(key, next2)
      // M4: apply gain to addon unless muted (mute is gain=0 in the addon)
      if (!next2.muted) {
        window.nativeAudio?.setRemoteChannelGain(socketId, String(channelIdx), gain)
      }
      return next
    })
  }

  const handleRemoteMuteToggle = (socketId: string, channelIdx: number) => {
    setRemoteChannelGains((prev) => {
      const next = new Map(prev)
      const key = `${socketId}:${channelIdx}`
      const cur = next.get(key) ?? { gain: 1, muted: false }
      const nowMuted = !cur.muted
      next.set(key, { ...cur, muted: nowMuted })
      // M4: mute = gain 0; unmute = restore saved gain
      window.nativeAudio?.setRemoteChannelGain(socketId, String(channelIdx), nowMuted ? 0 : cur.gain)
      return next
    })
  }

  const handleCameraToggle = async () => {
    const nextEnabled = !cameraEnabledRef.current
    cameraEnabledRef.current = nextEnabled
    setCameraEnabled(nextEnabled)
    peerManager.setCameraEnabled(nextEnabled)
    await emitSyncEvent({ type: 'camera_toggle', payload: { enabled: nextEnabled } })
  }

  const applySyncSnapshot = async (snapshot: SyncStateSnapshot | null) => {
    if (!snapshot) return
    // Node graph: hydrate room topology from the join snapshot (G2/G3)
    hydrateGraph(snapshot)
    // Timeline clips (T4): store for hydration when the timeline panel first opens
    setPendingTimelineClips(snapshot.timelineClips?.['timeline'] ?? null)

    // Ensure the primary drum instance exists (it may not be in the hydrated
    // graph yet) so the room's pattern/swing/chain land in a live engine even
    // before the user opens the panel. Duplicated drums come in via hydrateGraph.
    useGraphStore.getState().preloadNodeByType('drum-machine')
    // Per-node drum state: iterate the `drums` map (primary + duplicates). Fall
    // back to the legacy top-level fields if an older server omits `drums`.
    const drumsSnap = snapshot.drums ?? {
      [DRUM_NODE_ID]: {
        patternBank: snapshot.patternBank,
        activePatternIndex: snapshot.activePatternIndex,
        swing: snapshot.swing,
        chain: snapshot.chain,
      },
    }
    for (const [id, d] of Object.entries(drumsSnap)) {
      const inst = getDrum(id)
      if (!inst) continue
      inst.setPatternBank(
        d.patternBank as Parameters<typeof inst.setPatternBank>[0],
        d.activePatternIndex,
      )
      inst.setSwing(d.swing ?? 0)
      inst.setChain(d.chain ?? null)
    }
    const safeBpm = audioEngine.setBpm(snapshot.bpm)
    setBpm(safeBpm)
    metronome.setTimeSignature(snapshot.timeSignature as TimeSignature)
    metronome.setEnabled(snapshot.metronomeEnabled)

    if (snapshot.isPlaying) {
      await audioEngine.play({ position: 0 })
      const starts: Promise<void>[] = []
      forEachDrum((d) => starts.push(d.start({ step: snapshot.currentStep })))
      await Promise.all(starts)
      metronome.start()
      setIsPlaying(true)
      return
    }

    audioEngine.stop()
    forEachDrum((d) => d.stop())
    metronome.stop()
    setIsPlaying(false)
  }

  const inRoom = Boolean(roomState.roomId)
  const selfSocketId = roomState.socketId
  const openPanel = useGraphStore((s) => s.openNodeByType)
  const preloadPanel = useGraphStore((s) => s.preloadNodeByType)
  const viewMode = useGraphStore((s) => s.viewMode)
  const setViewMode = useGraphStore((s) => s.setViewMode)

  // Node graph: register built-in node types once (idempotent), before any node creation
  useEffect(() => { registerBuiltinNodes() }, [])

  // Node graph: activate room sync (G2/G3) BEFORE opening builtins, so their
  // node_add mutations broadcast. Outgoing mutations → room:events; incoming →
  // applyRemote. Local (settings) and per-client builtins don't depend on this.
  useEffect(() => {
    if (!inRoom || !selfSocketId) return
    setClientTag(selfSocketId)
    connectGraphSync()
    return () => { disconnectGraphSync() }
  }, [inRoom, selfSocketId])

  // Node graph + timeline: reset on leaving a room so a rejoin starts clean (no
  // stale nodes/positions or timeline tracks). Hydration repopulates shared nodes.
  useEffect(() => {
    if (!inRoom) {
      // Graph reset disposes node instances (incl. per-node Timeline stores).
      useGraphStore.getState().reset()
      usePianoRollStore.getState().clear()
      // Discard any pending clip hydration from the previous room so it doesn't
      // leak into a subsequent local session.
      setPendingTimelineClips(null)
    }
  }, [inRoom])

  // Open mixer; preload chat + drum (keeps their per-node instances mounted so
  // room sync / snapshot state lands even before the user opens the panel).
  useEffect(() => {
    if (inRoom) {
      openPanel('mixer')
      preloadPanel('chat')
      preloadPanel('drum-machine')
      preloadPanel('timeline') // so Mixer Record can arm the primary timeline before it's opened
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom])

  // Show device setup modal once per room session when nativeAudio is available
  // and the stream is not yet active.
  useEffect(() => {
    if (inRoom && window.nativeAudio !== undefined && !nativeSnapshot.streamActive) {
      setShowDeviceSetup(true)
    }
    if (!inRoom) {
      setShowDeviceSetup(false)
    }
  }, [inRoom, nativeSnapshot.streamActive])

  // Client-side invite link for web deployments (not file:// Electron)
  const clientInviteLink =
    roomState.shortCode && window.location.protocol !== 'file:'
      ? `${window.location.href.split('#')[0]}#join/${roomState.shortCode}`
      : null
  const displayInviteLink = inviteLink || clientInviteLink

  // Build video grid tiles
  const remoteTiles = participants.map((p) => ({
    participant: p,
    stream: remoteStreams.get(p.socketId) ?? null,
  }))

  // Fullscreen participant (theater mode — expand one tile)
  const fullscreenTile = fullscreenSocketId
    ? remoteTiles.find((t) => t.participant.socketId === fullscreenSocketId) ?? null
    : null

  // ── Panel content definitions ────────────────────────────────────
  const metronomeContent = (
    <div className="metro-panel-content">
      <label className="metro-settings-row">
        <span>Time sig</span>
        <select
          aria-label="Time signature"
          className="time-sig-select"
          disabled={inRoom && !roomState.isHost}
          value={`${metronomeState.timeSignature.beats}/${metronomeState.timeSignature.division}`}
          onChange={(e) => {
            const [b, d] = e.target.value.split('/').map(Number)
            void handleTimeSignatureChange({ beats: b, division: d as unknown as 4 | 8 | 16 })
          }}
        >
          {COMMON_TIME_SIGNATURES.map((ts) => (
            <option key={`${ts.beats}/${ts.division}`} value={`${ts.beats}/${ts.division}`}>
              {ts.beats}/{ts.division}
            </option>
          ))}
        </select>
      </label>
      <label className="metro-settings-row">
        <span>Preroll</span>
        <select
          aria-label="Preroll bars"
          className="preroll-select"
          value={prerollBars}
          onChange={(e) => setPrerollBars(Number(e.target.value))}
          disabled={isPlaying || isStarting}
        >
          <option value={0}>Off</option>
          <option value={1}>1 bar</option>
          <option value={2}>2 bars</option>
          <option value={4}>4 bars</option>
        </select>
      </label>
      <label className="metro-settings-row metro-settings-check">
        <input
          type="checkbox"
          checked={syncOnly}
          onChange={handleSyncOnlyToggle}
          disabled={inRoom && !roomState.isHost}
        />
        <span>Sync only</span>
      </label>
    </div>
  )

  // Arming a channel creates a Timeline track + a proxy clip at the playhead.
  // Returns { clipId, name, color } for T4 sync.
  const armTimelineTrack = (key: string): { clipId: string; name: string; color: string; startSec: number } | null => {
    let name = 'Track'
    let color = 'var(--gold)'
    if (key === 'master') { name = 'Master' }
    else if (key.startsWith('local:')) { name = `Input ${Number(key.slice(6)) + 1}`; color = 'var(--crystal)' }
    else if (key.startsWith('peer:')) {
      const sid = key.slice(5).split(':')[0]
      const p = participants.find((x) => x.socketId === sid)
      name = p ? p.username : 'Peer'
      color = participantColor(sid)
    }
    const store = getTimeline(TIMELINE_NODE_ID)
    if (!store) return null // primary timeline not mounted yet
    const tl = store.getState()
    tl.pushHistory() // one undo step for the whole arm gesture (track + clip)
    const trackId = tl.ensureTrack(key, { name, kind: 'audio', color })
    const startSec = audioEngine.getTransportSeconds()
    const clipId = tl.addClip({ trackId, startSec, durSec: 4, label: name, kind: 'audio', proxy: true })
    return { clipId, name, color, startSec }
  }

  const toggleArmed = (key: string) => {
    const willArm = !armed.has(key)
    setArmed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    // Side effect kept OUT of the state updater (updaters must be pure; StrictMode
    // double-invokes them, which would create duplicate clips).
    // pendingArmRef guards against rapid double-clicks: the second click arrives
    // before the first state update commits, so both see willArm=true from the
    // same stale armed state. The ref is cleared via microtask after synchronous
    // event processing completes, allowing normal disarm→re-arm to still work.
    if (willArm) {
      if (pendingArmRef.current.has(key)) return
      pendingArmRef.current.add(key)
      const armResult = armTimelineTrack(key)
      const clipId = armResult?.clipId ?? null
      // T2: start PCM accumulation for local input channels.
      if (clipId && key.startsWith('local:') && window.nativeAudio !== undefined) {
        const channelIdx = Number(key.slice(6))
        recorder.start(channelIdx, clipId)
      }
      // T4: broadcast the new proxy clip to peers
      if (clipId && armResult && roomState.roomId && !roomState.isLocalRoom) {
        sendClipAdd({
          trackKey: key,
          trackName: armResult.name,
          trackKind: 'audio',
          trackColor: armResult.color,
          clip: { id: clipId, startSec: armResult.startSec, durSec: 4, label: armResult.name, kind: 'audio', proxy: true },
        })
      }
      queueMicrotask(() => pendingArmRef.current.delete(key))
    } else {
      // T2: stop recording and update the proxy clip with real duration.
      if (key.startsWith('local:') && window.nativeAudio !== undefined) {
        const channelIdx = Number(key.slice(6))
        const result = recorder.stop(channelIdx)
        if (result) {
          const realDur = Math.max(0.2, result.durSec)
          const store = getTimeline(TIMELINE_NODE_ID)
          store?.getState().updateClip(result.clipId, { proxy: false, durSec: realDur })
          // T4: notify peers of real clip duration + send WAV file
          if (roomState.roomId && !roomState.isLocalRoom) {
            sendClipUpdate(result.clipId, { proxy: false, durSec: realDur })
            const blob = clipAudio.get(result.clipId)
            if (blob) sendClipFileSync(result.clipId, blob)
          }
        }
      }
    }
  }

  const mixerContent = (
    <>
      <div className="mixer-rack">
        <MixerStrip
          variant="master"
          name="Master"
          sub="Project"
          value={masterVolume}
          onValue={handleMasterVolume}
          pan={masterPan}
          onPan={setMasterPan}
          recording={armed.has('master')}
          onRecord={() => toggleArmed('master')}
        />

        {nativeSnapshot.streamActive && nativeSnapshot.activeInputChannels > 0 &&
          Array.from({ length: nativeSnapshot.activeInputChannels }, (_, i) => (
            <LocalMixerStrip
              key={`local-${i}`}
              channelIndex={i}
              label={nativeSnapshot.inputChannelNames[i] ?? `Input ${i + 1}`}
              deviceId={nativeSnapshot.selectedInputId}
              sendEnabled={sendEnabled.has(i)}
              onSendToggle={() => handleSendToggle(i)}
              recording={armed.has(`local:${i}`)}
              onRecord={() => toggleArmed(`local:${i}`)}
            />
          ))}

        {window.nativeAudio !== undefined && !nativeSnapshot.streamActive && (
          <div className="mixer-no-input">
            <span className="mixer-no-input__label">No audio input</span>
            <button
              type="button"
              className="ghost-action ghost-action--sm"
              onClick={() => setShowDeviceSetup(true)}
            >
              Set up audio
            </button>
          </div>
        )}

        {participants.map((p) => (
          <RemoteParticipantGroup
            key={p.socketId}
            participant={p}
            channelMeta={remoteChannelMeta.get(p.socketId)}
            channelGains={remoteChannelGains}
            onGainChange={(channelIdx, gain) => handleRemoteGainChange(p.socketId, channelIdx, gain)}
            onMuteToggle={(channelIdx) => handleRemoteMuteToggle(p.socketId, channelIdx)}
            peerLevels={nativeRemoteLevels[p.socketId] ?? []}
            armed={armed}
            onToggleRecord={toggleArmed}
          />
        ))}
      </div>

      <section className="participants-panel" aria-label="Participants">
        <p className="eyebrow" style={{ marginBottom: 8 }}>Participants</p>
        <ul>
          <li>
            <div>
              {selfSocketId && (
                <span
                  className="participant-color-dot"
                  style={{ '--participant-color': participantColor(selfSocketId) } as CSSProperties}
                  aria-hidden="true"
                />
              )}
              <span className={roomState.isHost ? 'role-badge role-badge--host' : 'role-badge role-badge--guest'}>
                {roomState.isHost ? '★ Host' : '· Guest'}
              </span>
              <strong>{username}</strong>
              <span className="participant-you">(you)</span>
              {selfSocketId && rtts.has(selfSocketId) ? (
                <span className="rtt-badge">{rtts.get(selfSocketId)} ms</span>
              ) : null}
            </div>
            <span aria-label="Media status">
              {micEnabled ? '🎤' : '🔇'} {cameraEnabled ? '📷' : '📵'}
            </span>
          </li>
          {participants.map((p) => {
            const isConnected = remoteStreams.has(p.socketId)
            return (
              <li key={p.socketId} className={p.hostMuted ? 'participant-host-muted' : ''}>
                <div>
                  <span
                    className="participant-color-dot"
                    style={{ '--participant-color': participantColor(p.socketId) } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span className={p.isHost ? 'role-badge role-badge--host' : 'role-badge role-badge--guest'}>
                    {p.isHost ? '★ Host' : '· Guest'}
                  </span>
                  <strong>{p.username}</strong>
                  {p.hostMuted && <span className="muted-badge">Muted</span>}
                  {rtts.has(p.socketId) ? (
                    <span className="rtt-badge">{rtts.get(p.socketId)} ms</span>
                  ) : null}
                  {nativeRttMap[p.socketId] !== undefined && (
                    <span className="participant-dc-rtt">
                      DC {nativeRttMap[p.socketId]} ms
                    </span>
                  )}
                </div>
                <div className="participant-right">
                  {roomState.isHost && !p.isHost && (
                    <div className="participant-controls">
                      <button
                        type="button"
                        className={['host-ctrl-btn', p.hostMuted ? 'host-ctrl-btn--active' : ''].filter(Boolean).join(' ')}
                        onClick={() => void handleHostMute(p.socketId)}
                        aria-label={p.hostMuted ? 'Unmute participant' : 'Mute participant'}
                      >
                        {p.hostMuted ? 'Unmute' : 'Mute'}
                      </button>
                      <button
                        type="button"
                        className="host-ctrl-btn host-ctrl-btn--kick"
                        onClick={() => void handleHostKick(p.socketId)}
                        aria-label="Kick participant"
                      >
                        Kick
                      </button>
                    </div>
                  )}
                  <span aria-label="Media status">
                    <span
                      className={isConnected ? 'status-online' : 'status-offline'}
                      title={isConnected ? 'Stream connected' : 'Connecting…'}
                    >
                      {isConnected ? '●' : '○'}
                    </span>
                    {' '}
                    {p.micEnabled && !p.hostMuted ? '🎤' : '🔇'} {p.cameraEnabled ? '📷' : '📵'}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )

  // Built-in node UI, keyed by type. Shared by BOTH views (Panels + Canvas).
  // Third-party nodes aren't here — they render via getNodeInstance().render().
  const panelContents: Record<string, PanelContentFn> = {
    mixer: () => mixerContent,
    chat: () => <ChatPanel selfSocketId={selfSocketId} />,
    metronome: () => metronomeContent,
    settings: (panelId) => (
      <SettingsModal onClose={() => useGraphStore.getState().closeNode(panelId)} />
    ),
  }

  return (
    <main className={[
      'rehearsal-shell',
      beatFlash ? (metronomeState.isDownbeat ? 'beat-flash--down' : 'beat-flash--up') : '',
    ].filter(Boolean).join(' ')}>

      {!inRoom ? (
        <section className="lobby-v2" aria-label="Join or host a room">
          <div className="lobby-v2__card">
            <div className="lobby-v2__logo">
              <span className="lobby-v2__logo-text">KGB SOUND</span>
            </div>

            <input
              className="lobby-v2__name-input"
              aria-label="Your name"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your name"
              type="text"
              value={username}
            />

            <div className="lobby-v2__actions">
              <button
                type="button"
                className={`lobby-v2__btn lobby-v2__btn--host${lobbyPanel === 'host' ? ' is-active' : ''}`}
                onClick={() => setLobbyPanel(lobbyPanel === 'host' ? null : 'host')}
              >
                Host Room
              </button>
              <button
                type="button"
                className={`lobby-v2__btn lobby-v2__btn--join${lobbyPanel === 'join' ? ' is-active' : ''}`}
                onClick={() => setLobbyPanel(lobbyPanel === 'join' ? null : 'join')}
              >
                Join Room
              </button>
              <button
                type="button"
                className={`lobby-v2__btn lobby-v2__btn--history${lobbyPanel === 'history' ? ' is-active' : ''}`}
                onClick={() => setLobbyPanel(lobbyPanel === 'history' ? null : 'history')}
              >
                Recent Rooms
              </button>
            </div>

            {lobbyPanel === 'host' && (
              <div className="lobby-v2__panel">
                <div className="lobby-v2__panel-row">
                  <input
                    className="lobby-v2__panel-input"
                    aria-label="Room password (optional)"
                    onChange={(e) => setHostPassword(e.target.value)}
                    placeholder="Password (optional)"
                    type="password"
                    value={hostPassword}
                  />
                  <label className="lobby-v2__limit-label">
                    <span>Max</span>
                    <select
                      aria-label="Max participants"
                      value={maxParticipants}
                      onChange={(e) => setMaxParticipants(Number(e.target.value))}
                    >
                      {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {!roomState.connected && (
                  <span className="lobby-v2__offline-note">
                    {roomState.reconnecting
                      ? (roomState.reconnectAttempt >= 3 ? '○ Waking up server… (may take ~60s)' : '○ Connecting…')
                      : '○ Server offline — local room only'}
                  </span>
                )}
                <button
                  type="button"
                  className="primary-action lobby-v2__submit-btn"
                  onClick={() => void handleCreateRoom()}
                >
                  Create Room
                </button>
              </div>
            )}

            {lobbyPanel === 'join' && (
              <div className="lobby-v2__panel">
                <div className="lobby-v2__panel-row">
                  <input
                    className="lobby-v2__panel-input lobby-v2__code-input"
                    aria-label="Room code"
                    maxLength={4}
                    onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                    placeholder="CODE"
                    type="text"
                    value={codeInput}
                  />
                  <input
                    className="lobby-v2__panel-input"
                    aria-label="Room password (optional)"
                    onChange={(e) => setJoinPassword(e.target.value)}
                    placeholder="Password (optional)"
                    type="password"
                    value={joinPassword}
                  />
                </div>
                {!roomState.connected && (
                  <span className="lobby-v2__offline-note">
                    {roomState.reconnecting
                      ? (roomState.reconnectAttempt >= 3 ? '○ Waking up server…' : '○ Connecting…')
                      : '○ Server offline'}
                  </span>
                )}
                <button
                  type="button"
                  className="ghost-action lobby-v2__submit-btn"
                  onClick={() => void handleJoinByCode()}
                  disabled={!roomState.connected || codeInput.trim().length !== 4}
                >
                  Connect
                </button>
              </div>
            )}

            {lobbyPanel === 'history' && (
              <div className="lobby-v2__history">
                {roomHistory.length === 0 ? (
                  <p className="lobby-v2__history-empty">No recent rooms</p>
                ) : (
                  <>
                    {(showAllHistory ? roomHistory : roomHistory.slice(0, 5)).map((entry) => (
                      <button
                        key={entry.shortCode}
                        type="button"
                        className="lobby-v2__history-card"
                        disabled={!roomState.connected}
                        onClick={() => {
                          setCodeInput(entry.shortCode)
                          setUsername(entry.lastUsername)
                          void handleJoinByCode(entry.shortCode, entry.lastUsername)
                        }}
                      >
                        <span className="lobby-v2__history-code">{entry.shortCode}</span>
                        <span className="lobby-v2__history-meta">
                          <span className="lobby-v2__history-name">{entry.lastUsername}</span>
                          <span className="lobby-v2__history-date">
                            {new Date(entry.lastJoinedAt).toLocaleDateString()}
                          </span>
                        </span>
                        <span className="lobby-v2__history-join">Join →</span>
                      </button>
                    ))}
                    {!showAllHistory && roomHistory.length > 5 && (
                      <button
                        type="button"
                        className="lobby-v2__show-all"
                        onClick={() => setShowAllHistory(true)}
                      >
                        Show all ({roomHistory.length})
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="lobby-v2__footer">
            <span className="socket-status">
              {roomState.reconnecting
                ? (roomState.reconnectAttempt >= 3 ? '○ Waking up server…' : '○ Connecting…')
                : roomState.connected ? '● Online' : '○ Offline'}
            </span>
            {networkError ? <p className="network-error">{networkError}</p> : null}
            {mediaError ? <p className="network-error">{mediaError}</p> : null}
          </div>
        </section>
      ) : (
        <section className="room-active" aria-label="Active room">
          {roomState.isLocalRoom ? (
            <div className="room-code-display">
              <span className="eyebrow">Local room — no server</span>
              <strong className="room-code">{roomState.shortCode}</strong>
              <span className="room-local-badge">LOCAL</span>
              <button
                type="button"
                className="ghost-action ghost-action--sm"
                onClick={() => {
                  roomSyncClient.exitLocalRoom()
                  setParticipants([])
                }}
              >
                Leave
              </button>
            </div>
          ) : roomState.isHost && roomState.shortCode ? (
            <div className="room-code-display">
              <span className="eyebrow">Room code — share with others</span>
              <strong className="room-code">{roomState.shortCode}</strong>
              <button type="button" className="ghost-action" onClick={handleCopyCode}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          ) : (
            <div className="room-code-display">
              <span className="eyebrow">Connected to room</span>
              <strong className="room-code">{roomState.shortCode ?? '…'}</strong>
            </div>
          )}
          {displayInviteLink ? (
            <div className="invite-link-row">
              <a className="invite-link" href={displayInviteLink} target="_blank" rel="noreferrer">
                {displayInviteLink}
              </a>
              <button
                type="button"
                className="ghost-action ghost-action--sm"
                onClick={() => {
                  void navigator.clipboard.writeText(displayInviteLink).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
          ) : null}
          <span className="room-role-badge">
            {roomState.isHost ? 'Host' : 'Guest'}
          </span>
          <span className="socket-status" style={{ marginLeft: 'auto' }}>
            {roomState.reconnecting ? '○ Reconnecting…' : roomState.connected ? '● Online' : '○ Offline'}
          </span>
          {networkError ? <p className="network-error">{networkError}</p> : null}
          {mediaError ? <p className="network-error">{mediaError}</p> : null}
        </section>
      )}

      {inRoom && <>
      {/* Video Grid */}
      <div className="video-controls">
        <button
          type="button"
          className={['ghost-action', 'mixer-media-btn', micEnabled ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => void handleMicToggle()}
          aria-pressed={micEnabled}
          aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {micEnabled ? '🎤 Mic On' : '🔇 Mic Off'}
        </button>
        <button
          type="button"
          className={['ghost-action', 'mixer-media-btn', cameraEnabled ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => void handleCameraToggle()}
          aria-pressed={cameraEnabled}
          aria-label={cameraEnabled ? 'Disable camera' : 'Enable camera'}
        >
          {cameraEnabled ? '📷 Cam On' : '📵 Cam Off'}
        </button>
      </div>
      {fullscreenTile ? (
        <section className="video-grid video-grid--theater" aria-label="Video grid">
          <VideoTile
            stream={fullscreenTile.stream}
            label={fullscreenTile.participant.username}
            sublabel={fullscreenTile.participant.isHost ? 'Host' : 'Guest'}
            rtt={rtts.get(fullscreenTile.participant.socketId)}
            dcRtt={nativeRttMap[fullscreenTile.participant.socketId]}
            muteAudio
            cameraEnabled={fullscreenTile.participant.cameraEnabled}
            isActiveSpeaker={activeSpeakerSocketId === fullscreenTile.participant.socketId}
            isHost={fullscreenTile.participant.isHost}
            isHostMuted={fullscreenTile.participant.hostMuted}
            canControl={roomState.isHost}
            onHostMute={() => void handleHostMute(fullscreenTile.participant.socketId)}
            onHostKick={() => void handleHostKick(fullscreenTile.participant.socketId)}
            onClick={() => setFullscreenSocketId(null)}
          />
          <div className="video-sidebar">
            <VideoTile
              stream={localStream}
              label={username}
              sublabel={roomState.isHost ? 'Host (you)' : 'You'}
              rtt={selfSocketId ? rtts.get(selfSocketId) : undefined}
              isLocal
              isHost={roomState.isHost}
              cameraEnabled={cameraEnabled}
              isActiveSpeaker={activeSpeakerSocketId === roomState.socketId}
            />
            {remoteTiles
              .filter((t) => t.participant.socketId !== fullscreenSocketId)
              .map((t) => (
                <VideoTile
                  key={t.participant.socketId}
                  stream={t.stream}
                  label={t.participant.username}
                  sublabel={t.participant.isHost ? 'Host' : 'Guest'}
                  rtt={rtts.get(t.participant.socketId)}
                  dcRtt={nativeRttMap[t.participant.socketId]}
                  muteAudio
                  cameraEnabled={t.participant.cameraEnabled}
                  isActiveSpeaker={activeSpeakerSocketId === t.participant.socketId}
                  isHost={t.participant.isHost}
                  isHostMuted={t.participant.hostMuted}
                  canControl={roomState.isHost}
                  onHostMute={() => void handleHostMute(t.participant.socketId)}
                  onHostKick={() => void handleHostKick(t.participant.socketId)}
                  onClick={() => setFullscreenSocketId(t.participant.socketId)}
                />
              ))}
          </div>
        </section>
      ) : (
        <section className="video-grid" aria-label="Video grid">
          <VideoTile
            stream={localStream}
            label={username}
            sublabel={roomState.isHost ? 'Host (you)' : inRoom ? 'Guest (you)' : 'Local'}
            rtt={selfSocketId ? rtts.get(selfSocketId) : undefined}
            isLocal
            isHost={inRoom ? roomState.isHost : undefined}
            cameraEnabled={cameraEnabled}
            isActiveSpeaker={activeSpeakerSocketId === roomState.socketId}
          />
          {remoteTiles.map((t) => (
            <VideoTile
              key={t.participant.socketId}
              stream={t.stream}
              label={t.participant.username}
              sublabel={t.participant.isHost ? 'Host' : 'Guest'}
              rtt={rtts.get(t.participant.socketId)}
              dcRtt={nativeRttMap[t.participant.socketId]}
              muteAudio
              cameraEnabled={t.participant.cameraEnabled}
              isActiveSpeaker={activeSpeakerSocketId === t.participant.socketId}
              isHost={t.participant.isHost}
              isHostMuted={t.participant.hostMuted}
              canControl={roomState.isHost}
              onHostMute={() => void handleHostMute(t.participant.socketId)}
              onHostKick={() => void handleHostKick(t.participant.socketId)}
              onClick={() => setFullscreenSocketId(t.participant.socketId)}
            />
          ))}
        </section>
      )}

      <section className="transport-bar" aria-label="Transport controls">
        <button
          type="button"
          className="primary-action"
          onClick={handlePlayStop}
          disabled={inRoom && !roomState.isHost}
          title={inRoom && !roomState.isHost ? 'Only host can control transport' : undefined}
        >
          {isStarting
            ? (metronomeState.isPreroll ? `${metronomeState.currentBeat + 1}… ✕` : 'Loading…')
            : isPlaying ? 'Stop' : 'Play'}
        </button>

        <label className="bpm-control">
          <span>BPM</span>
          <input
            aria-label="BPM"
            inputMode="numeric"
            type="text"
            value={bpmText}
            disabled={inRoom && !roomState.isHost}
            onChange={(e) => setBpmText(e.target.value)}
            onBlur={() => {
              const n = Number(bpmText)
              if (!Number.isNaN(n)) void handleBpmChange(n)
              else setBpmText(String(bpm))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = Number(bpmText)
                if (!Number.isNaN(n)) void handleBpmChange(n)
                else setBpmText(String(bpm))
              }
            }}
          />
        </label>

        <div className="metro-btn-group">
          <button
            type="button"
            className={['ghost-action', metronomeState.enabled ? 'is-active' : ''].filter(Boolean).join(' ')}
            onClick={() => void handleMetronomeToggle()}
            disabled={inRoom && !roomState.isHost}
            aria-pressed={metronomeState.enabled}
            aria-label={metronomeState.enabled ? 'Disable metronome' : 'Enable metronome'}
          >
            Click
          </button>
          <button
            type="button"
            className="ghost-action ghost-action--sm metro-settings-btn"
            onClick={() => openPanel('metronome')}
            aria-label="Metronome settings"
          >
            ▾
          </button>
        </div>

        <button
          type="button"
          className="ghost-action"
          onClick={handleClear}
          disabled={inRoom && !roomState.isHost}
          title={inRoom && !roomState.isHost ? 'Only host can clear the pattern' : undefined}
        >
          Clear
        </button>

        <div className="toolbar-right">
          <button
            type="button"
            className="ghost-action"
            onClick={() => openPanel('drum-machine')}
            aria-label="Open Drum Machine"
            title="Drum Machine"
          >
            🥁 Drum
          </button>

          <button
            type="button"
            className="ghost-action"
            onClick={() => openPanel('timeline')}
            aria-label="Open Timeline"
            title="Timeline"
          >
            🎞 Timeline
          </button>

          <div className="add-menu-wrap" ref={addMenuRef}>
            <button
              type="button"
              className={['ghost-action', 'toolbar-add-btn', addMenuOpen ? 'is-active' : ''].filter(Boolean).join(' ')}
              aria-label="Add module"
              title="Add module"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((o) => !o)}
            >
              +
            </button>
            {addMenuOpen && (
              <div className="add-menu" role="menu">
                {nodeRegistry.list().map((m) => (
                  <button
                    key={m.type}
                    type="button"
                    className="add-menu-item"
                    role="menuitem"
                    onClick={() => { openPanel(m.type); setAddMenuOpen(false) }}
                  >
                    <span className="add-menu-icon" aria-hidden="true">{m.icon}</span>
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className={['ghost-action', 'toolbar-view-toggle', viewMode === 'canvas' ? 'is-active' : ''].filter(Boolean).join(' ')}
            onClick={() => setViewMode(viewMode === 'panels' ? 'canvas' : 'panels')}
            aria-label={viewMode === 'panels' ? 'Switch to Canvas mode' : 'Switch to Panels mode'}
            aria-pressed={viewMode === 'canvas'}
          >
            {viewMode === 'panels' ? '⊞ Canvas' : '⧉ Panels'}
          </button>
        </div>
      </section>

      {viewMode === 'canvas' ? (
        <Suspense fallback={<div className="cv-loading">Loading canvas…</div>}>
          <CanvasView panelContents={panelContents} />
        </Suspense>
      ) : (
        <PanelsView panelContents={panelContents} />
      )}
      </>}

      {showDeviceSetup && (
        <DeviceSetupModal onClose={() => setShowDeviceSetup(false)} />
      )}
    </main>
  )
}

export default App
