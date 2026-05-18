import { useEffect, useRef, useState } from 'react'
import { mixerEngine } from '../mixer/mixerEngine'

type MixerChannelProps = {
  socketId: string
  username: string
  isHost: boolean
}

export function MixerChannel({ socketId, username, isHost }: MixerChannelProps) {
  const [volume, setVolume] = useState(80)
  const [muted, setMuted] = useState(false)
  const [solo, setSolo] = useState(false)
  const [pan, setPan] = useState(0)
  const [level, setLevel] = useState(0)
  const rafRef = useRef<number>(0)

  // Poll AnalyserNode for level meter via requestAnimationFrame
  useEffect(() => {
    const tick = () => {
      const rms = mixerEngine.getLevelRms(socketId)
      if (rms !== null) setLevel(rms)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [socketId])

  const handleVolume = (v: number) => {
    setVolume(v)
    mixerEngine.setVolume(socketId, v / 100)
  }

  const handleMute = () => {
    const next = !muted
    setMuted(next)
    mixerEngine.setMuted(socketId, next)
  }

  const handleSolo = () => {
    const next = !solo
    setSolo(next)
    mixerEngine.setSolo(socketId, next)
  }

  const handlePan = (v: number) => {
    setPan(v)
    mixerEngine.setPan(socketId, v / 100)
  }

  const panLabel = pan === 0 ? 'C' : pan < 0 ? `L${Math.abs(pan)}` : `R${pan}`

  return (
    <div className={`mixer-channel ${muted ? 'mixer-channel--muted' : ''} ${solo ? 'mixer-channel--solo' : ''}`}>
      <div className="channel-meta">
        <strong>{username}</strong>
        <span>{isHost ? 'Host' : 'Guest'}</span>
      </div>

      {/* Level meter */}
      <div className="level-meter" aria-hidden="true" title={`Level: ${Math.round(level * 100)}%`}>
        <span
          className="level-meter__bar"
          style={{
            width: `${level * 100}%`,
            background: level > 0.85
              ? 'linear-gradient(90deg, #e07060, #f04040)'
              : level > 0.6
              ? 'linear-gradient(90deg, var(--gold), #d4a830)'
              : 'linear-gradient(90deg, var(--crystal), var(--gold))',
          }}
        />
      </div>

      {/* Volume slider */}
      <div className="channel-row">
        <span className="channel-label">Vol</span>
        <input
          aria-label={`${username} volume`}
          type="range"
          min="0"
          max="100"
          value={volume}
          onChange={(e) => handleVolume(Number(e.target.value))}
          className="channel-slider"
          disabled={muted}
        />
        <span className="channel-value">{volume}</span>
      </div>

      {/* Pan slider */}
      <div className="channel-row">
        <span className="channel-label">Pan</span>
        <input
          aria-label={`${username} pan`}
          type="range"
          min="-100"
          max="100"
          value={pan}
          onChange={(e) => handlePan(Number(e.target.value))}
          className="channel-slider"
        />
        <span className="channel-value">{panLabel}</span>
      </div>

      {/* Mute / Solo */}
      <div className="channel-actions">
        <button
          type="button"
          className={`channel-btn ${muted ? 'channel-btn--active channel-btn--mute' : ''}`}
          onClick={handleMute}
          aria-pressed={muted}
          aria-label={`${muted ? 'Unmute' : 'Mute'} ${username}`}
        >
          {muted ? 'Muted' : 'Mute'}
        </button>
        <button
          type="button"
          className={`channel-btn ${solo ? 'channel-btn--active channel-btn--solo' : ''}`}
          onClick={handleSolo}
          aria-pressed={solo}
          aria-label={`${solo ? 'Unsolo' : 'Solo'} ${username}`}
        >
          Solo
        </button>
      </div>
    </div>
  )
}
