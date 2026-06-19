import { useEffect, useRef, useState } from 'react'
import { debugBus } from './bus'
import type { PeerStats, ProcessMetric } from './types'

type CoreStatus = { available: boolean; streamActive?: boolean; softmixSent?: number; softmixFailed?: number; hasOpusCadence?: boolean }
type WebAudioStatus = { available: boolean; state?: AudioContextState; sampleRate?: number }
type MemStatus = { available: boolean; limitMB?: number }
type RtcStatus = { available: boolean; peers: PeerStats[] }
type ProcsStatus = { available: boolean; processes: ProcessMetric[] }

const TABS = ['core', 'datapath', 'rtc', 'webaudio', 'jank', 'mem', 'procs', 'events'] as const
type Tab = (typeof TABS)[number]

function Sparkline({ metricKey, color = '#5fd4ff' }: { metricKey: string; color?: string }) {
  const points = debugBus.series(metricKey)
  if (points.length < 2) return <div style={{ height: 28, fontSize: 11, opacity: 0.5 }}>—</div>
  const values = points.map((p) => p.v)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 160
  const h = 28
  const step = w / (points.length - 1)
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

function Row({ label, metricKey, fmt }: { label: string; metricKey: string; fmt?: (v: number) => string }) {
  const v = debugBus.latest(metricKey)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
      <span style={{ opacity: 0.75, minWidth: 140 }}>{label}</span>
      <Sparkline metricKey={metricKey} />
      <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 600 }}>{v == null ? '—' : fmt ? fmt(v) : v.toFixed(1)}</span>
    </div>
  )
}

function Dot({ ok }: { ok: boolean | undefined }) {
  const color = ok === undefined ? '#666' : ok ? '#4caf50' : '#f44336'
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 6 }} />
}

function CoreTab() {
  const status = debugBus.getStatus<CoreStatus>('core')
  if (!status?.available) return <Unavailable note="window.nativeAudio not present (plain browser dev:web, or preload not wired)." />
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Dot ok={status.streamActive} /> stream {status.streamActive ? 'active' : 'closed'}
        {' · '}softmix sent/failed: {status.softmixSent ?? 0}/{status.softmixFailed ?? 0}
      </div>
      <Row label="xrunCount" metricKey="core.xrunCount" />
      <Row label="dropCount" metricKey="core.dropCount" />
      <Row label="bufferFillPct" metricKey="core.bufferFillPct" fmt={(v) => `${v.toFixed(0)}%`} />
      <Row label="cpuLoad (RT thread)" metricKey="core.cpuLoad" fmt={(v) => `${(v * 100).toFixed(1)}%`} />
      <Row label="softmix msgs/s" metricKey="core.softmixReceivedRate" />
      <Row label="softmix peak |x|" metricKey="core.softmixPeak" fmt={(v) => v.toFixed(3)} />
      <Row label="input latency" metricKey="core.inputLatencyMs" fmt={(v) => `${v.toFixed(1)}ms`} />
      <Row label="output latency" metricKey="core.outputLatencyMs" fmt={(v) => `${v.toFixed(1)}ms`} />
      {status.hasOpusCadence ? (
        <>
          <div style={{ marginTop: 6, opacity: 0.6, fontSize: 11 }}>JS-thread callback cadence (utility process — §1.5 single-thread risk)</div>
          <Row label="pcm callback Δ avg" metricKey="core.pcmIntervalMsAvg" fmt={(v) => `${v.toFixed(1)}ms`} />
          <Row label="pcm callback Δ max" metricKey="core.pcmIntervalMsMax" fmt={(v) => `${v.toFixed(1)}ms`} />
          <Row label="opus callback Δ avg" metricKey="core.opusIntervalMsAvg" fmt={(v) => `${v.toFixed(1)}ms`} />
          <Row label="opus callback Δ max" metricKey="core.opusIntervalMsMax" fmt={(v) => `${v.toFixed(1)}ms`} />
        </>
      ) : (
        <div style={{ marginTop: 6, opacity: 0.5, fontSize: 11 }}>opus/pcm cadence needs the utilityHost.mjs shim (see README) — not applied.</div>
      )}
    </div>
  )
}

function DatapathTab() {
  return (
    <div>
      <Row label="pcm msgs/s" metricKey="datapath.pcmMsgsPerSec" />
      <Row label="pcm KB/s" metricKey="datapath.pcmBytesPerSec" fmt={(v) => (v / 1024).toFixed(1)} />
      <Row label="opus-out msgs/s" metricKey="datapath.opusMsgsPerSec" />
      <Row label="opus-out KB/s" metricKey="datapath.opusBytesPerSec" fmt={(v) => (v / 1024).toFixed(1)} />
    </div>
  )
}

