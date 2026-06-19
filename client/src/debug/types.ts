// Shared types for the debug/profiling overlay. Self-contained on purpose —
// this whole `debug/` folder is meant to be copy-pasted into another clone
// of the repo (see README.md) without dragging in other source files.

export type MetricPoint = { t: number; v: number }

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = { t: number; stage: string; level: LogLevel; message: string }

export type ProcessMetric = {
  pid: number
  type: string
  name?: string
  cpuPercent: number
  memoryKB: number
}

export type PeerStats = {
  peerId: string
  connectionState: RTCPeerConnectionState
  iceState: RTCIceConnectionState
  rttMs: number | null
  outgoingBitrateKbps: number | null
  channels: Array<{
    label: string
    state: RTCDataChannelState
    bytesSent: number
    bytesReceived: number
    messagesSent: number
    messagesReceived: number
  }>
  video?: { packetsLost: number; jitterMs: number; framesPerSecond: number | null }
}

// Augments the ambient `ImportMetaEnv` from vite/client so `VITE_DEBUG` is a
// known key (the base vite/client.d.ts only declares MODE/DEV/PROD/SSR).
declare global {
  interface ImportMetaEnv {
    readonly VITE_DEBUG?: string
  }

  interface Window {
    /** Optional — only present if the host app applied the main.js/preload.js
     *  shims documented in README.md. Collectors must treat this as absent. */
    kgbDebug?: {
      getProcessMetrics(): Promise<ProcessMetric[]>
    }
  }
}
