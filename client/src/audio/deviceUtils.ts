// Shared helpers for device grouping, used by SettingsModal and DeviceSetupModal.

export const API_LABELS: Record<string, string> = {
  ASIO:             'ASIO  ★★  (наименьшая задержка)',
  WASAPI_EXCLUSIVE: 'WASAPI Exclusive  ★  (низкая задержка)',
  WASAPI:           'WASAPI Shared',
  DirectSound:      'DirectSound',
  WDMKS:            'WDM-KS',
  MME:              'MME  (legacy)',
}
export const apiLabel = (kind: string) => API_LABELS[kind] ?? kind

const API_PRIORITY = ['ASIO', 'WASAPI_EXCLUSIVE', 'WASAPI', 'DirectSound', 'WDMKS', 'MME']
export const apiRank = (kind: string) => {
  const i = API_PRIORITY.indexOf(kind)
  return i === -1 ? 99 : i
}

export interface DeviceGroup {
  name: string
  channelCount: number
  apis: Array<{ kind: string; deviceId: number }>
}

/**
 * Windows PortAudio names follow two patterns:
 *   ASIO      → "BEHRINGER USB WDM AUDIO 2.8.40"
 *   WASAPI/DS/MME → "Динамики (2- BEHRINGER USB WDM AUDIO 2.8.40)"
 *
 * Normalize by extracting the content of the last parentheses (stripping
 * any leading "N- " channel prefix). This merges all API variants of the
 * same physical device into one group.
 */
export function normalizeDeviceName(name: string): string {
  const m = name.match(/\((.+)\)\s*$/)
  if (m) return m[1].replace(/^\d+-\s*/, '').trim()
  return name.trim()
}

/**
 * Find the Web Audio API `audiooutput` device ID that best matches a PortAudio device name.
 *
 * PortAudio and Web Audio use completely different identifier systems; we match
 * them by normalised name substring.
 *
 * `enumerateDevices()` returns empty labels until the browser has been granted
 * microphone access via `getUserMedia`.  This function requests a throwaway audio
 * stream first so labels are always populated — in Electron the permission is
 * auto-approved via `setPermissionRequestHandler` in main.js.
 */
export async function findWebAudioOutputDeviceId(portAudioDeviceName: string): Promise<string | null> {
  try {
    // Unlock device labels by requesting (and immediately discarding) a mic stream.
    // No-op if permission was already granted this session.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      // Permission denied or unavailable — labels may be empty; proceed anyway.
    }

    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(
      (d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default' && d.deviceId !== 'communications',
    )
    const needle = normalizeDeviceName(portAudioDeviceName).toLowerCase()
    // Prefer an exact normalised-name match, then a substring match.
    for (const d of outputs) {
      if (!d.label) continue
      const haystack = normalizeDeviceName(d.label).toLowerCase()
      if (haystack === needle) return d.deviceId
    }
    for (const d of outputs) {
      if (!d.label) continue
      const haystack = normalizeDeviceName(d.label).toLowerCase()
      if (haystack.includes(needle) || needle.includes(haystack)) return d.deviceId
    }
    return null
  } catch {
    return null
  }
}

export function buildDeviceGroups(devices: NativeAudioDevice[], forInput: boolean): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>()
  for (const dev of devices) {
    const ch = forInput ? dev.inputChannels : dev.outputChannels
    if (ch <= 0) continue
    const key = normalizeDeviceName(dev.name)
    if (!map.has(key)) map.set(key, { name: key, channelCount: ch, apis: [] })
    const g = map.get(key)!
    g.channelCount = Math.max(g.channelCount, ch)
    for (const api of dev.hostApis) {
      if (!g.apis.some((a) => a.kind === api.kind)) {
        g.apis.push({ kind: api.kind, deviceId: dev.id })
      }
    }
  }
  for (const g of map.values()) {
    g.apis.sort((a, b) => apiRank(a.kind) - apiRank(b.kind))
  }
  return [...map.values()]
}
