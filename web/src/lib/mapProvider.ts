/**
 * Tile provider config — the single place the map vendor is named.
 *
 * Swapping providers (or moving to Google later) is a change here plus one
 * env var, not a rewrite. See docs/MAPPING_STACK.md.
 */

export type MapProvider = "maptiler" | "ola" | "custom";

const PROVIDER = (process.env.NEXT_PUBLIC_MAP_PROVIDER ??
  "maptiler") as MapProvider;

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";
const OLA_KEY = process.env.NEXT_PUBLIC_OLA_MAPS_API_KEY ?? "";

/**
 * `region=IN` asks the provider for the India-appropriate depiction of
 * borders. See the compliance note in docs/MAPPING_STACK.md before shipping
 * this publicly in India.
 */
export function styleUrl(
  theme: "light" | "dark",
  variant: "dataviz" | "detailed" = "dataviz",
): string {
  switch (PROVIDER) {
    case "ola":
      return `https://api.olamaps.io/tiles/vector/v1/styles/default-${theme}-standard/style.json?api_key=${OLA_KEY}`;
    case "custom":
      return process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "";
    case "maptiler":
    default: {
      // Two deliberately different maps for two different jobs:
      //   * "dataviz" — low-contrast, label-sparse, so a vehicle marker is the
      //     most salient thing on the live fleet map.
      //   * "detailed" — the full streets map with building footprints, POI
      //     labels and landmark names. This is what you need when *picking* an
      //     address: an Indian address is found by landmark ("behind Sayaji
      //     Township"), so the operator has to be able to see those landmarks
      //     to drop the pin on the right building.
      const style =
        variant === "detailed"
          ? "streets-v2"
          : theme === "dark"
            ? "dataviz-dark"
            : "dataviz-light";
      return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}&language=en&region=IN`;
    }
  }
}

export function isMapConfigured(): boolean {
  if (PROVIDER === "maptiler") return MAPTILER_KEY.length > 0;
  if (PROVIDER === "ola") return OLA_KEY.length > 0;
  return (process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "").length > 0;
}

export const mapProviderName = PROVIDER;

/** Centre of India — a sensible default before any device reports in. */
export const DEFAULT_CENTER: [number, number] = [78.9629, 22.5937];
export const DEFAULT_ZOOM = 4.2;
