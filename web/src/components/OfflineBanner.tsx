"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * A slim bar that appears when the browser goes offline, so the operator knows
 * why data looks frozen — and that their in-progress work is safe. Starts as
 * "online" so the server render and first client render match (navigator is
 * not available on the server); the real state is read in an effect.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-[var(--warning)] px-3 py-1.5 text-center text-xs font-medium text-white"
    >
      <WifiOff size={13} aria-hidden />
      You&apos;re offline — showing the last loaded data. Your entries are saved
      and will be here when you reconnect.
    </div>
  );
}
