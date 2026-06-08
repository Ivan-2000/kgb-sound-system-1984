import { useEffect, useRef, useState } from 'react'
import { nativeAudioController, type NativeAudioSnapshot } from '../audio/nativeAudioController'
import {
  apiLabel, apiRank,
  buildDeviceGroups, normalizeDeviceName,
  type DeviceGroup,
} from '../audio/deviceUtils'

interface Props {
  onClose: () => void
}

export function DeviceSetupModal({ onClose }: Props) {
  const [snap, setSnap] = useState<NativeAudioSnapshot>(() => nativeAudioController.getSnapshot())
  const [useCustomOutput, setUseCustomOutput] = useState(false)
  const [opening, setOpening] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsub = nativeAudioController.subscribeState((s) => {
      setSnap(s)
      // Auto-close once stream goes active
      if (s.streamActive) onClose()
    })
    void nativeAudioController.loadDevices()
    return unsub
  // onClose is stable (useCallback in App) — safe dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const inputGroups  = buildDeviceGroups(snap.devices, true)
  const outputGroups = buildDeviceGroups(snap.devices, false)

  const selInDev    = snap.devices.find((d) => d.id === snap.selectedInputId)
  const selInGroup  = inputGroups.find((g) => g.name === (selInDev ? normalizeDeviceName(selInDev.name) : ''))
  const selOutDev   = snap.devices.find((d) => d.id === snap.selectedOutputId)
  const selOutGroup = outputGroups.find((g) => g.name === (selOutDev ? normalizeDeviceName(selOutDev.name) : ''))

  const handleOpenStream = async () => {
    setOpening(true)
    await nativeAudioController.openStream()
    setOpening(false)
  }

  return (
    <div
      className="settings-overlay"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal
      aria-label="Audio device setup"
    >
      <div className="settings-modal">
        <header className="settings-header">
          <div>
            <p className="eyebrow">KGB Sound System 85</p>
            <h2>Audio Setup</h2>
          </div>
          <button
            type="button"
            className="ghost-action ghost-action--sm settings-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">Input device</h3>

            <div className="settings-field">
              <label className="settings-label" htmlFor="dsetup-input-device">Device</label>
              {inputGroups.length === 0 ? (
                <p className="settings-stub">Загрузка устройств…</p>
              ) : (
                <select
                  id="dsetup-input-device"
                  className="settings-select"
                  value={selInGroup?.name ?? ''}
                  onChange={(e) => {
                    const group = inputGroups.find((g) => g.name === e.target.value)
                    if (!group) return
                    const best = group.apis[0]
                    nativeAudioController.selectInput(best.deviceId, best.kind)
                  }}
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
                <label className="settings-label" htmlFor="dsetup-input-driver">Driver</label>
                <select
                  id="dsetup-input-driver"
                  className="settings-select"
                  value={snap.inputHostApiKind}
                  onChange={(e) => {
                    const entry = selInGroup.apis.find((a) => a.kind === e.target.value)
                    if (entry) nativeAudioController.selectInput(entry.deviceId, entry.kind)
                  }}
                >
                  {selInGroup.apis.map((a) => (
                    <option key={a.kind} value={a.kind}>{apiLabel(a.kind)}</option>
                  ))}
                </select>
              </div>
            )}

            {snap.maxInputChannels > 0 && (
              <div className="settings-field">
                <label className="settings-label" htmlFor="dsetup-input-channels">Channels</label>
                <select
                  id="dsetup-input-channels"
                  className="settings-select"
                  value={snap.inputChannels}
                  onChange={(e) => nativeAudioController.setInputChannels(Number(e.target.value))}
                >
                  {Array.from({ length: snap.maxInputChannels }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'канал' : n < 5 ? 'канала' : 'каналов'}
                      {n === snap.maxInputChannels ? ' (max)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Output device</h3>

            <div className="settings-field">
              <label className="settings-label settings-label--checkbox" htmlFor="dsetup-custom-output">
                <input
                  id="dsetup-custom-output"
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
            {!useCustomOutput && (
              <p className="settings-stub" style={{ margin: '0 0 4px' }}>
                Авто — тот же интерфейс или лучшее доступное устройство
              </p>
            )}

            {useCustomOutput && (
              <>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="dsetup-output-device">Device</label>
                  <select
                    id="dsetup-output-device"
                    className="settings-select"
                    value={selOutGroup?.name ?? ''}
                    onChange={(e) => {
                      const group = outputGroups.find((g) => g.name === e.target.value)
                      if (!group) return
                      const best = group.apis[0]
                      nativeAudioController.selectOutput(best.deviceId, best.kind)
                    }}
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
                    <label className="settings-label" htmlFor="dsetup-output-driver">Driver</label>
                    <select
                      id="dsetup-output-driver"
                      className="settings-select"
                      value={snap.outputHostApiKind}
                      onChange={(e) => {
                        const entry = selOutGroup.apis.find((a: { kind: string; deviceId: number }) => a.kind === e.target.value)
                        if (entry) nativeAudioController.selectOutput(entry.deviceId, entry.kind)
                      }}
                    >
                      {selOutGroup.apis.map((a: { kind: string; deviceId: number }) => (
                        <option key={a.kind} value={a.kind}>{apiLabel(a.kind)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </section>

          {snap.error !== null && (
            <section className="settings-section">
              <p className="network-error" style={{ margin: 0 }}>{snap.error}</p>
            </section>
          )}

          <section className="settings-section" style={{ borderTop: 'none' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button
                type="button"
                className="ghost-action"
                disabled={snap.selectedInputId === null || opening}
                onClick={() => { void handleOpenStream() }}
                style={{ fontWeight: 600 }}
              >
                {opening ? 'Открываем…' : 'Open Stream'}
              </button>
              <button
                type="button"
                className="ghost-action ghost-action--sm"
                onClick={onClose}
              >
                Позже
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
