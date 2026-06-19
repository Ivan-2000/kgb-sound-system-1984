// Single entry point — the only line another module should ever need is
// `import './debug/install'` (see main.tsx and README.md).
//
// Gate is a runtime check, but the import is dynamic specifically so that
// when both DEV and VITE_DEBUG are false (a production build), the bootstrap
// chunk and every collector/HUD module it pulls in are never fetched.
const ENABLED = import.meta.env.DEV || import.meta.env.VITE_DEBUG === '1'

if (ENABLED) {
  void import('./bootstrap').then((m) => m.bootstrap())
}
