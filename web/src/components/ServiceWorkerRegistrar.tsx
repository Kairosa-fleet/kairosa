"use client";

import { useEffect } from "react";

/**
 * Registers the offline-first service worker (public/sw.js).
 *
 * Only in production: in dev, Turbopack's HMR and a caching worker fight each
 * other and you end up debugging stale bundles. The worker takes over on the
 * next load after it installs, so the first production visit primes the cache
 * and every visit after that can open offline.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration failing (e.g. private mode) must never break the app */
      });
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
