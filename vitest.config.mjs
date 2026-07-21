import { defineConfig } from 'vitest/config'

// Root Vitest project — server-side (CommonJS) unit + handler tests.
// Client tests, if added later, live under client/ with their own config.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
