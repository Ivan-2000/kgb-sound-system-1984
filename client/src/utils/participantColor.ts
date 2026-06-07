/**
 * Deterministic vibrant color for a participant, derived from their id.
 *
 * Because the color is a pure function of the (shared) socketId, every client
 * computes the SAME color for a given participant — consistent identity across
 * the room with zero sync. Tuned for the dark Persian-Luxury-Cyber theme.
 */
export function participantColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 70% 60%)`
}
