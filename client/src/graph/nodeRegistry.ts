import type { NodeDefinition, NodeManifest, PortDef } from './types'

/**
 * Registry of available node types (G1).
 *
 * Built-in nodes register at startup (G2 wraps the existing engines); third-party
 * nodes register through the plugin loader (G6). The `+` menu and the canvas node
 * palette read {@link NodeRegistry.list}.
 */

class NodeRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeRegistryError'
  }
}

/** Validate a manifest before it enters the registry. Throws on a bad node. */
function validateManifest(manifest: NodeManifest): void {
  if (!manifest.type) throw new NodeRegistryError('node manifest is missing a `type`')

  const seenPorts = new Set<string>()
  for (const port of manifest.ports) {
    if (seenPorts.has(port.id)) {
      throw new NodeRegistryError(`node "${manifest.type}" has duplicate port id "${port.id}"`)
    }
    seenPorts.add(port.id)
  }

  const seenParams = new Set<string>()
  for (const param of manifest.params) {
    if (seenParams.has(param.id)) {
      throw new NodeRegistryError(`node "${manifest.type}" has duplicate param id "${param.id}"`)
    }
    seenParams.add(param.id)
    if (param.type === 'enum' && (!param.options || param.options.length === 0)) {
      throw new NodeRegistryError(`enum param "${param.id}" on "${manifest.type}" has no options`)
    }
  }
}

class NodeRegistry {
  private defs = new Map<string, NodeDefinition>()

  /** Register a node definition. Throws if the type is already taken or invalid. */
  register(def: NodeDefinition): void {
    validateManifest(def.manifest)
    if (this.defs.has(def.manifest.type)) {
      throw new NodeRegistryError(`node type "${def.manifest.type}" is already registered`)
    }
    this.defs.set(def.manifest.type, def)
  }

  get(type: string): NodeDefinition | undefined {
    return this.defs.get(type)
  }

  has(type: string): boolean {
    return this.defs.has(type)
  }

  /** Look up a single port definition on a node type. */
  getPort(type: string, portId: string): PortDef | undefined {
    return this.defs.get(type)?.manifest.ports.find((p) => p.id === portId)
  }

  /** All registered manifests, for menus / palettes. */
  list(): NodeManifest[] {
    return Array.from(this.defs.values(), (d) => d.manifest)
  }
}

export const nodeRegistry = new NodeRegistry()
export { NodeRegistryError }
export type { NodeRegistry }
