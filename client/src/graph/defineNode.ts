import type { NodeDefinition } from './types'

/**
 * Helper for authoring a node (G1). Third-party node modules export the result:
 *
 * ```ts
 * import { defineNode } from 'kgb/graph'
 *
 * export default defineNode({
 *   manifest: {
 *     type: 'com.author.delay',
 *     label: 'Delay',
 *     icon: '⏱',
 *     description: 'Feedback delay',
 *     version: '1.0.0',
 *     ports: [
 *       { id: 'in',  label: 'In',  kind: 'audio', direction: 'in' },
 *       { id: 'out', label: 'Out', kind: 'audio', direction: 'out' },
 *     ],
 *     params: [
 *       { id: 'timeMs',   label: 'Time',     type: 'number', default: 250, min: 0, max: 2000 },
 *       { id: 'feedback', label: 'Feedback', type: 'number', default: 0.3, min: 0, max: 0.95 },
 *     ],
 *   },
 *   create(ctx) {
 *     ctx.onParam('timeMs', (v) => { ... })
 *     return {
 *       render: () => null,   // node's own UI
 *       dispose: () => { ... },
 *     }
 *   },
 * })
 * ```
 *
 * Currently an identity function with a typed signature — it exists so authors
 * get full type-checking against the contract and so validation/versioning can
 * be layered in later without changing call sites.
 */
export function defineNode(def: NodeDefinition): NodeDefinition {
  return def
}
