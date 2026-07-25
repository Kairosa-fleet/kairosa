# Design System

**Structure from Bear (bear.app). Colour deliberately not.**

Extracted from Bear's live stylesheet (`bear.app/screen.css`), then **adapted** — not cloned — for a fleet-tracking dashboard.

---

## 1. What Bear actually uses

Real values pulled from their CSS custom properties, not guessed:

```css
--accent-color:               #DD4C4F   /* signature red */
--background-color:           #fff
--background-secondary-color: #F3F5F7
--background-tertiary-color:  #E4E5E6
--stroke-color:               #D9D9D9
--text-color:                 #444444
--text-secondary-color:       #888888
--text-tertiary-color:        #d9d9d9
--text-font:                  "bearsans"          /* proprietary */
--heading-font:               "bearsansheadline"  /* proprietary */
--code-font:                  "roboto-mono"
```

Other observed traits:
- **Headings run tight** — `line-height: 1.1em`, `h1: 2.6em`. This is the single most characteristic thing about their type.
- **Radii are relative, in ems** — `0.5em` general, `1em` cards, `2.5em` pill buttons. They scale with type size rather than being fixed pixels.
- Base `font-size: 16px`, single-column, generous whitespace, subtle shadows.
- **Light mode only** — their marketing site has no dark theme.

## 2. What we keep, and what we deliberately change

### Kept
Bear's restraint: near-white surfaces, one accent used sparingly, soft grey strokes instead of hard borders, tight heading leading, em-based radii, and a lot of breathing room. That discipline is what makes it feel calm, and it transfers well to a dashboard.

Their neutral ramp is kept **verbatim** (`#444444`, `#888888`, `#F3F5F7`, `#E4E5E6`, `#D9D9D9`) — it's well-balanced and warm without being beige.

### Changed — and why

**1. The accent is indigo → violet, not Bear's red.**

Two reasons, and the second is the one that matters.

*Psychologically*, indigo–violet reads energetic, creative and optimistic — it's the register of modern product software rather than enterprise fleet management. That's the "good vibes" brief.

*Functionally*, in a tracking product **red already means something**: offline, spoofing detected, trust critical. If the brand colour and the alarm colour are the same, an operator scanning twenty vehicles cannot tell "our button" from "this truck is in trouble" at a glance. Indigo collides with nothing, so red / amber / green stay free to carry status alone.

Warm coral (`#FB923C`) appears in illustrations and washes for warmth, but **never** on a status indicator.

**2. Dark mode added.** Bear's site doesn't have one; a dashboard watched at night by dispatch does.

**3. Open-source fonts.** `bearsans` is proprietary. Substitutes match the *feel* — geometric, slightly rounded, high x-height:

| Role | Bear | Ours | Licence |
|---|---|---|---|
| Headings | bearsansheadline | **Plus Jakarta Sans** | SIL OFL 1.1 |
| Body / UI | bearsans | **Inter** | SIL OFL 1.1 |
| Data / coords | roboto-mono | **JetBrains Mono** | SIL OFL 1.1 |

All three are downloaded to `web/public/fonts/` as complete Latin variable woff2 and loaded with `next/font/local` — **no runtime requests to Google or any CDN**.

**4. Polish borrowed from Bear's stylesheet**, not invented:
- **Brand-tinted shadows.** Bear uses `rgba(34,113,140,.3)` on primary elements rather than neutral black. Ours are indigo-tinted, which makes elevation feel part of the palette instead of a grey haze.
- **Uniform `0.2s ease-in-out` motion** — restrained, never bouncy.
- **Gradient primary fill** (indigo → violet). A flat block of indigo reads heavier than the same colour with a slight violet lift.
- **Radial brand wash** behind large empty areas, so blank space feels intentional.

## 3. Tokens

```css
/* Light */
--bg:        #FFFFFF    --ink:    #3A3A46
--surface:   #F7F7FB    --ink-2:  #77778A     /* faint indigo tint, not grey */
--surface-2: #EDEDF6    --ink-3:  #ADADBF
--stroke:    #E3E3EE

--accent:      #6366F1  /* indigo — text, icons, links   */
--accent-2:    #8B5CF6  /* violet — gradient end          */
--accent-fill: #5B5CE0  /* gradient start on filled areas */
--warm:        #FB923C  /* decorative warmth only         */

--success: #0F9D76   --warning: #D98200   --danger: #E5484D

/* Dark */
--bg: #141419   --surface: #1C1C24   --surface-2: #26262F   --stroke: #33333F
--ink: #EDEDF2  --ink-2: #A0A0B2     --ink-3: #6E6E82
--accent: #818CF8    /* lightened for legibility on dark */
--accent-fill: #5B5CE0  /* NOT lightened — see below      */
--success: #34D399   --warning: #FBBF24   --danger: #F87171
```

**Why `--accent` and `--accent-fill` are separate tokens.** On dark backgrounds the text accent must be lightened to stay readable — but a lightened *fill* drops white button text to ~2.8:1, well under AA. Fills therefore stay saturated in both themes. Measured white-on-gradient:

