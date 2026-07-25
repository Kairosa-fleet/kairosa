"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

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
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
