"use client";

/**
 * UI primitives.
 *
 * Bear's visual grammar: soft grey strokes rather than hard borders, em-scaled
 * radii, restrained shadows, and the accent used sparingly. Status colour is
 * *always* paired with an icon and a text label so meaning survives
 * colour-blindness and greyscale.
 */

import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/format";
import type { HealthLevel } from "@/lib/types";

/* --- Button ------------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const variants: Record<string, string> = {
    primary:
      "gradient-accent text-white border border-transparent shadow-[var(--shadow-accent)] " +
      "hover:brightness-108 hover:-translate-y-px active:translate-y-0",
    secondary:
      "bg-[var(--bg)] text-[var(--ink)] border border-[var(--stroke)] hover:bg-[var(--surface)]",
    ghost:
      "bg-transparent text-[var(--ink-2)] border border-transparent hover:bg-[var(--surface)] hover:text-[var(--ink)]",
    danger:
      "bg-[var(--danger)] text-white hover:brightness-95 border border-transparent",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium",
        "transition-all duration-200 ease-[var(--ease-ui)] disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5 text-[0.95rem]",
        variants[variant],
        className,
      )}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/* --- Input -------------------------------------------------------------- */

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-[var(--ink)]">
          {label}
        </label>
      )}
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && inputId ? `${inputId}-error` : undefined}
        className={cn(
          "w-full rounded-[var(--radius-control)] border bg-[var(--bg)] px-3 py-2.5",
          "text-[var(--ink)] placeholder:text-[var(--ink-3)]",
          "transition-colors outline-none",
          error
            ? "border-[var(--danger)]"
            : "border-[var(--stroke)] focus:border-[var(--accent)]",
          className,
        )}
      />
      {error ? (
        <p id={inputId ? `${inputId}-error` : undefined} className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-[var(--ink-2)]">{hint}</p>
      ) : null}
    </div>
  );
}

/* --- Card --------------------------------------------------------------- */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--bg)]",
        "shadow-[var(--shadow-card)] transition-shadow duration-200 ease-[var(--ease-ui)]",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* --- Status ------------------------------------------------------------- */

const HEALTH_STYLES: Record<
  HealthLevel,
  { color: string; bg: string; Icon: typeof CheckCircle2 }
> = {
  ok: { color: "var(--success)", bg: "var(--success-soft)", Icon: CheckCircle2 },
  warn: { color: "var(--warning)", bg: "var(--warning-soft)", Icon: AlertTriangle },
  critical: { color: "var(--danger)", bg: "var(--danger-soft)", Icon: XCircle },
  idle: { color: "var(--ink-2)", bg: "var(--surface)", Icon: Circle },
};

/** Colour is never the only signal — every badge carries an icon and text. */
export function StatusBadge({
  level,
  label,
  size = "md",
}: {
  level: HealthLevel;
  label: string;
  size?: "sm" | "md";
}) {
  const { color, bg, Icon } = HEALTH_STYLES[level];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
      )}
      style={{ color, background: bg }}
    >
      <Icon size={size === "sm" ? 12 : 14} aria-hidden />
      {label}
    </span>
  );
}

export function StatusDot({ level }: { level: HealthLevel }) {
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: HEALTH_STYLES[level].color }}
      aria-hidden
    />
  );
}

/* --- Feedback ----------------------------------------------------------- */

export function EmptyState({
  illustration,
  title,
  body,
  action,
}: {
  illustration?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      {illustration && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={illustration}
          alt=""
          aria-hidden
          className="h-32 w-auto opacity-90 select-none"
        />
      )}
      <div className="max-w-sm space-y-1.5">
        <h3 className="text-lg font-semibold text-[var(--ink)]">{title}</h3>
        {body && <p className="text-sm text-[var(--ink-2)]">{body}</p>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-[var(--ink-2)]">
      <Loader2 size={18} className="animate-spin" aria-hidden />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-[var(--radius-control)] border p-3 text-sm"
      style={{
        borderColor: "var(--danger)",
        background: "var(--danger-soft)",
        color: "var(--danger)",
      }}
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** Small labelled value, used throughout the detail panel. */
export function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs tracking-wide text-[var(--ink-2)] uppercase">{label}</div>
      <div
        className={cn(
          "text-sm text-[var(--ink)]",
          mono && "font-[family-name:var(--font-jetbrains)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
