"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Spinner } from "@/components/ui";
import { isAuthenticated } from "@/lib/api";
import { useHydrated } from "@/lib/useHydrated";

/**
 * Entry point. Auth lives in localStorage (bearer tokens are shared with the
 * mobile app), so the decision has to happen client-side — a server component
 * cannot see it.
 */
export default function Home() {
  const router = useRouter();
  const hydrated = useHydrated();

  useEffect(() => {
    if (!hydrated) return;
    router.replace(isAuthenticated() ? "/fleet" : "/login");
  }, [hydrated, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label="Loading…" />
    </div>
  );
}
