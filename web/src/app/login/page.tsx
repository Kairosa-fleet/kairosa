"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Logo } from "@/components/Logo";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import { Button, Card, Input } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, isAuthenticated } from "@/lib/api";
import { type FieldErrors, focusField, isEmail, parseApiError, withoutKey } from "@/lib/formErrors";
import { useHydrated } from "@/lib/useHydrated";

export default function LoginPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const clearErr = (k: string) => setErrors((e) => withoutKey(e, k));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    if (hydrated && isAuthenticated()) router.replace("/fleet");
  }, [hydrated, router]);

  const ERROR_ORDER =
    mode === "signup" ? ["organisation", "fullName", "email", "password"] : ["email", "password"];

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (mode === "signup") {
      if (orgName.trim().length < 2) e.organisation = "Enter your organisation's name.";
      if (fullName.trim().length < 2) e.fullName = "Enter your name.";
    }
    if (!email.trim()) e.email = "Email is required.";
    else if (!isEmail(email)) e.email = "Enter a valid email address.";
    if (!password) e.password = "Password is required.";
    else if (mode === "signup" && password.length < 12)
      e.password = "Use at least 12 characters, with letters and numbers.";
    return e;
  }

  const summaryItems: SummaryItem[] = [
    ...ERROR_ORDER.filter((k) => errors[k]).map((k) => ({ field: k, message: errors[k] })),
    ...general.map((message) => ({ message })),
  ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setGeneral([]);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = ERROR_ORDER.find((k) => found[k]) ?? Object.keys(found)[0];
      if (first) focusField(first);
      return;
    }
    setBusy(true);
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
      // A failed sign-in is an email/password problem but we can't say which —
      // show the server's reason in the summary rather than blame a field.
      const parsed = parseApiError(err);
      setErrors((prev) => ({ ...prev, ...parsed.fields }));
      setGeneral(parsed.general.length ? Array.from(new Set(parsed.general)) : ["Something went wrong. Please try again."]);
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

          <form onSubmit={submit} noValidate className="space-y-4">
            <ErrorSummary items={summaryItems} />
            {mode === "signup" && (
              <>
                <Input
                  label="Organisation name"
                  name="organisation"
                  value={orgName}
                  onChange={(e) => { setOrgName(e.target.value); clearErr("organisation"); }}
                  placeholder="Patel Logistics"
                  error={errors.organisation}
                  required
                  minLength={2}
                  autoComplete="organization"
                />
                <Input
                  label="Your name"
                  name="fullName"
                  value={fullName}
                  onChange={(e) => { setFullName(e.target.value); clearErr("fullName"); }}
                  placeholder="Pritam Vediya"
                  error={errors.fullName}
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
              onChange={(e) => { setEmail(e.target.value); clearErr("email"); }}
              placeholder="you@company.com"
              error={errors.email}
              required
              autoComplete="email"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearErr("password"); }}
              placeholder="••••••••••••"
              error={errors.password}
              required
              minLength={mode === "signup" ? 12 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              hint={
                mode === "signup"
                  ? "At least 12 characters, with letters and numbers."
                  : undefined
              }
            />

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
                setErrors({});
                setGeneral([]);
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
