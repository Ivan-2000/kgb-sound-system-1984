import { nodeRegistry } from '../nodeRegistry'
import { BUILTIN_NODES } from './builtins'

let registered = false

/**
 * Register all built-in node types. Idempotent — safe to call on every app
 * startup / hot reload. Call once before the graph is used (G3 wires this into
 * App startup).
 */
export function registerBuiltinNodes(): void {
  if (registered) return
  for (const def of BUILTIN_NODES) {
    if (!nodeRegistry.has(def.manifest.type)) {
      nodeRegistry.register(def)
    }
  }
  registered = true
}

export { BUILTIN_NODES }
