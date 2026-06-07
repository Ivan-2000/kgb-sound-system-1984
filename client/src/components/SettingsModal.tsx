import { useEffect, useRef, useState } from 'react'
import { nativeAudioController, type NativeAudioSnapshot } from '../audio/nativeAudioController'

type RecordingFormat = 'wav' | 'mp3'

const API_LABELS: Record<string, string> = {
  ASIO:             'ASIO  ★★  (наименьшая задержка)',
  WASAPI_EXCLUSIVE: 'WASAPI Exclusive  ★  (низкая задержка)',
  WASAPI:           'WASAPI Shared',
  DirectSound:      'DirectSound',
  WDMKS:            'WDM-KS',
  MME:              'MME  (legacy)',
}
const apiLabel = (kind: string) => API_LABELS[kind] ?? kind

function loadRecordingFormat(): RecordingFormat {
  return localStorage.getItem('kgb_recording_format') === 'mp3' ? 'mp3' : 'wav'
}

interface Props {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedInput, setSelectedInput] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')
  const [recordingFormat, setRecordingFormat] = useState<RecordingFormat>(loadRecordingFormat)
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeAudioSnapshot>(() => nativeAudioController.getSnapshot())
  const [useCustomOutput, setUseCustomOutput] = useState(() => nativeAudioController.getSnapshot().selectedOutputId !== null)
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
    return nativeAudioController.subscribeState(setNativeSnapshot)
  }, [])

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
              <span className="settings-label">Host API</span>
              <p className="settings-stub">
                Configure in Native Audio section below (auto-selects ASIO → WASAPI Exclusive → WASAPI → DirectSound → MME)
              </p>
            </div>
          </section>

          {/* ── Native Audio (PortAudio) ─────────────────────── */}
          {window.nativeAudio !== undefined && (() => {
            const inputDevices = nativeSnapshot.devices.filter((d) => d.inputChannels > 0)
            const outputDevices = nativeSnapshot.devices.filter((d) => d.outputChannels > 0)
            const selectedInputDev = inputDevices.find((d) => d.id === nativeSnapshot.selectedInputId)
            const selectedOutputDev = outputDevices.find((d) => d.id === nativeSnapshot.selectedOutputId)
            return (
              <section className="settings-section">
                <h3 className="settings-section-title">Native Audio (PortAudio)</h3>

                <div className="settings-field">
                  <button
                    type="button"
                    className="ghost-action settings-reinit-btn"
                    onClick={() => { void nativeAudioController.loadDevices() }}
                  >
                    Load devices
                  </button>
                </div>

                {/* ── INPUT ── */}
                <div className="settings-field">
                  <label className="settings-label" htmlFor="native-input-device">
                    Input device
                  </label>
                  <select
                    id="native-input-device"
                    className="settings-select"
                    value={nativeSnapshot.selectedInputId ?? ''}
                    onChange={(e) => {
                      if (!e.target.value) return
                      nativeAudioController.selectInput(Number(e.target.value))
                    }}
                    aria-label="Native audio input device"
                  >
                    <option value="">— select —</option>
                    {inputDevices.map((dev) => (
                      <option key={dev.id} value={dev.id}>
                        {dev.name} ({dev.inputChannels} ch)
                      </option>
                    ))}
                  </select>
                </div>

                {selectedInputDev && (
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="native-input-driver">
                      Input driver
                    </label>
                    <select
                      id="native-input-driver"
                      className="settings-select"
                      value={nativeSnapshot.inputHostApiKind}
                      onChange={(e) => {
                        nativeAudioController.selectInput(nativeSnapshot.selectedInputId!, e.target.value)
                      }}
                      aria-label="Input driver"
                    >
                      {selectedInputDev.hostApis.map((api) => (
                        <option key={api.kind} value={api.kind}>{apiLabel(api.kind)}</option>
                      ))}
                    </select>
                  </div>
                )}

                {nativeSnapshot.maxInputChannels > 0 && (
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="native-input-channels">
                      Input channels
                    </label>
                    <select
                      id="native-input-channels"
                      className="settings-select"
                      value={nativeSnapshot.inputChannels}
                      onChange={(e) => nativeAudioController.setInputChannels(Number(e.target.value))}
                      aria-label="Input channel count"
                    >
                      {Array.from({ length: nativeSnapshot.maxInputChannels }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n} {n === 1 ? 'канал' : n < 5 ? 'канала' : 'каналов'}
                          {n === nativeSnapshot.maxInputChannels ? ' (max)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* ── OUTPUT ── */}
                <div className="settings-field">
                  <label className="settings-label settings-label--checkbox" htmlFor="native-custom-output">
                    <input
                      id="native-custom-output"
                      type="checkbox"
                      checked={useCustomOutput}
                      onChange={(e) => {
                        setUseCustomOutput(e.target.checked)
                        if (!e.target.checked) nativeAudioController.clearOutput()
                      }}
                    />
                    Отдельное output устройство
                  </label>
                </div>

                {useCustomOutput && (
                  <>
                    <div className="settings-field">
                      <label className="settings-label" htmlFor="native-output-device">
                        Output device
                      </label>
                      <select
                        id="native-output-device"
                        className="settings-select"
                        value={nativeSnapshot.selectedOutputId ?? ''}
                        onChange={(e) => {
                          if (!e.target.value) return
                          nativeAudioController.selectOutput(Number(e.target.value))
                        }}
                        aria-label="Native audio output device"
                      >
                        <option value="">— select —</option>
                        {outputDevices.map((dev) => (
                          <option key={dev.id} value={dev.id}>
                            {dev.name} ({dev.outputChannels} ch)
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedOutputDev && (
                      <div className="settings-field">
                        <label className="settings-label" htmlFor="native-output-driver">
                          Output driver
                        </label>
                        <select
                          id="native-output-driver"
                          className="settings-select"
                          value={nativeSnapshot.outputHostApiKind}
                          onChange={(e) => {
                            nativeAudioController.selectOutput(nativeSnapshot.selectedOutputId!, e.target.value)
                          }}
                          aria-label="Output driver"
                        >
                          {selectedOutputDev.hostApis.map((api) => (
                            <option key={api.kind} value={api.kind}>{apiLabel(api.kind)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}

                <div className="settings-field">
                  <label className="settings-label" htmlFor="native-buffer-size">
                    Buffer size
                  </label>
                  <select
                    id="native-buffer-size"
                    className="settings-select"
                    value={nativeSnapshot.bufferSize}
                    onChange={(e) => {
                      nativeAudioController.setBufferSize(Number(e.target.value) as 64 | 128 | 256 | 512)
                    }}
                    aria-label="Buffer size"
                  >
                    {([64, 128, 256, 512] as const).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>

                <div className="settings-field">
                  <label className="settings-label" htmlFor="native-monitor-gain">
                    Monitor: {nativeSnapshot.monitorGain.toFixed(2)}
                  </label>
                  <input
                    id="native-monitor-gain"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={nativeSnapshot.monitorGain}
                    onChange={(e) => nativeAudioController.setMonitorGain(Number(e.target.value))}
                    className="channel-slider"
                    aria-label="Monitor gain"
                  />
                </div>

                {(nativeSnapshot.inputLatencyMs !== null || nativeSnapshot.outputLatencyMs !== null) && (
                  <div className="settings-field">
                    <span className="settings-label">Audio latency</span>
                    <span className="settings-stub">
                      In: {nativeSnapshot.inputLatencyMs ?? '—'} ms &nbsp;|&nbsp; Out: {nativeSnapshot.outputLatencyMs ?? '—'} ms
                    </span>
                  </div>
                )}

                <div className="settings-field" style={{ gap: '0.5rem', display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="ghost-action settings-reinit-btn"
                    disabled={nativeSnapshot.selectedInputId === null || nativeSnapshot.streamActive}
                    onClick={() => { void nativeAudioController.openStream() }}
                  >
                    Open Stream
                  </button>
                  <button
                    type="button"
                    className="ghost-action settings-reinit-btn"
                    disabled={!nativeSnapshot.streamActive}
                    onClick={() => { void nativeAudioController.closeStream() }}
                  >
                    Close Stream
                  </button>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: nativeSnapshot.streamActive ? '#1a7a1a' : '#7a1a1a',
                      color: '#fff',
                    }}
                  >
                    {nativeSnapshot.streamActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>

                {nativeSnapshot.error !== null && (
                  <div className="settings-field">
                    <p className="network-error" style={{ margin: 0 }}>{nativeSnapshot.error}</p>
                  </div>
                )}
              </section>
            )
          })()}

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
