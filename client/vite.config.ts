import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    // simple-peer references global in its internals
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Provide browser-compatible polyfills for simple-peer / readable-stream
      buffer: 'buffer/',
      events: 'events/',
    },
  },
  optimizeDeps: {
    include: ['buffer', 'events'],
  },
})
