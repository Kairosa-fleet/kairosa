"use client";

import { useEffect, useState } from "react";

import { getAccessToken } from "@/lib/api";

/**
 * Viewing files that sit behind bearer authentication.
 *
 * `<img src>` and `<a href>` cannot carry an Authorization header, so pointing
 * them at a protected endpoint gets a 401 and a broken image. The two usual
 * escapes are both worse than they look:
 *
 *   * Making the files public — an insurance certificate carries the policy
 *     number and the owner's address, and a vehicle photo shows the yard.
 *   * Putting the token in the query string — it then lands in browser
 *     history, the Referer header and every access log on the way.
 *
 * So the bytes are fetched with the header like any other API call and handed
 * to the browser as an object URL. Credentials stay in headers, and the file
 * is never addressable without them.
 */

const BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:8000";

async function fetchBlob(fileUrl: string): Promise<Blob> {
  const token = getAccessToken();
  const res = await fetch(`${BASE}${fileUrl}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Could not load that file (${res.status})`);
  return res.blob();
}

/** Fetches a protected file once and exposes it as an object URL. */
export function useAuthedFile(fileUrl: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!fileUrl) return;
    let objectUrl: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const blob = await fetchBlob(fileUrl);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      // Object URLs pin their blob in memory until revoked, and a fleet list
      // re-rendering would otherwise leak one per thumbnail per render.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl]);

  return { url, failed };
}

export function AuthedImage({
  fileUrl,
  alt,
  className,
}: {
  fileUrl: string;
  alt: string;
  className?: string;
}) {
  const { url, failed } = useAuthedFile(fileUrl);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--surface)] text-[0.65rem] text-[var(--ink-3)] ${className ?? ""}`}
        title="This photo could not be loaded"
      >
        —
      </div>
    );
  }
  if (!url) {
    return <div className={`animate-pulse bg-[var(--surface)] ${className ?? ""}`} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}

/**
 * Open a protected file in a new tab.
 *
 * The tab is opened synchronously, before the fetch, because a popup blocker
 * will refuse `window.open` once it is no longer attributable to the click.
 */
export async function openAuthedFile(fileUrl: string): Promise<void> {
  const tab = window.open("", "_blank", "noopener");
  try {
    const blob = await fetchBlob(fileUrl);
    const objectUrl = URL.createObjectURL(blob);
    if (tab) {
      tab.location.href = objectUrl;
      // Give the tab time to load before releasing the blob.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } else {
      // Popup blocked — fall back to downloading it instead of failing silently.
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileUrl.split("/").pop() ?? "document";
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
  } catch {
    tab?.close();
    alert("That file could not be opened. Try signing in again.");
  }
}
