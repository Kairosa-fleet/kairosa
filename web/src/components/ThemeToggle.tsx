"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { cn } from "@/lib/format";

export type Theme = "light" | "dark" | "system";

const KEY = "ft.theme";
const EVENT = "ft-theme-change";

/**
 * Theme is external state (localStorage + an OS media query), so it is read
 * with useSyncExternalStore rather than mirrored into useState from an effect.
 * That avoids the cascading-render pattern and stays correct during SSR.
 */
function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readPreference(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function readResolved(): "light" | "dark" {
  const pref = readPreference();
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useThemePreference(): Theme {
  return useSyncExternalStore(subscribe, readPreference, () => "system");
}

/** Concrete theme, for consumers like the map that need a real value. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, readResolved, () => "light");
}

export function applyTheme(next: Theme) {
  if (next === "system") {
    window.localStorage.removeItem(KEY);
    document.documentElement.removeAttribute("data-theme");
  } else {
    window.localStorage.setItem(KEY, next);
    document.documentElement.setAttribute("data-theme", next);
  }
  window.dispatchEvent(new Event(EVENT));
}

export function ThemeToggle() {
  const theme = useThemePreference();
  const set = useCallback((next: Theme) => applyTheme(next), []);

  const options: Array<{ value: Theme; Icon: typeof Sun; label: string }> = [
    { value: "light", Icon: Sun, label: "Light" },
    { value: "dark", Icon: Moon, label: "Dark" },
    { value: "system", Icon: Monitor, label: "System" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--stroke)] p-0.5"
    >
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => set(value)}
          className={cn(
            "rounded-[var(--radius-pill)] p-1.5 transition-colors",
            theme === value
              ? "bg-[var(--surface-2)] text-[var(--ink)]"
              : "text-[var(--ink-3)] hover:text-[var(--ink-2)]",
          )}
        >
          <Icon size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}
