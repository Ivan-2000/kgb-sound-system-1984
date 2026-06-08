import { useEffect, useRef, useState } from 'react'
import { nativeAudioController, type NativeAudioSnapshot } from '../audio/nativeAudioController'
import {
  apiLabel,
  buildDeviceGroups, normalizeDeviceName,
} from '../audio/deviceUtils'

type RecordingFormat = 'wav' | 'mp3'

function loadRecordingFormat(): RecordingFormat {
  return localStorage.getItem('kgb_recording_format') === 'mp3' ? 'mp3' : 'wav'
}

interface Props {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const [recordingFormat, setRecordingFormat] = useState<RecordingFormat>(loadRecordingFormat)
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeAudioSnapshot>(() => nativeAudioController.getSnapshot())
  const [useCustomOutput, setUseCustomOutput] = useState(() => nativeAudioController.getSnapshot().selectedOutputId !== null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('kgb_recording_format', recordingFormat)
  }, [recordingFormat])

  useEffect(() => {
    // Subscribe first — then load so the notification is guaranteed to arrive.
    const unsub = nativeAudioController.subscribeState(setNativeSnapshot)
    // Always request a device list when Settings opens.
    // loadDevices() has an internal guard that skips re-enumeration while a
    // stream is active (avoids crashing ASIO drivers on Pa_GetDeviceCount).
    if (window.nativeAudio !== undefined) {
      void nativeAudioController.loadDevices()
    }
    return unsub
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

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

          {/* ── Native Audio (PortAudio) ─────────────────────── */}
          {window.nativeAudio !== undefined && (() => {
            const inputGroups  = buildDeviceGroups(nativeSnapshot.devices, true)
            const outputGroups = buildDeviceGroups(nativeSnapshot.devices, false)

            // Find which group the currently-selected device belongs to.
            // normalizeDeviceName() bridges ASIO vs WASAPI/DS/MME naming differences
            // (e.g. "BEHRINGER USB WDM AUDIO 2.8.40" vs "Динамики (2- BEHRINGER USB WDM AUDIO 2.8.40)").
            const selInDev    = nativeSnapshot.devices.find((d) => d.id === nativeSnapshot.selectedInputId)
            const selInGroup  = inputGroups.find((g) => g.name === (selInDev ? normalizeDeviceName(selInDev.name) : ''))
            const selOutDev   = nativeSnapshot.devices.find((d) => d.id === nativeSnapshot.selectedOutputId)
            const selOutGroup = outputGroups.find((g) => g.name === (selOutDev ? normalizeDeviceName(selOutDev.name) : ''))

            return (
              <section className="settings-section">
                <h3 className="settings-section-title">Audio (PortAudio)</h3>

                {/* ── INPUT ── */}
                <div className="settings-field">
                  <label className="settings-label" htmlFor="native-input-device">
                    Input device
                  </label>
                  {inputGroups.length === 0 ? (
                    <p className="settings-stub">Загрузка устройств…</p>
                  ) : (
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
                  )}
                </div>

                {selInGroup && (
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="native-input-driver">
                      Driver
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
                    <span className="settings-label">Latency</span>
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
                    {(nativeSnapshot.error.toLowerCase().includes('not found') ||
                      nativeSnapshot.error.toLowerCase().includes('invalid') ||
                      nativeSnapshot.error.toLowerCase().includes('unavailable')) && (
                      <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#a09880' }}>
                        Совет: переподключи USB-устройство, перезапусти ASIO-драйвер, затем переоткрой Settings.
                      </p>
                    )}
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
