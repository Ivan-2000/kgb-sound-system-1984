import { useEffect, useRef, useState } from 'react'
import { nativeAudioController } from '../audio/nativeAudioController'
import { MixerStrip } from './MixerStrip'
import { FxChainButton } from './FxChainButton'

type LocalMixerStripProps = {
  channelIndex: number
  label: string
  deviceId: number | null
  sendEnabled: boolean
  onSendToggle: () => void
  recording?: boolean
  onRecord?: () => void
}

function lsKey(deviceId: number | null, channelIndex: number): string | null {
  return deviceId !== null ? `kgb_ch_name_${deviceId}_${channelIndex}` : null
}

export function LocalMixerStrip({ channelIndex, label, deviceId, sendEnabled, onSendToggle, recording, onRecord }: LocalMixerStripProps) {
  const [level, setLevel] = useState(0)
  // Local fader/pan are visual for now — per-input gain/pan not yet wired to the engine.
  const [gain, setGain] = useState(100)
  const [pan, setPan] = useState(0)
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

  const nameNode = editing ? (
    <input
      ref={inputRef}
      className="mfx-name-input"
      value={displayLabel}
      onChange={(e) => setDisplayLabel(e.target.value)}
      onBlur={commitLabel}
      onKeyDown={handleKeyDown}
      aria-label={`Rename channel ${channelIndex + 1}`}
    />
  ) : (
    <span
      className="mfx-name"
      onDoubleClick={handleDoubleClick}
      title="Double-click to rename"
      style={{ cursor: 'text' }}
    >
      {displayLabel}
    </span>
  )

  return (
    <MixerStrip
      name={displayLabel}
      nameNode={nameNode}
      fxNode={<FxChainButton targetKind="channel" targetId={String(channelIndex)} label={displayLabel} />}
      sub={`In ${channelIndex + 1}`}
      value={gain}
      onValue={setGain}
      level={level}
      pan={pan}
      onPan={setPan}
      send={sendEnabled}
      onSend={onSendToggle}
      recording={recording}
      onRecord={onRecord}
    />
  )
}
