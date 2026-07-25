"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, LogOut, Package, Radio, Settings, Truck, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Spinner } from "@/components/ui";
import { api, isAuthenticated } from "@/lib/api";
import { cn } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import type { User } from "@/lib/types";

const NAV = [
  { href: "/fleet", label: "Live map", Icon: Radio },
  { href: "/trips", label: "Trips", Icon: Package },
  { href: "/vehicles", label: "Vehicles", Icon: Truck },
  { href: "/drivers", label: "Drivers", Icon: Users },
  { href: "/customers", label: "Customers", Icon: Building2 },
  { href: "/settings", label: "Settings", Icon: Settings },
];

export default function DashLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const hydrated = useHydrated();
  const {
    data: user,
    isPending,
    isError,
  } = useQuery<User>({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: hydrated && isAuthenticated(),
    retry: false,
  });

  // Redirecting is a side effect on external state (the router), which is
  // exactly what an effect is for.
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated() || isError) router.replace("/login");
  }, [hydrated, isError, router]);

  // Until hydration completes the client must render exactly what the server
  // did, so the auth-dependent branch below is deferred.
  if (!hydrated || (isPending && isAuthenticated())) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }

  function logout() {
    api.logout();
    // Without this the next user to sign in briefly sees the previous
    // account's cached fleet.
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--stroke)] px-3 sm:gap-4 sm:px-4">
        <div className="flex shrink-0 items-center gap-2.5">
          <Logo size={24} className="text-[var(--accent)]" />
          {/* The wordmark is the first thing to go on narrow screens — the
              mark alone still identifies the product. */}
          <span className="hidden font-[family-name:var(--font-jakarta)] font-semibold whitespace-nowrap lg:inline">
            Fleet Tracking
          </span>
        </div>

        <nav className="flex items-center gap-1" aria-label="Main">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                    : "text-[var(--ink-2)] hover:bg-[var(--surface)] hover:text-[var(--ink)]",
                )}
              >
                <Icon size={15} aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <ThemeToggle />
          {user && (
            <div className="hidden text-right sm:block">
              <div className="text-sm leading-tight font-medium">{user.fullName}</div>
              <div className="text-xs text-[var(--ink-2)] capitalize">{user.role}</div>
            </div>
          )}
          <button
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className="rounded-[var(--radius-control)] p-2 text-[var(--ink-2)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)]"
          >
            <LogOut size={16} aria-hidden />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
