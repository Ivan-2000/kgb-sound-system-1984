import { useEffect, useRef, useState } from 'react'
import { nativeAudioController } from '../audio/nativeAudioController'

type LocalMixerStripProps = {
  channelIndex: number
  label: string
  deviceId: number | null
  sendEnabled: boolean
  onSendToggle: () => void
}

function lsKey(deviceId: number | null, channelIndex: number): string | null {
  return deviceId !== null ? `kgb_ch_name_${deviceId}_${channelIndex}` : null
}

export function LocalMixerStrip({ channelIndex, label, deviceId, sendEnabled, onSendToggle }: LocalMixerStripProps) {
  const [level, setLevel] = useState(0)
  const [editing, setEditing] = useState(false)
  const [displayLabel, setDisplayLabel] = useState<string>(() => {
    const key = lsKey(deviceId, channelIndex)
    return key ? (localStorage.getItem(key) ?? label) : label
  })

  const rafRef = useRef<number>(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevDeviceIdRef = useRef<number | null>(deviceId)
  const labelBeforeEditRef = useRef<string>('')
  const committingRef = useRef(false)

  useEffect(() => {
    if (prevDeviceIdRef.current === deviceId) return
    prevDeviceIdRef.current = deviceId
    const key = lsKey(deviceId, channelIndex)
    setDisplayLabel(key ? (localStorage.getItem(key) ?? label) : label)
  }, [deviceId, channelIndex, label])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  useEffect(() => {
    const tick = () => {
      setLevel(nativeAudioController.getChannelLevel(channelIndex))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [channelIndex])

  const handleDoubleClick = () => {
    committingRef.current = false
    labelBeforeEditRef.current = displayLabel
    setEditing(true)
  }

  const commitLabel = () => {
    if (committingRef.current) return
    committingRef.current = true
    const trimmed = displayLabel.trim()
    const effective = trimmed.length > 0 ? trimmed : label
    setDisplayLabel(effective)
    setEditing(false)
    const key = lsKey(deviceId, channelIndex)
    if (key) {
      if (trimmed.length > 0) localStorage.setItem(key, trimmed)
      else localStorage.removeItem(key)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitLabel()
    } else if (e.key === 'Escape') {
      committingRef.current = true
      setDisplayLabel(labelBeforeEditRef.current)
      setEditing(false)
    }
  }

  return (
    <div className={`mixer-channel${sendEnabled ? ' mixer-channel--solo' : ''}`}>
      <div className="channel-meta">
        {editing ? (
          <input
            ref={inputRef}
            className="channel-label-input"
            value={displayLabel}
            onChange={(e) => setDisplayLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={handleKeyDown}
            aria-label={`Rename channel ${channelIndex + 1}`}
          />
        ) : (
          <strong
            onDoubleClick={handleDoubleClick}
            title="Double-click to rename"
            style={{ cursor: 'text' }}
          >
            {displayLabel}
          </strong>
        )}
        <span>Local input {channelIndex + 1}</span>
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

      <div className="channel-actions">
        <button
          type="button"
          className={`channel-btn${sendEnabled ? ' channel-btn--active channel-btn--send' : ''}`}
          onClick={onSendToggle}
          aria-pressed={sendEnabled}
          aria-label={`${sendEnabled ? 'Disable' : 'Enable'} send for channel ${channelIndex + 1}`}
          style={sendEnabled ? { color: 'var(--crystal)', borderColor: 'var(--crystal)' } : undefined}
        >
          {sendEnabled ? 'Sending' : 'Send'}
        </button>
      </div>
    </div>
  )
}
