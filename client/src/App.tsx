import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_BPM, MIN_BPM, audioEngine } from './audio/audioEngine'
import {
  DRUM_TRACKS,
  STEP_COUNT,
  drumMachine,
  type DrumMachineState,
  type DrumTrack,
} from './drumMachine/drumMachine'
import { roomSyncClient, type RoomState, type RoomParticipant } from './networking/roomSyncClient'
import { peerManager } from './rtc/peerManager'
import { mixerEngine } from './mixer/mixerEngine'
import { VideoTile } from './components/VideoTile'
import { MixerChannel } from './components/MixerChannel'
import type { SyncEvent } from './protocol/syncProtocol'
import type { SyncStateSnapshot } from './networking/roomSyncClient'
import './App.css'

const trackLabels: Record<DrumTrack, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hat: 'Hat',
  crash: 'Crash',
}

type LocalParticipant = RoomParticipant & { micEnabled: boolean; cameraEnabled: boolean }

function App() {
  const [machineState, setMachineState] = useState<DrumMachineState>(() => drumMachine.getState())
  const [bpm, setBpm] = useState(() => audioEngine.getBpm())
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
  const [masterVolume, setMasterVolume] = useState(100)
  const [activeSpeakerSocketId, setActiveSpeakerSocketId] = useState<string | null>(null)

  const stepLwwRef = useRef(new Map<string, number>())
  const logicalClockRef = useRef(0)

  // Persist username to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('kgb_username', username)
  }, [username])

  // Wire peerManager signal sender once on mount
  useEffect(() => {
    peerManager.setSignalSender((targetSocketId, signal) => {
      void roomSyncClient.sendRtcSignal(targetSocketId, signal)
    })
  }, [])

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

  // RTC signal relay → peerManager
  useEffect(() => {
    return roomSyncClient.subscribeRtcSignals(({ fromSocketId, signal }) => {
      peerManager.handleSignal(fromSocketId, signal as Parameters<typeof peerManager.handleSignal>[1])
    })
  }, [])

  // Participant join/leave → update list + peer connections
  useEffect(() => {
    return roomSyncClient.subscribeParticipants((event) => {
      if (event.type === 'participant_join') {
        const { socketId, username: joinedUsername } = event.payload
        setParticipants((prev) => {
          if (prev.some((p) => p.socketId === socketId)) return prev
          return [...prev, { socketId, username: joinedUsername, isHost: false, micEnabled: true, cameraEnabled: true }]
        })
        // Existing participant initiates WebRTC with the newcomer
        peerManager.addPeer(socketId, true)
        return
      }

      if (event.type === 'participant_leave') {
        const { socketId } = event.payload
        setParticipants((prev) => prev.filter((p) => p.socketId !== socketId))
        peerManager.removePeer(socketId)
        if (fullscreenSocketId === socketId) setFullscreenSocketId(null)
      }
    })
  }, [fullscreenSocketId])

  useEffect(() => drumMachine.subscribe(setMachineState), [])
  useEffect(() => roomSyncClient.subscribeRoomState(setRoomState), [])

  useEffect(
    () =>
      roomSyncClient.subscribeSyncEvents(async (event) => {
        if (event.type === 'step_toggle') {
          const lwwKey = `${event.payload.track}-${event.payload.step}`
          const previousTimestamp = stepLwwRef.current.get(lwwKey) ?? 0
          if (event.timestamp >= previousTimestamp) {
            stepLwwRef.current.set(lwwKey, event.timestamp)
            drumMachine.toggleStep(event.payload.track, event.payload.step, event.payload.value)
          }
          return
        }

        if (event.type === 'bpm_change') {
          const safeBpm = audioEngine.setBpm(event.payload.bpm)
          setBpm(safeBpm)
          return
        }

        if (event.type === 'transport_play') {
          await drumMachine.start({ step: event.payload.step })
          setIsPlaying(true)
          return
        }

        if (event.type === 'transport_stop') {
          drumMachine.stop()
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

        if (event.type === 'camera_toggle' && event.senderId) {
          const { senderId } = event
          setParticipants((prev) =>
            prev.map((p) =>
              p.socketId === senderId ? { ...p, cameraEnabled: event.payload.enabled } : p,
            ),
          )
        }
      }),
    [],
  )

  const activePatternCount = useMemo(
    () =>
      DRUM_TRACKS.reduce(
        (total, track) => total + machineState.pattern[track].filter(Boolean).length,
        0,
      ),
    [machineState.pattern],
  )

  const nextLogicalTimestamp = () => {
    logicalClockRef.current += 1
    return logicalClockRef.current
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

  const handlePlayStop = async () => {
    if (roomState.roomId && !roomState.isHost) return

    if (isPlaying) {
      drumMachine.stop()
      setIsPlaying(false)
      await emitSyncEvent({ type: 'transport_stop', payload: { step: machineState.currentStep } })
      return
    }

    setIsStarting(true)
    try {
      await drumMachine.start()
      setIsPlaying(true)
      await emitSyncEvent({ type: 'transport_play', payload: { step: machineState.currentStep } })
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

  const handleStepToggle = async (track: DrumTrack, step: number) => {
    const value = drumMachine.toggleStep(track, step)
    const timestamp = nextLogicalTimestamp()
    stepLwwRef.current.set(`${track}-${step}`, timestamp)
    await emitSyncEvent({ type: 'step_toggle', payload: { track, step, value }, timestamp })
  }

  const handleClear = () => {
    drumMachine.clearPattern()
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
      setNetworkError('USERNAME_REQUIRED')
      return
    }
    setNetworkError(null)
    await acquireLocalStream()

    try {
      const result = await roomSyncClient.createRoom(username.trim())
      setInviteLink(result.inviteLink)
      const selfSocketId = roomSyncClient.getState().socketId
      // Filter self out — host is shown via localStream tile
      setParticipants(
        result.participants
          .filter((p) => p.socketId !== selfSocketId)
          .map((p) => ({ ...p, micEnabled: true, cameraEnabled: true })),
      )
      await applySyncSnapshot(result.syncState)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'FAILED_TO_CREATE_ROOM')
    }
  }

  const handleJoinByCode = async () => {
    if (!username.trim()) {
      setNetworkError('USERNAME_REQUIRED')
      return
    }
    const code = codeInput.trim().toUpperCase()
    if (code.length !== 4) {
      setNetworkError('Enter a 4-character room code')
      return
    }
    setNetworkError(null)
    await acquireLocalStream()

    try {
      const result = await roomSyncClient.joinByCode(code, username.trim())
      const selfSocketId = roomSyncClient.getState().socketId
      setParticipants(
        result.participants
          .filter((p) => p.socketId !== selfSocketId)
          .map((p) => ({ ...p, micEnabled: true, cameraEnabled: true })),
      )
      await applySyncSnapshot(result.syncState)
    } catch (error) {
      setNetworkError(error instanceof Error ? error.message : 'FAILED_TO_JOIN_ROOM')
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

  const handleCameraToggle = async () => {
    const nextEnabled = !cameraEnabledRef.current
    cameraEnabledRef.current = nextEnabled
    setCameraEnabled(nextEnabled)
    peerManager.setCameraEnabled(nextEnabled)
    await emitSyncEvent({ type: 'camera_toggle', payload: { enabled: nextEnabled } })
  }

  const applySyncSnapshot = async (snapshot: SyncStateSnapshot | null) => {
    if (!snapshot) return

    drumMachine.setPattern(snapshot.pattern)
    const safeBpm = audioEngine.setBpm(snapshot.bpm)
    setBpm(safeBpm)

    if (snapshot.isPlaying) {
      await drumMachine.start({ step: snapshot.currentStep })
      setIsPlaying(true)
      return
    }

    drumMachine.stop()
    setIsPlaying(false)
  }

  const inRoom = Boolean(roomState.roomId)
  const selfSocketId = roomState.socketId

  // Build video grid tiles
  const remoteTiles = participants.map((p) => ({
    participant: p,
    stream: remoteStreams.get(p.socketId) ?? null,
  }))

  // Fullscreen participant (theater mode — expand one tile)
  const fullscreenTile = fullscreenSocketId
    ? remoteTiles.find((t) => t.participant.socketId === fullscreenSocketId) ?? null
    : null

  return (
    <main className="rehearsal-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">KGB Sound System 85</p>
          <h1>Rehearsal Room</h1>
        </div>
        <div className="session-strip" aria-label="Session status">
          <span>{roomState.shortCode ? `Room ${roomState.shortCode}` : 'Room local'}</span>
          <span>{roomState.isHost ? 'Host authority' : 'Guest follower'}</span>
          <span>{machineState.isLoaded ? 'Samples ready' : 'Samples idle'}</span>
          <span>{activePatternCount} steps armed</span>
          {selfSocketId && (
            <span className={roomState.connected ? 'status-online' : 'status-offline'}>
              {roomState.reconnecting ? 'Reconnecting…' : roomState.connected ? 'Online' : 'Offline'}
            </span>
          )}
        </div>
      </header>

      {!inRoom ? (
        <section className="lobby" aria-label="Join or host a room">
          <div className="lobby-name">
            <input
              aria-label="Your name"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your name"
              type="text"
              value={username}
            />
          </div>
          <div className="lobby-host">
            <button
              type="button"
              className="primary-action"
              onClick={() => void handleCreateRoom()}
              disabled={!roomState.connected}
            >
              Host Room
            </button>
          </div>
          <div className="lobby-divider">or</div>
          <div className="lobby-join">
            <input
              aria-label="Room code"
              maxLength={4}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="CODE"
              style={{ textTransform: 'uppercase', letterSpacing: '0.2em' }}
              type="text"
              value={codeInput}
            />
            <button
              type="button"
              className="ghost-action"
              onClick={() => void handleJoinByCode()}
              disabled={!roomState.connected || codeInput.trim().length !== 4}
            >
              Connect
            </button>
          </div>
          <span className="socket-status">
            {roomState.reconnecting ? '○ Reconnecting…' : roomState.connected ? '● Online' : '○ Offline'}
          </span>
          {networkError ? <p className="network-error">{networkError}</p> : null}
          {mediaError ? <p className="network-error">{mediaError}</p> : null}
        </section>
      ) : (
        <section className="room-active" aria-label="Active room">
          {roomState.isHost && roomState.shortCode ? (
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
          {inviteLink ? (
            <a className="invite-link" href={inviteLink} target="_blank" rel="noreferrer">{inviteLink}</a>
          ) : null}
          <span className="socket-status" style={{ marginLeft: 'auto' }}>
            {roomState.reconnecting ? '○ Reconnecting…' : roomState.connected ? '● Online' : '○ Offline'}
          </span>
          {networkError ? <p className="network-error">{networkError}</p> : null}
          {mediaError ? <p className="network-error">{mediaError}</p> : null}
        </section>
      )}

      {/* Video Grid */}
      {fullscreenTile ? (
        <section className="video-grid video-grid--theater" aria-label="Video grid">
          <VideoTile
            stream={fullscreenTile.stream}
            label={fullscreenTile.participant.username}
            sublabel={fullscreenTile.participant.isHost ? 'Host' : 'Guest'}
            muteAudio
            cameraEnabled={fullscreenTile.participant.cameraEnabled}
            isActiveSpeaker={activeSpeakerSocketId === fullscreenTile.participant.socketId}
            onClick={() => setFullscreenSocketId(null)}
          />
          <div className="video-sidebar">
            <VideoTile
              stream={localStream}
              label={username}
              sublabel={roomState.isHost ? 'Host (you)' : 'You'}
              isLocal
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
                  muteAudio
                  cameraEnabled={t.participant.cameraEnabled}
                  isActiveSpeaker={activeSpeakerSocketId === t.participant.socketId}
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
            isLocal
            cameraEnabled={cameraEnabled}
            isActiveSpeaker={activeSpeakerSocketId === roomState.socketId}
          />
          {remoteTiles.map((t) => (
            <VideoTile
              key={t.participant.socketId}
              stream={t.stream}
              label={t.participant.username}
              sublabel={t.participant.isHost ? 'Host' : 'Guest'}
              muteAudio
              cameraEnabled={t.participant.cameraEnabled}
              isActiveSpeaker={activeSpeakerSocketId === t.participant.socketId}
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
          disabled={isStarting || (inRoom && !roomState.isHost)}
          title={inRoom && !roomState.isHost ? 'Only host can control transport' : undefined}
        >
          {isPlaying ? 'Stop' : isStarting ? 'Loading…' : 'Play'}
        </button>

        <label className="bpm-control">
          <span>BPM</span>
          <input
            aria-label="BPM"
            inputMode="numeric"
            onChange={(event) => { void handleBpmChange(Number(event.target.value)) }}
            type="text"
            value={bpm}
            disabled={inRoom && !roomState.isHost}
          />
        </label>

        <input
          aria-label="BPM slider"
          className="bpm-slider"
          max={MAX_BPM}
          min={MIN_BPM}
          onChange={(event) => { void handleBpmChange(Number(event.target.value)) }}
          type="range"
          value={bpm}
          disabled={inRoom && !roomState.isHost}
        />

        <button
          type="button"
          className="ghost-action"
          onClick={() => void handleMicToggle()}
          aria-pressed={!micEnabled}
          aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {micEnabled ? 'Mic On' : 'Mic Off'}
        </button>

        <button
          type="button"
          className="ghost-action"
          onClick={() => void handleCameraToggle()}
          aria-pressed={!cameraEnabled}
          aria-label={cameraEnabled ? 'Disable camera' : 'Enable camera'}
        >
          {cameraEnabled ? 'Cam On' : 'Cam Off'}
        </button>

        <button type="button" className="ghost-action" onClick={handleClear}>
          Clear
        </button>
      </section>

      <section className="workspace-grid">
        <section className="sequencer-section" aria-label="Drum machine">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Drum Machine</p>
              <h2>16 Step Pattern</h2>
            </div>
            <span>{STEP_COUNT} steps / 4 tracks</span>
          </div>

          <div className="step-ruler" aria-hidden="true">
            <span />
            {Array.from({ length: STEP_COUNT }, (_, step) => (
              <span key={step}>{step + 1}</span>
            ))}
          </div>

          <div className="sequencer-grid">
            {DRUM_TRACKS.map((track) => (
              <div className="track-row" key={track}>
                <div className="track-label">{trackLabels[track]}</div>
                {machineState.pattern[track].map((enabled, step) => {
                  const isCurrent = isPlaying && machineState.currentStep === step
                  return (
                    <button
                      aria-label={`${trackLabels[track]} step ${step + 1}`}
                      aria-pressed={enabled}
                      className={[
                        'step-cell',
                        enabled ? 'is-enabled' : '',
                        isCurrent ? 'is-current' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={`${track}-${step}`}
                      onClick={() => { void handleStepToggle(track, step) }}
                      type="button"
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </section>

        <aside className="side-stack">
          <section className="mixer-panel" aria-label="Mixer">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Mixer</p>
                <h2>Participants</h2>
              </div>
            </div>

            {/* Master bus */}
            <div className="mixer-master">
              <div className="channel-meta">
                <strong>Master</strong>
                <span>Bus</span>
              </div>
              <div className="channel-row">
                <span className="channel-label">Vol</span>
                <input
                  aria-label="Master volume"
                  type="range"
                  min="0"
                  max="100"
                  value={masterVolume}
                  onChange={(e) => handleMasterVolume(Number(e.target.value))}
                  className="channel-slider"
                />
                <span className="channel-value">{masterVolume}</span>
              </div>
            </div>

            {/* Remote participant channels — each routed through Web Audio */}
            {participants.length === 0 ? (
              <p className="mixer-empty">No participants yet</p>
            ) : (
              participants.map((p) => (
                <MixerChannel
                  key={p.socketId}
                  socketId={p.socketId}
                  username={p.username}
                  isHost={p.isHost}
                />
              ))
            )}
          </section>

          <section className="participants-panel" aria-label="Participants">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Participants</p>
                <h2>Room</h2>
              </div>
            </div>

            <ul>
              <li>
                <div>
                  <strong>{username}</strong>
                  <span>{roomState.isHost ? 'Host (you)' : 'Guest (you)'}</span>
                </div>
                <span aria-label="Media status">
                  {micEnabled ? '🎤' : '🔇'} {cameraEnabled ? '📷' : '📵'}
                </span>
              </li>
              {participants.map((p) => {
                const isConnected = remoteStreams.has(p.socketId)
                return (
                  <li key={p.socketId}>
                    <div>
                      <strong>{p.username}</strong>
                      <span>{p.isHost ? 'Host' : 'Guest'}</span>
                    </div>
                    <span aria-label="Media status">
                      <span
                        className={isConnected ? 'status-online' : 'status-offline'}
                        title={isConnected ? 'Stream connected' : 'Connecting…'}
                      >
                        {isConnected ? '●' : '○'}
                      </span>
                      {' '}
                      {p.micEnabled ? '🎤' : '🔇'} {p.cameraEnabled ? '📷' : '📵'}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </aside>
      </section>
    </main>
  )
}

export default App
