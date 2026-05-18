import { useEffect, useRef } from 'react'

type VideoTileProps = {
  stream: MediaStream | null
  label: string
  sublabel?: string
  rtt?: number
  isLocal?: boolean
  /** Mute audio on the video element — use when Web Audio mixer handles output */
  muteAudio?: boolean
  cameraEnabled?: boolean
  /** Highlights the tile border when this participant is actively speaking */
  isActiveSpeaker?: boolean
  onClick?: () => void
}

export function VideoTile({
  stream,
  label,
  sublabel,
  rtt,
  isLocal,
  muteAudio,
  cameraEnabled = true,
  isActiveSpeaker = false,
  onClick,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
  }, [stream])

  const hasVideoTrack = stream !== null && stream.getVideoTracks().length > 0
  const showVideo = hasVideoTrack && cameraEnabled
  // Local is always muted (prevent feedback); remote is muted when mixer handles audio
  const videoMuted = isLocal || muteAudio

  const classes = [
    'video-tile',
    isActiveSpeaker ? 'video-tile--speaking' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={classes}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="video-signal">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={videoMuted}
          className={showVideo ? 'video-element' : 'video-element video-element--hidden'}
        />
        {!showVideo && (
          <span className="video-avatar">{label.slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <footer>
        <strong>{label}</strong>
        {sublabel ? <span>{sublabel}</span> : null}
        {rtt !== undefined ? <span className="rtt-badge">{rtt} ms</span> : null}
      </footer>
    </article>
  )
}
