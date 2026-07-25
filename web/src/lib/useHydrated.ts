"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False during server render and during the hydration pass, true afterwards.
 *
 * Anything derived from browser-only state (localStorage tokens, matchMedia)
 * differs between server and client. Branching the tree on it directly causes
 * a hydration mismatch — React 19 reports it as error #418. Gating on this
 * hook keeps the first client render identical to the server's, then swaps to
 * the real value on the next render.
 *
 * useSyncExternalStore is used rather than useState+useEffect so no state is
 * set from an effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true, // client
    () => false, // server / hydration
  );
}