function RtcTab() {
  const status = debugBus.getStatus<RtcStatus>('rtc')
  if (!status?.available) return <Unavailable note="RTCPeerConnection is not available in this context." />
  if (status.peers.length === 0) return <div style={{ opacity: 0.6 }}>No active peer connections.</div>
  return (
    <div>
      {status.peers.map((p) => (
        <div key={p.peerId} style={{ marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #333' }}>
          <div>
            <Dot ok={p.connectionState === 'connected'} />
            <strong>{p.peerId}</strong> — {p.connectionState} / ice:{p.iceState}
            {p.rttMs != null ? ` · RTT ${p.rttMs.toFixed(0)}ms` : ''}
            {p.outgoingBitrateKbps != null ? ` · ~${p.outgoingBitrateKbps.toFixed(0)}kbps avail` : ''}
          </div>
          {p.channels.map((ch) => (
            <div key={ch.label} style={{ fontSize: 11, opacity: 0.85, marginLeft: 14 }}>
              {ch.label} ({ch.state}): sent {ch.bytesSent}B/{ch.messagesSent}msg · recv {ch.bytesReceived}B/{ch.messagesReceived}msg
            </div>
          ))}
          {p.video && (
            <div style={{ fontSize: 11, opacity: 0.85, marginLeft: 14 }}>
              video: loss {p.video.packetsLost} · jitter {p.video.jitterMs.toFixed(1)}ms · {p.video.framesPerSecond ?? '?'}fps
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function WebAudioTab() {
  const status = debugBus.getStatus<WebAudioStatus>('webaudio')
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        state: {status?.state ?? '?'} · sampleRate: {status?.sampleRate ?? '?'}
      </div>
      <Row label="base latency" metricKey="webaudio.baseLatencyMs" fmt={(v) => `${v.toFixed(2)}ms`} />
      <Row label="output latency" metricKey="webaudio.outputLatencyMs" fmt={(v) => `${v.toFixed(2)}ms`} />
      <Row label="clock drift (vs wall)" metricKey="webaudio.clockDriftMs" fmt={(v) => `${v.toFixed(2)}ms`} />
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
        Growing drift here is the AUDIT.md §1.1 risk: Web Audio and PortAudio are separate clock domains.
      </div>
    </div>
  )
}

function JankTab() {
  return (
    <div>
      <Row label="FPS" metricKey="jank.fps" />
      <Row label="frame Δ" metricKey="jank.frameDeltaMs" fmt={(v) => `${v.toFixed(1)}ms`} />
      <Row label="longtasks/s" metricKey="jank.longtaskCountPerSec" />
      <Row label="longtask busy ms/s" metricKey="jank.longtaskBusyMsPerSec" />
    </div>
  )
}

function MemTab() {
  const status = debugBus.getStatus<MemStatus>('mem')
  if (!status?.available) return <Unavailable note="performance.memory unavailable (non-Chromium renderer)." />
  return (
    <div>
      <Row label="used heap" metricKey="mem.usedHeapMB" fmt={(v) => `${v.toFixed(1)}MB`} />
      <Row label="total heap" metricKey="mem.totalHeapMB" fmt={(v) => `${v.toFixed(1)}MB`} />
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>limit: {status.limitMB?.toFixed(0)}MB — a steadily climbing used-heap line over minutes is a leak, not noise.</div>
    </div>
  )
}

function ProcsTab() {
  const status = debugBus.getStatus<ProcsStatus>('procs')
  if (!status?.available) return <Unavailable note="window.kgbDebug shim not applied — see README.md (main.js + preload.js patch)." />
  return (
    <div>
      {status.processes.map((p) => (
        <div key={p.pid} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
          <span>{p.type}{p.name ? ` (${p.name})` : ''} #{p.pid}</span>
          <span>{p.cpuPercent.toFixed(1)}% CPU · {(p.memoryKB / 1024).toFixed(0)}MB</span>
        </div>
      ))}
    </div>
  )
}

function EventsTab() {
  const events = debugBus.events()
  return (
    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
      {events.length === 0 && <div style={{ opacity: 0.5 }}>No events yet.</div>}
      {[...events].reverse().map((e, i) => (
        <div key={i} style={{ fontSize: 11, color: e.level === 'error' ? '#f44336' : e.level === 'warn' ? '#ffb300' : '#ccc' }}>
          [{e.stage}] {e.message}
        </div>
      ))}
    </div>
  )
}

function Unavailable({ note }: { note: string }) {
  return <div style={{ opacity: 0.55, fontSize: 12 }}>unavailable — {note}</div>
}

export function Hud() {
  const [visible, setVisible] = useState(false)
  const [tab, setTab] = useState<Tab>('core')
  const [, setTick] = useState(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    debugBus.setHudVisible(visible)
    if (!visible) return
    let lastTick = 0
    const loop = (now: number) => {
      if (now - lastTick > 200) {
        lastTick = now
        setTick((t) => t + 1)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [visible])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        width: 420,
        maxHeight: '85vh',
        overflowY: 'auto',
        background: 'rgba(10,10,14,0.92)',
        color: '#e6e6e6',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        borderRadius: 8,
        border: '1px solid #333',
        padding: 10,
        zIndex: 2147483647,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>KGB debug HUD</strong>
        <button onClick={() => setVisible(false)} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer' }}>
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? '#2a2a32' : 'transparent',
              color: tab === t ? '#5fd4ff' : '#aaa',
              border: '1px solid #333',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'core' && <CoreTab />}
      {tab === 'datapath' && <DatapathTab />}
      {tab === 'rtc' && <RtcTab />}
      {tab === 'webaudio' && <WebAudioTab />}
      {tab === 'jank' && <JankTab />}
      {tab === 'mem' && <MemTab />}
      {tab === 'procs' && <ProcsTab />}
      {tab === 'events' && <EventsTab />}
    </div>
  )
}
