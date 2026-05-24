// Loads the prebuilt native addon from cmake-js output directory.
// The .node file is a native binary that must be built before first use:
//   cd portaudioAddon && npm run build
'use strict'
const path = require('path')
// cmake-js (Ninja) places the .node directly in build/, not build/Release/
const candidates = [
  path.join(__dirname, 'build', 'Release', 'portaudio_addon.node'),
  path.join(__dirname, 'build', 'portaudio_addon.node'),
]
const nodePath = candidates.find((p) => require('fs').existsSync(p))
if (!nodePath) throw new Error('portaudio_addon.node not found — run: npm run build inside portaudioAddon/')
const binding = require(nodePath)
module.exports = binding
