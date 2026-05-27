type LocalMixerStripProps = {
  channelIndex: number
  label: string
  sendEnabled: boolean
  onSendToggle: () => void
}

export function LocalMixerStrip({ channelIndex, label, sendEnabled, onSendToggle }: LocalMixerStripProps) {
  return (
    <div className={`mixer-channel${sendEnabled ? ' mixer-channel--solo' : ''}`}>
      <div className="channel-meta">
        <strong>{label}</strong>
        <span>Local input {channelIndex + 1}</span>
      </div>

      {/* VU meter — placeholder until native level metering lands in Phase 2 */}
      <div className="level-meter" aria-hidden="true" title="Level: —">
        <span className="level-meter__bar" style={{ width: '0%' }} />
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
