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

// Priority order — lower index = better driver
const API_PRIORITY = ['ASIO', 'WASAPI_EXCLUSIVE', 'WASAPI', 'DirectSound', 'WDMKS', 'MME']
const apiRank = (kind: string) => { const i = API_PRIORITY.indexOf(kind); return i === -1 ? 99 : i }

interface DeviceGroup {
  name: string
  channelCount: number
  // One entry per available API. deviceId is the PortAudio id for THAT api.
  apis: Array<{ kind: string; deviceId: number }>
}

/**
 * PortAudio returns the same physical device once per Host API with different
 * deviceIds. Group them by name so the UI shows one row per physical device
 * and a separate driver selector.
 */
function buildDeviceGroups(devices: NativeAudioDevice[], forInput: boolean): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>()
  for (const dev of devices) {
    const ch = forInput ? dev.inputChannels : dev.outputChannels
    if (ch <= 0) continue
    if (!map.has(dev.name)) {
      map.set(dev.name, { name: dev.name, channelCount: ch, apis: [] })
    }
    const g = map.get(dev.name)!
    g.channelCount = Math.max(g.channelCount, ch)
    for (const api of dev.hostApis) {
      if (!g.apis.some((a) => a.kind === api.kind)) {
        g.apis.push({ kind: api.kind, deviceId: dev.id })
      }
    }
  }
  // Sort drivers within each group by priority
  for (const g of map.values()) {
    g.apis.sort((a, b) => apiRank(a.kind) - apiRank(b.kind))
  }
  return [...map.values()]
}

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
            const inputGroups  = buildDeviceGroups(nativeSnapshot.devices, true)
            const outputGroups = buildDeviceGroups(nativeSnapshot.devices, false)

            // Find which group the currently-selected input device belongs to
            const selInDev   = nativeSnapshot.devices.find((d) => d.id === nativeSnapshot.selectedInputId)
            const selInGroup = inputGroups.find((g) => g.name === selInDev?.name)
            const selOutDev  = nativeSnapshot.devices.find((d) => d.id === nativeSnapshot.selectedOutputId)
            const selOutGroup = outputGroups.find((g) => g.name === selOutDev?.name)

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
                    value={selInGroup?.name ?? ''}
                    onChange={(e) => {
                      const group = inputGroups.find((g) => g.name === e.target.value)
                      if (!group) return
                      // Auto-pick best driver for this device
                      const best = group.apis[0]
                      nativeAudioController.selectInput(best.deviceId, best.kind)
                    }}
                    aria-label="Input device"
                  >
                    <option value="">— выбрать —</option>
                    {inputGroups.map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.name}  ({g.channelCount} ch)
                      </option>
                    ))}
                  </select>
                </div>

                {selInGroup && (
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="native-input-driver">
                      Input driver
                    </label>
                    <select
                      id="native-input-driver"
                      className="settings-select"
                      value={nativeSnapshot.inputHostApiKind}
                      onChange={(e) => {
                        const entry = selInGroup.apis.find((a) => a.kind === e.target.value)
                        if (entry) nativeAudioController.selectInput(entry.deviceId, entry.kind)
                      }}
                      aria-label="Input driver"
                    >
                      {selInGroup.apis.map((a) => (
                        <option key={a.kind} value={a.kind}>{apiLabel(a.kind)}</option>
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
                        value={selOutGroup?.name ?? ''}
                        onChange={(e) => {
                          const group = outputGroups.find((g) => g.name === e.target.value)
                          if (!group) return
                          const best = group.apis[0]
                          nativeAudioController.selectOutput(best.deviceId, best.kind)
                        }}
                        aria-label="Output device"
                      >
                        <option value="">— выбрать —</option>
                        {outputGroups.map((g) => (
                          <option key={g.name} value={g.name}>
                            {g.name}  ({g.channelCount} ch)
                          </option>
                        ))}
                      </select>
                    </div>

                    {selOutGroup && (
                      <div className="settings-field">
                        <label className="settings-label" htmlFor="native-output-driver">
                          Output driver
                        </label>
                        <select
                          id="native-output-driver"
                          className="settings-select"
                          value={nativeSnapshot.outputHostApiKind}
                          onChange={(e) => {
                            const entry = selOutGroup.apis.find((a) => a.kind === e.target.value)
                            if (entry) nativeAudioController.selectOutput(entry.deviceId, entry.kind)
                          }}
                          aria-label="Output driver"
                        >
                          {selOutGroup.apis.map((a) => (
                            <option key={a.kind} value={a.kind}>{apiLabel(a.kind)}</option>
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
