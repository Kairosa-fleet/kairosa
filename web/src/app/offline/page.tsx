import { WifiOff } from "lucide-react";
import Link from "next/link";

/**
 * Shown by the service worker when a page is requested with no connection and
 * no cached copy of that route exists. Deliberately outside the dashboard shell
 * and dependency-free so it renders from the cache alone.
 */
export const metadata = { title: "Offline — Kairosa" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-[var(--surface)]">
        <WifiOff size={26} className="text-[var(--ink-2)]" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-[var(--ink-2)]">
        This screen hasn&apos;t been opened yet on this device, so there&apos;s
        nothing cached to show. Anything you were typing is saved as a draft and
        will still be here when you reconnect.
      </p>
      <Link
        href="/"
        className="rounded-[var(--radius-control)] border border-[var(--stroke)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface)]"
      >
        Try again
      </Link>
    </main>
  );
}
