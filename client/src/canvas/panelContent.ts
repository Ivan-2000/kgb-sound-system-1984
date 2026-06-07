import { createContext, type ReactNode } from 'react'
import type { PortKind } from '../graph/types'

/**
 * Shared, non-component exports for the Canvas view (kept out of PanelNode.tsx
 * so React Fast Refresh stays happy — that file may export only components).
 */

export type PanelContentFn = (nodeId: string) => ReactNode

/** App injects the built-in content map; PanelNode reads it from here. */
export const PanelContentContext = createContext<Record<string, PanelContentFn>>({})

/** Cable / handle color per signal kind. Shared by PanelNode handles + edges. */
export const KIND_COLOR: Record<PortKind, string> = {
  audio: '#e8a14b',   // warm — native audio routing
  control: '#7ee4dc',
  trigger: '#c8a84b',
  value: '#9a7ee4',
  midi: '#5bd06a',
}
