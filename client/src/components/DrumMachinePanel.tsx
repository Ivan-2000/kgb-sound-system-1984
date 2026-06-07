import type { CSSProperties } from 'react'
import { DRUM_TRACKS, MAX_PATTERNS, type DrumMachineState, type DrumTrack } from '../drumMachine/drumMachine'
import { VALID_STEP_COUNTS, type StepCount } from '../protocol/syncProtocol'

/**
 * Drum Machine UI — presentational. Driven entirely by props so it can be bound
 * to ANY DrumMachine instance (one per node once the drum becomes duplicatable).
 * No engine/sync/transport logic here — the owner wires those.
 */

const TRACK_LABELS: Record<DrumTrack, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hat: 'Hat',
  crash: 'Crash',
}

export interface DrumMachinePanelProps {
  state: DrumMachineState
  isPlaying: boolean
  /** Host-gating: disable edits for non-host guests in a room. */
  disabled?: boolean
  onStepToggle: (track: DrumTrack, step: number) => void
  onVelocityChange: (track: DrumTrack, step: number, velocity: number) => void
  onPatternSwitch: (index: number) => void
  onStepCountChange: (n: StepCount) => void
  onSwingChange: (swing: number) => void
  onChainSet: (chain: number[] | null) => void
}

export function DrumMachinePanel({
  state,
  isPlaying,
  disabled = false,
  onStepToggle,
  onVelocityChange,
  onPatternSwitch,
  onStepCountChange,
  onSwingChange,
  onChainSet,
}: DrumMachinePanelProps) {
  return (
    <section className="sequencer-section" aria-label="Drum machine">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Drum Machine</p>
          <h2>{state.stepCount} Step Pattern</h2>
        </div>

        <div className="pattern-bank" aria-label="Pattern bank">
          {Array.from({ length: MAX_PATTERNS }, (_, i) => (
            <button
              key={i}
              type="button"
              className={[
                'ghost-action ghost-action--sm',
                i === state.activePatternIndex ? 'is-active' : '',
                state.patternActivity[i] ? 'has-content' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onPatternSwitch(i)}
              disabled={disabled}
              aria-pressed={i === state.activePatternIndex}
              aria-label={`Pattern ${i + 1}`}
            >
              {i + 1}
            </button>
          ))}
        </div>

        <div className="sequencer-controls">
          <div className="step-count-selector">
            {VALID_STEP_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                className={['ghost-action ghost-action--sm', n === state.stepCount ? 'is-active' : ''].filter(Boolean).join(' ')}
                onClick={() => onStepCountChange(n)}
                disabled={disabled}
                aria-pressed={n === state.stepCount}
              >
                {n}
              </button>
            ))}
          </div>

          <label className="swing-control">
            <span>Swing</span>
            <input
              aria-label="Swing"
              type="range"
              min={0}
              max={100}
              step={1}
              value={state.swing}
              onChange={(e) => onSwingChange(Number(e.target.value))}
              disabled={disabled}
              className="swing-slider"
            />
            <span className="swing-value">{state.swing}%</span>
          </label>
        </div>
      </div>

      <div className="step-ruler" aria-hidden="true">
        <span />
        {Array.from({ length: state.stepCount }, (_, step) => (
          <span key={step}>{step + 1}</span>
        ))}
      </div>

      <div className="sequencer-grid">
        {DRUM_TRACKS.map((track) => (
          <div className="track-row" key={track}>
            <div className="track-label">{TRACK_LABELS[track]}</div>
            {state.pattern[track].map((enabled, step) => {
              const isCurrent = isPlaying && state.currentStep === step
              const vel = state.velocity[track][step] ?? 100
              return (
                <button
                  aria-label={`${TRACK_LABELS[track]} step ${step + 1}`}
                  aria-pressed={enabled}
                  className={[
                    'step-cell',
                    enabled ? 'is-enabled' : '',
                    isCurrent ? 'is-current' : '',
                  ].filter(Boolean).join(' ')}
                  key={`${track}-${step}`}
                  onClick={() => onStepToggle(track, step)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const v = Number(window.prompt(`Velocity for ${TRACK_LABELS[track]} step ${step + 1} (1–127)`, String(vel)))
                    if (!Number.isNaN(v)) onVelocityChange(track, step, v)
                  }}
                  type="button"
                  style={enabled ? { '--vel-alpha': String(vel / 127) } as CSSProperties : undefined}
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="chain-editor" aria-label="Pattern chain">
        <button
          type="button"
          className={['ghost-action ghost-action--sm', state.chain !== null ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => onChainSet(state.chain !== null ? null : [state.activePatternIndex])}
          disabled={disabled}
          aria-pressed={state.chain !== null}
          title={state.chain !== null ? 'Disable chain mode' : 'Enable chain mode'}
        >
          Chain
        </button>

        {state.chain !== null && (
          <>
            <div className="chain-sequence">
              {state.chain.map((patIdx, pos) => (
                <button
                  key={pos}
                  type="button"
                  className={[
                    'chain-slot',
                    isPlaying && pos === state.chainPosition ? 'is-current' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => {
                    if (disabled) return
                    const next = state.chain!.filter((_, i) => i !== pos)
                    onChainSet(next.length > 0 ? next : null)
                  }}
                  disabled={disabled}
                  title={`Pattern ${patIdx + 1} — click to remove`}
                  aria-label={`Chain slot ${pos + 1}: pattern ${patIdx + 1}`}
                >
                  {patIdx + 1}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="ghost-action ghost-action--sm"
              onClick={() => onChainSet([...(state.chain ?? []), state.activePatternIndex])}
              disabled={disabled || (state.chain?.length ?? 0) >= 32}
              aria-label="Append active pattern to chain"
              title="Append active pattern to end of chain"
            >
              +
            </button>
          </>
        )}
      </div>
    </section>
  )
}
