import { useEffect, useRef, useState } from 'react'
import { nativeAudioController } from '../audio/nativeAudioController'

type LocalMixerStripProps = {
  channelIndex: number
  label: string
  sendEnabled: boolean
  onSendToggle: () => void
}

export function LocalMixerStrip({ channelIndex, label, sendEnabled, onSendToggle }: LocalMixerStripProps) {
  const [level, setLevel] = useState(0)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const tick = () => {
      setLevel(nativeAudioController.getChannelLevel(channelIndex))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [channelIndex])

  return (
    <div className={`mixer-channel${sendEnabled ? ' mixer-channel--solo' : ''}`}>
      <div className="channel-meta">
        <strong>{label}</strong>
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
