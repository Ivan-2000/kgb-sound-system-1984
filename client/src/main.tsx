// MUST be first: gives Tone.js a native AudioContext before any module
// constructs Tone objects (PortAudio bridge needs audioWorklet + setSinkId).
import './audio/toneNativeContext'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
