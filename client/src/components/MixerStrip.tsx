import type { CSSProperties, ReactNode } from 'react'
import { Knob } from './Knob'

/**
 * FL-style vertical mixer strip (presentational).
 *
 * Top→bottom: name, a VERTICAL volume fader paired with a peak meter, value
 * readout, M/S/→ buttons, a small PAN knob (left/right), and a round record
 * button pinned to the very bottom. The audio sources (MixerChannel,
 * RemoteChannelStrip, LocalMixerStrip) wrap this and pass values + handlers;
 * strips sit in a horizontal `.mixer-rack` row. Master is one strip, no slots.
 */
export type MixerStripProps = {
  name: string
  sub?: string
  color?: string
  /** Overrides the rendered name (e.g. an inline rename input). */
  nameNode?: ReactNode
  variant?: 'channel' | 'master'

  /** Volume fader, 0–100. */
  value: number
  onValue: (v: number) => void
  valueLabel?: string

  /** Peak meter, 0–1. */
  level?: number

  /** Pan, -100 (left) … 0 (center) … 100 (right). */
  pan?: number
  onPan?: (v: number) => void

  muted?: boolean
  onMute?: () => void
  solo?: boolean
  onSolo?: () => void
  send?: boolean
  onSend?: () => void
  recording?: boolean
  onRecord?: () => void
}

function meterBackground(level: number): string {
  if (level > 0.85) return 'linear-gradient(0deg, #e07060, #f04040)'
  if (level > 0.6) return 'linear-gradient(0deg, var(--gold), #d4a830)'
  return 'linear-gradient(0deg, var(--crystal), var(--gold))'
}

export function MixerStrip({
  name, sub, color, nameNode, variant = 'channel',
  value, onValue, valueLabel,
  level = 0,
  pan, onPan,
  muted, onMute, solo, onSolo, send, onSend, recording, onRecord,
}: MixerStripProps) {
  const style = color ? ({ '--participant-color': color } as CSSProperties) : undefined
  const cls = [
    'mfx-strip',
    variant === 'master' ? 'mfx-strip--master' : '',
    color ? 'mfx-strip--tinted' : '',
    muted ? 'mfx-strip--muted' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} style={style}>
      <div className="mfx-colorbar" aria-hidden="true" />

      <div className="mfx-head" title={sub ? `${name} · ${sub}` : name}>
        {nameNode ?? <span className="mfx-name">{name}</span>}
        {sub && <span className="mfx-sub">{sub}</span>}
      </div>

      <div className="mfx-body">
        <span className="mfx-meter" aria-hidden="true" title={`Level: ${Math.round(level * 100)}%`}>
          <span className="mfx-meter__bar" style={{ height: `${Math.min(level, 1) * 100}%`, background: meterBackground(level) }} />
        </span>
        <input
          type="range" min="0" max="100" value={value}
          onChange={(e) => onValue(Number(e.target.value))}
          className="mfx-fader" aria-label={`${name} volume`}
          disabled={muted}
        />
      </div>

      <div className="mfx-val">{valueLabel ?? value}</div>

      <div className="mfx-btns">
        {onMute && (
          <button type="button"
            className={`mfx-btn${muted ? ' mfx-btn--active mfx-btn--mute' : ''}`}
            onClick={onMute} aria-pressed={muted} aria-label={`${muted ? 'Unmute' : 'Mute'} ${name}`}
          >M</button>
        )}
        {onSolo && (
          <button type="button"
            className={`mfx-btn${solo ? ' mfx-btn--active mfx-btn--solo' : ''}`}
            onClick={onSolo} aria-pressed={solo} aria-label={`${solo ? 'Unsolo' : 'Solo'} ${name}`}
          >S</button>
        )}
        {onSend && (
          <button type="button"
            className={`mfx-btn${send ? ' mfx-btn--active mfx-btn--send' : ''}`}
            onClick={onSend} aria-pressed={send} aria-label={`${send ? 'Disable send' : 'Enable send'} ${name}`}
          >→</button>
        )}
      </div>

      {onPan && (
        <div className="mfx-pan" title="Pan">
          <Knob
            size={26}
            value={(pan ?? 0) / 2 + 50}
            onChange={(v) => onPan(Math.round((v - 50) * 2))}
            color={color}
            ariaLabel={`${name} pan`}
          />
        </div>
      )}

      {onRecord && (
        <button
          type="button"
          className={`mfx-rec${recording ? ' mfx-rec--armed' : ''}`}
          onClick={onRecord}
          aria-pressed={recording}
          aria-label={`${recording ? 'Stop' : 'Arm'} record ${name}`}
          title={recording ? 'Recording…' : 'Record to timeline'}
        />
      )}
    </div>
  )
}
