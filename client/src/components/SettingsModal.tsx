import { useEffect, useRef, useState } from 'react'

type RecordingFormat = 'wav' | 'mp3'
type HostApi = 'auto' | 'asio' | 'wasapi-exclusive' | 'wasapi-shared' | 'directsound'
type BufferSize = 64 | 128 | 256 | 512 | 1024

const HOST_API_OPTIONS: { value: HostApi; label: string }[] = [
  { value: 'auto',             label: 'Auto (recommended)' },
  { value: 'asio',             label: 'ASIO' },
  { value: 'wasapi-exclusive', label: 'WASAPI Exclusive' },
  { value: 'wasapi-shared',    label: 'WASAPI Shared' },
  { value: 'directsound',      label: 'DirectSound' },
]

const BUFFER_SIZE_OPTIONS: BufferSize[] = [64, 128, 256, 512, 1024]

function loadRecordingFormat(): RecordingFormat {
  return localStorage.getItem('kgb_recording_format') === 'mp3' ? 'mp3' : 'wav'
}

function loadHostApi(): HostApi {
  const val = localStorage.getItem('kgb_host_api') as HostApi | null
  return HOST_API_OPTIONS.some((o) => o.value === val) ? val! : 'auto'
}

function loadBufferSize(): BufferSize {
  const val = Number(localStorage.getItem('kgb_buffer_size')) as BufferSize
  return BUFFER_SIZE_OPTIONS.includes(val) ? val : 256
}

interface Props {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedInput, setSelectedInput] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')
  const [recordingFormat, setRecordingFormat] = useState<RecordingFormat>(loadRecordingFormat)
  const [hostApi, setHostApi] = useState<HostApi>(loadHostApi)
  const [bufferSize, setBufferSize] = useState<BufferSize>(loadBufferSize)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((list) => {
      setDevices(list)
      const firstInput = list.find((d) => d.kind === 'audioinput')
      const firstOutput = list.find((d) => d.kind === 'audiooutput')
      if (firstInput) setSelectedInput(firstInput.deviceId)
      if (firstOutput) setSelectedOutput(firstOutput.deviceId)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('kgb_recording_format', recordingFormat)
  }, [recordingFormat])

  useEffect(() => {
    localStorage.setItem('kgb_host_api', hostApi)
  }, [hostApi])

  useEffect(() => {
    localStorage.setItem('kgb_buffer_size', String(bufferSize))
  }, [bufferSize])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const audioInputs = devices.filter((d) => d.kind === 'audioinput')
  const audioOutputs = devices.filter((d) => d.kind === 'audiooutput')

  return (
    <div
      className="settings-overlay"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal
      aria-label="Settings"
    >
      <div className="settings-modal">
        <header className="settings-header">
          <div>
            <p className="eyebrow">KGB Sound System 85</p>
            <h2>Settings</h2>
          </div>
          <button
            type="button"
            className="ghost-action ghost-action--sm settings-close-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="settings-body">

          {/* ── Audio Device ─────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Audio Device</h3>

            <div className="settings-field">
              <label className="settings-label" htmlFor="settings-input-device">
                Input device
              </label>
              {audioInputs.length === 0 ? (
                <p className="settings-stub">No input devices found — grant microphone permission to see devices</p>
              ) : (
                <select
                  id="settings-input-device"
                  className="settings-select"
                  value={selectedInput}
                  onChange={(e) => setSelectedInput(e.target.value)}
                  aria-label="Audio input device"
                >
                  {audioInputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Input ${i + 1}`}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {audioOutputs.length > 0 && (
              <div className="settings-field">
                <label className="settings-label" htmlFor="settings-output-device">
                  Output device
                </label>
                <select
                  id="settings-output-device"
                  className="settings-select"
                  value={selectedOutput}
                  onChange={(e) => setSelectedOutput(e.target.value)}
                  aria-label="Audio output device"
                >
                  {audioOutputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Output ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="settings-field">
              <label className="settings-label" htmlFor="settings-host-api">
                Host API
              </label>
              <select
                id="settings-host-api"
                className="settings-select"
                value={hostApi}
                onChange={(e) => setHostApi(e.target.value as HostApi)}
                aria-label="Host API"
                title="Connects to the native audio driver after Phase 1"
              >
                {HOST_API_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="settings-hint">Driver wired in Phase 1 (A2). Selection is saved.</p>
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="settings-buffer-size">
                Buffer size
              </label>
              <select
                id="settings-buffer-size"
                className="settings-select"
                value={bufferSize}
                onChange={(e) => setBufferSize(Number(e.target.value) as BufferSize)}
                aria-label="Buffer size in samples"
                title="Lower = less latency, higher = more stable. Wired in Phase 1 (A3)."
              >
                {BUFFER_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} samples</option>
                ))}
              </select>
              <p className="settings-hint">Applied after Phase 1 (A3). 256 is a safe default.</p>
            </div>

            <div className="settings-field">
              <button
                type="button"
                className="ghost-action settings-reinit-btn"
                disabled
                title="Available after native audio driver is implemented"
              >
                Reinitialize device
              </button>
            </div>
          </section>

          {/* ── Recording ────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Recording</h3>

            <div className="settings-field">
              <span className="settings-label">Format</span>
              <div className="settings-radiogroup" role="radiogroup" aria-label="Recording format">
                <label className="settings-radio-label">
                  <input
                    type="radio"
                    name="kgb-recording-format"
                    value="wav"
                    checked={recordingFormat === 'wav'}
                    onChange={() => setRecordingFormat('wav')}
                  />
                  <span className="settings-radio-name">WAV</span>
                  <span className="settings-radio-desc">Lossless · larger file</span>
                </label>
                <label className="settings-radio-label">
                  <input
                    type="radio"
                    name="kgb-recording-format"
                    value="mp3"
                    checked={recordingFormat === 'mp3'}
                    onChange={() => setRecordingFormat('mp3')}
                  />
                  <span className="settings-radio-name">MP3</span>
                  <span className="settings-radio-desc">Compressed · smaller file</span>
                </label>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}
