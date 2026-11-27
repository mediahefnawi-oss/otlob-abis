/** When this phone last sent the courier's position (shown on the courier's «موقعي» card). */
let last = 0;
const subs = new Set<() => void>();
export const lastPingAt = () => last;
export function markPing() { last = Date.now(); subs.forEach((f) => f()); }
export function subscribePing(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
export type LocPerm = 'granted' | 'denied' | 'prompt' | 'unsupported';
