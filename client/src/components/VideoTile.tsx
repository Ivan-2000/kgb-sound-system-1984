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
  /** True if this participant is the room host (shows crown badge) */
  isHost?: boolean
  /** True if this participant has been muted by the host */
  isHostMuted?: boolean
  /** Show host-control buttons (Mute/Kick) — only for non-local tiles when viewer is host */
  canControl?: boolean
  onHostMute?: () => void
  onHostKick?: () => void
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
  isHost,
  isHostMuted,
  canControl,
  onHostMute,
  onHostKick,
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
    isHostMuted ? 'video-tile--host-muted' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={classes}
      onClick={canControl ? undefined : onClick}
      style={(!canControl && onClick) ? { cursor: 'pointer' } : undefined}
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
        {isHostMuted && (
          <span className="video-muted-overlay" aria-label="Muted by host">🔇</span>
        )}
      </div>
      <footer>
        <div className="video-footer-left">
          {isHost !== undefined && (
            <span className={isHost ? 'role-badge role-badge--host' : 'role-badge role-badge--guest'}>
              {isHost ? '★ Host' : '· Guest'}
            </span>
          )}
          <strong>{label}</strong>
          {sublabel ? <span>{sublabel}</span> : null}
        </div>
        <div className="video-footer-right">
          {rtt !== undefined ? <span className="rtt-badge">{rtt} ms</span> : null}
          {canControl && (
            <div className="video-host-controls" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={['host-ctrl-btn', isHostMuted ? 'host-ctrl-btn--active' : ''].filter(Boolean).join(' ')}
                onClick={onHostMute}
                aria-label={isHostMuted ? 'Unmute participant' : 'Mute participant'}
                title={isHostMuted ? 'Unmute' : 'Mute'}
              >
                {isHostMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                className="host-ctrl-btn host-ctrl-btn--kick"
                onClick={onHostKick}
                aria-label="Kick participant"
                title="Kick from room"
              >
                Kick
              </button>
            </div>
          )}
        </div>
      </footer>
    </article>
  )
}
