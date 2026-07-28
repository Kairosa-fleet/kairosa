"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { OfflineBanner } from "@/components/OfflineBanner";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

/**
 * React Query owns all server state.
 *
 * This isn't decoration: fetching in useEffect and calling setState causes the
 * cascading-render pattern React 19's lint now rejects. Query also gives us
 * caching, dedup and refetch-on-focus for free.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Never retry auth failures — the session is gone, retrying
              // just delays the redirect to /login.
              const status = (error as { status?: number })?.status;
              if (status === 401 || status === 403) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: true,
            // Run the fetch even when the browser reports offline: the service
            // worker answers GETs from its cache, so a reload with no network
            // still shows the last loaded lists instead of an empty spinner.
            networkMode: "always",
          },
          mutations: {
            // Fail a write immediately when offline rather than silently
            // replaying it on reconnect — a booking or upload must be a
            // deliberate act, and the draft keeps the entry safe meanwhile.
            networkMode: "always",
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ServiceWorkerRegistrar />
      <OfflineBanner />
      {children}
    </QueryClientProvider>
  );
}
