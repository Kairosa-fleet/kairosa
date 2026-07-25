import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { Providers } from "@/components/Providers";
import "./globals.css";
// Loaded once at the root so map markers and controls are positioned
// correctly on every route. Importing it only inside a component left it
// missing wherever that component was code-split away from the map bundle —
// which is why the address picker's pin rendered detached from the map.
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * Fonts are self-hosted from public/fonts — no request ever leaves for Google
 * or a CDN, which keeps the app fast and avoids shipping user IPs to a third
 * party. All three are SIL OFL. See docs/DESIGN_SYSTEM.md.
 */
const inter = localFont({
  src: "../../public/fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
});

const jakarta = localFont({
  src: "../../public/fonts/PlusJakartaSans-Variable.woff2",
  variable: "--font-jakarta",
  display: "swap",
  weight: "200 800",
});

const jetbrains = localFont({
  src: "../../public/fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-jetbrains",
  display: "swap",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "Fleet Tracking",
  description: "Live vehicle tracking with location-integrity monitoring.",
  icons: { icon: "/brand/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#16181a" },
  ],
};

/**
 * Runs before first paint so a user with a saved dark preference never sees a
 * white flash. It has to be inline and blocking for that to work.
 */
const themeScript = `
(function () {
  try {
    var t = localStorage.getItem("ft.theme");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jakarta.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* First child of <body>, not in <head>: the App Router manages <head>
            itself, and injecting a raw script there causes a hydration
            mismatch. Here it still runs before paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
