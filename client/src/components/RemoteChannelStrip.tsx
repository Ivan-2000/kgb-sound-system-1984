import { useState } from 'react'
import { participantColor } from '../utils/participantColor'
import { MixerStrip } from './MixerStrip'

type RemoteChannelStripProps = {
  peerId: string
  channelIdx: number
  label: string
  level: number
  gain: number
  muted: boolean
  onGainChange: (g: number) => void
  onMuteToggle: () => void
  recording?: boolean
  onRecord?: () => void
}

export function RemoteChannelStrip({
  peerId,
  channelIdx,
  label,
  level,
  gain,
  muted,
  onGainChange,
  onMuteToggle,
  recording,
  onRecord,
}: RemoteChannelStripProps) {
  const gainPct = Math.round(gain * 100)
  // Pan is visual for now — native per-channel pan is not yet wired to the engine.
  const [pan, setPan] = useState(0)

  return (
    <MixerStrip
      name={label}
      sub={`Ch ${channelIdx + 1}`}
      color={participantColor(peerId)}
      value={gainPct}
      onValue={(v) => onGainChange(v / 100)}
      level={level}
      muted={muted}
      onMute={onMuteToggle}
      pan={pan}
      onPan={setPan}
      recording={recording}
      onRecord={onRecord}
    />
  )
}