| | Contrast | |
|---|---|---|
| `#5B5CE0` (gradient start) | **5.18:1** | ✅ AA |
| `#7C4FE8` (gradient end) | **5.07:1** | ✅ AA |

The first attempt used `#6366F1`/`#8B5CF6` as fills and measured 4.47:1 and 4.23:1 — marginally *under* the 4.5 threshold for normal text. Deepening the pair fixed it in both themes at once.

**Radii** (em-based, following Bear): `0.3rem` chips · `0.5rem` controls · `1rem` cards · `2.5rem` pills.

**Type scale**: `h1 2.6rem/1.1` · `h2 2rem/1.1` · `h3 1.4rem/1.2` · body `1rem/1.6`.

## 4. Semantic colour — the rule that matters

Because this is a safety-adjacent product, colour carries meaning and must stay consistent:

| Colour | Meaning | Used for |
|---|---|---|
| **Indigo/violet** `--accent` | Brand / interactive | Buttons, links, active nav |
| **Green** `--success` | Healthy | Online, trust ≥ 70, charging |
| **Amber** `--warning` | Needs attention | Trust 40–69, low battery, stale > 5 min |
| **Red** `--danger` | Critical | Offline, trust < 40, spoofing detected, revoked |
| **Grey** | Inactive | Off duty, never provisioned |

Never use red decoratively. Never use the accent to signal state.

**Accessibility:** state is never communicated by colour alone — every status carries an icon and a text label, so it survives colour-blindness and greyscale printing.

## 5. Assets — all open source, all local

Downloaded into the repo; nothing is fetched at runtime and nothing is AI-generated.

| Asset | Source | Licence | Location |
|---|---|---|---|
| Inter, Plus Jakarta Sans, JetBrains Mono | Fontsource | SIL OFL 1.1 | `web/public/fonts/` |
| Icons (`lucide-react`) | Lucide | ISC | npm |
| 6 illustrations | unDraw (MIT mirror) | MIT | `web/public/illustrations/` |
| Logo mark + favicon | Hand-authored SVG | Ours | `web/public/brand/` |

**Illustrations were recoloured** into the palette across three passes (~110 substitutions each time — stock purple → teal → final indigo/violet), so the art sits inside the design system instead of fighting it.

**The logo is hand-written SVG geometry** — a location pin whose void forms the vehicle, flanked by two arcs that read as both a route and a signal wave. It uses `currentColor`, so it inherits the theme.

## 6. Layout

```
┌──────────────────────────────────────────────┐
│ Top bar — mark, org, connection status, user │  56px
├────────────┬─────────────────────────────────┤
│ Sidebar    │  Map (persistent, never remounts)│
│ 280px      │                                  │
│ vehicle    │  ┌────────────────────────────┐ │
│ list with  │  │ selected vehicle detail    │ │
│ status     │  └────────────────────────────┘ │
└────────────┴─────────────────────────────────┘
```

The map is mounted **once** and never unmounted on navigation — good practice generally, and it was a hard billing requirement back when this was Google Maps. It no longer costs money with MapTiler, but remounting a map is still visibly janky, so the discipline stays.

Below 768px the sidebar becomes a bottom sheet over a full-bleed map.


---

## 7. Verified in a real browser

Captured from the production build with Playwright — `docs/screenshots/`:

| Shot | Covers |
|---|---|
| `1-login-{light,dark}` | Split login, illustration panel, theme toggle |
| `2-fleet-{light,dark}` | Live map, status-sorted sidebar, connection state |
| `3-detail-{light,dark}` | Telemetry grid, integrity meter, flag explanations |
| `4-devices-{light,dark}` | Enrolment, trust scores, revoke |
| `5-drivers-{light,dark}` | Driver records |
| `6-mobile` | 390×844 — map with bottom-sheet vehicle list |

**Zero browser console errors** across every route in both themes.

### Bugs the screenshots caught

Each of these was invisible to typecheck, lint and the build:

1. **Headings ignored their size utilities.** Base element styles sat *outside*
   `@layer`, and unlayered CSS beats every layer — so `<h2 className="text-base">`
   still rendered at `2rem`. Fixed by moving base styles into `@layer base`.
2. **The logo rendered black instead of teal.** An external `<img src="…svg">`
   cannot inherit `currentColor`. Fixed by inlining the mark as a component.
3. **Hydration mismatch (React #418).** `isAuthenticated()` reads `localStorage`,
   so the server rendered one tree and the client hydrated a different one. Fixed
   with `useHydrated()`, which uses `useSyncExternalStore` to keep the first client
   render identical to the server's.
4. **CORS blocked every request.** `127.0.0.1:3000` and `localhost:3000` are
   different origins to a browser. Both are now allowed in dev, and the client's
   error message names CORS as a possible cause instead of blaming the server.
5. **Mobile header wrapped and clipped the sign-out button.** The wordmark now
   drops below `lg`, leaving the mark alone.
6. **Illustrations still carried stock purple** after the first recolour pass —
   a second pass caught the clothing tones the first mapping missed.
