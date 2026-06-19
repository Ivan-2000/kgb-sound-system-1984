import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { Hud } from './Hud'
import { startCoreCollector } from './collectors/core'
import { startDatapathCollector } from './collectors/datapath'
import { startRtcCollector } from './collectors/rtc'
import { startWebAudioCollector } from './collectors/webaudio'
import { startJankCollector } from './collectors/jank'
import { startMemCollector } from './collectors/mem'
import { startProcsCollector } from './collectors/procs'

// Mounted as a detached React root (not inside <App/>) on purpose: the HUD
// must survive whatever App.tsx is doing — room transitions, error boundaries,
// StrictMode remounts — without needing any prop plumbing through the app tree.
export function bootstrap(): void {
  const container = document.createElement('div')
  container.id = 'kgb-debug-hud-root'
  document.body.appendChild(container)
  createRoot(container).render(createElement(Hud))

  const stoppers = [
    startCoreCollector(),
    startDatapathCollector(),
    startRtcCollector(),
    startWebAudioCollector(),
    startJankCollector(),
    startMemCollector(),
    startProcsCollector(),
  ]

  console.log('[kgb-debug] HUD installed — press Ctrl+Shift+D to toggle')

  window.addEventListener('beforeunload', () => {
    stoppers.forEach((stop) => stop())
  })
}
