import type { MetadataRoute } from "next";

/**
 * The web-app manifest. Next serves this at /manifest.webmanifest and injects
 * the <link> automatically. It makes Kairosa installable (add-to-home-screen)
 * and, together with the service worker, gives it a standalone, offline-capable
 * app feel rather than a browser tab.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kairosa — Transport Management",
    short_name: "Kairosa",
    description:
      "Fleet, drivers, customers and consignment notes with live tracking — works offline.",
    start_url: "/",
    display: "standalone",
    background_color: "#16181a",
    theme_color: "#16181a",
    icons: [
      { src: "/brand/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/brand/logo-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
