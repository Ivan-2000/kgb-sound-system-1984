import { useEffect, useRef, useState } from 'react'
import { mixerEngine } from '../mixer/mixerEngine'
import { participantColor } from '../utils/participantColor'
import { MixerStrip } from './MixerStrip'

type MixerChannelProps = {
  socketId: string
  username: string
  isHost: boolean
  recording?: boolean
  onRecord?: () => void
}

export function MixerChannel({ socketId, username, isHost, recording, onRecord }: MixerChannelProps) {
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

  return (
    <MixerStrip
      name={username}
      sub={isHost ? 'Host' : 'Guest'}
      color={participantColor(socketId)}
      value={volume}
      onValue={handleVolume}
      level={level}
      muted={muted}
      onMute={handleMute}
      solo={solo}
      onSolo={handleSolo}
      pan={pan}
      onPan={handlePan}
      recording={recording}
      onRecord={onRecord}
    />
  )
}
