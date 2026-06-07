import { useRef, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'

/**
 * Rotary volume knob. Vertical drag changes the value; the ring fills from the
 * 7-o'clock start position clockwise. Tinted with `color` (the participant's).
 */
type KnobProps = {
  value: number            // 0..100
  onChange: (v: number) => void
  color?: string
  size?: number
  ariaLabel: string
  disabled?: boolean
}

const SWEEP = 270          // degrees of travel
const START = -135         // angle at value 0 (pointer), 0deg = up

export function Knob({ value, onChange, color, size = 44, ariaLabel, disabled }: KnobProps) {
  const drag = useRef<{ startY: number; startVal: number } | null>(null)
  const clamp = (v: number) => Math.max(0, Math.min(100, v))

  function onDown(e: RPointerEvent<HTMLDivElement>) {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startVal: value }
  }
  function onMove(e: RPointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    const dv = (drag.current.startY - e.clientY) * 0.6  // up = louder
    onChange(clamp(Math.round(drag.current.startVal + dv)))
  }
  function onUp() { drag.current = null }

  const pct = clamp(value)
  const angle = START + (SWEEP * pct) / 100
  const style = {
    width: size,
    height: size,
    '--knob-color': color ?? 'var(--gold, #c8a84b)',
    '--knob-pct': String(pct),
  } as CSSProperties

  return (
    <div
      className={`knob${disabled ? ' knob--disabled' : ''}`}
      style={style}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + 2))
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - 2))
      }}
    >
      <span className="knob__pointer" style={{ transform: `rotate(${angle}deg)` }} aria-hidden="true" />
    </div>
  )
}
