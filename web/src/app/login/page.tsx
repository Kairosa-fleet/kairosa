"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Logo } from "@/components/Logo";
import { Button, Card, ErrorNote, Input } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, isAuthenticated } from "@/lib/api";
import { useHydrated } from "@/lib/useHydrated";

export default function LoginPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    if (hydrated && isAuthenticated()) router.replace("/fleet");
  }, [hydrated, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await api.login(email, password);
      } else {
        await api.bootstrap({
          organization_name: orgName,
          email,
          password,
          full_name: fullName,
        });
      }
      router.replace("/fleet");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen">
      {/* Left: the form. Right: context. On mobile the panel drops away. */}
      <div className="flex w-full flex-col justify-center px-6 py-12 lg:w-1/2 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Logo size={28} className="text-[var(--accent)]" />
              <span className="font-[family-name:var(--font-jakarta)] text-lg font-semibold">
                Kairosa
              </span>
            </div>
            <ThemeToggle />
          </div>

          <h1 className="mb-2 text-[2rem]">
            {mode === "login" ? "Welcome back" : "Create your fleet"}
          </h1>
          <p className="mb-8 text-[var(--ink-2)]">
            {mode === "login"
              ? "Sign in to see where your vehicles are right now."
              : "Set up your organisation and the first administrator account."}
          </p>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <>
                <Input
                  label="Organisation name"
                  name="organisation"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Patel Logistics"
                  required
                  minLength={2}
                  autoComplete="organization"
                />
                <Input
                  label="Your name"
                  name="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Pritam Vediya"
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </>
            )}

            <Input
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoComplete="email"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              required
              minLength={mode === "signup" ? 12 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              hint={
                mode === "signup"
                  ? "At least 12 characters, with letters and numbers."
                  : undefined
              }
            />

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" loading={busy} className="w-full">
              {mode === "login" ? "Sign in" : "Create fleet"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-[var(--ink-2)]">
            {mode === "login" ? "Setting up for the first time?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
              className="font-medium text-[var(--accent)] hover:underline"
            >
              {mode === "login" ? "Create a fleet" : "Sign in"}
            </button>
          </p>
        </div>
      </div>

      <aside className="wash-accent hidden items-center justify-center bg-[var(--surface)] p-16 lg:flex lg:w-1/2">
        <div className="max-w-md">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/illustrations/navigation.svg"
            alt=""
            aria-hidden
            className="mb-10 w-full max-w-sm"
          />
          <h2 className="mb-3 text-[1.6rem]">Know where every vehicle is</h2>
          <p className="text-[var(--ink-2)]">
            Live positions, trip history, and location-integrity checks that flag
            spoofed GPS before it reaches your reports.
          </p>
          <Card className="lift mt-8" padded>
            <div className="flex items-start gap-3">
              <span className="mt-1 size-2 shrink-0 rounded-full bg-[var(--success)]" />
              <div>
                <div className="text-sm font-medium">Integrity scoring built in</div>
                <p className="mt-0.5 text-sm text-[var(--ink-2)]">
                  Every fix is checked against physics — teleports, impossible
                  speeds and mock-location apps get flagged automatically.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </aside>
    </main>
  );
}
