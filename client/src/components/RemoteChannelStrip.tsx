type RemoteChannelStripProps = {
  peerId: string
  channelIdx: number
  label: string
  level: number
  gain: number
  muted: boolean
  onGainChange: (g: number) => void
  onMuteToggle: () => void
}

export function RemoteChannelStrip({
  peerId: _peerId,
  channelIdx,
  label,
  level,
  gain,
  muted,
  onGainChange,
  onMuteToggle,
}: RemoteChannelStripProps) {
  const gainPct = Math.round(gain * 100)

  return (
    <div className={`mixer-channel${muted ? ' mixer-channel--muted' : ''}`}>
      <div className="channel-meta">
        <strong title={label}>{label}</strong>
        <span>Ch {channelIdx + 1}</span>
      </div>

      <div className="level-meter" aria-hidden="true" title={`Level: ${Math.round(level * 100)}%`}>
        <span
          className="level-meter__bar"
          style={{
            width: `${Math.min(level, 1) * 100}%`,
            background: level > 0.85
              ? 'linear-gradient(90deg, #e07060, #f04040)'
              : level > 0.6
              ? 'linear-gradient(90deg, var(--gold), #d4a830)'
              : 'linear-gradient(90deg, var(--crystal), var(--gold))',
          }}
        />
      </div>

      <div className="channel-row">
        <span className="channel-label">Gain</span>
        <input
          type="range"
          min="0"
          max="100"
          value={gainPct}
          onChange={(e) => onGainChange(Number(e.target.value) / 100)}
          className="channel-slider"
          aria-label={`${label} gain`}
          disabled={muted}
        />
        <span className="channel-value">{gainPct}</span>
      </div>

      <div className="channel-actions">
        <button
          type="button"
          className={`channel-btn${muted ? ' channel-btn--active channel-btn--mute' : ''}`}
          onClick={onMuteToggle}
          aria-pressed={muted}
          aria-label={`${muted ? 'Unmute' : 'Mute'} ${label}`}
        >
          {muted ? 'Muted' : 'Mute'}
        </button>
      </div>
    </div>
  )
}
