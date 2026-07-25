# Google Maps API Keys — Step by Step

You need **3 API keys + 1 Map ID**. Budget ~20 minutes. Everything here happens at <https://console.cloud.google.com>.

Why three keys and not one: a key can only carry *one* application restriction. A web key is locked to your domain, an Android key to your app's signing certificate, an iOS key to your bundle ID. One shared key would have to be unrestricted to work everywhere — and an unrestricted key sitting in your JavaScript bundle is the single most common cause of surprise Google Cloud bills. People scrape these automatically.

---

## Step 1 — Create the project

1. Go to <https://console.cloud.google.com>, sign in with your Google account.
2. Top bar, click the project dropdown (left of the search box) → **New Project**.
3. Name: `fleet-tracking`. Leave organisation as-is. → **Create**.
4. Wait ~10 s, then make sure the project dropdown now shows `fleet-tracking`. **Everything below must happen inside this project** — the most common mistake is creating keys in the wrong project.

## Step 2 — Enable billing (required, but you will not be charged)

Google requires a card on file even for free-tier usage. Maps SDK for Android and iOS are **unlimited free**, and the JavaScript API gives you ~10,000 free map loads/month — far more than you'll use in development.

1. Left menu (☰) → **Billing**.
2. **Link a billing account** → create one if you don't have one. Indian cards need the standard RBI verification; a ₹0–₹2 authorisation charge may appear and is reversed.
3. **Do this immediately after** — Billing → **Budgets & alerts** → **Create budget**:
   - Name: `maps-guard`
   - Budget type: **Specified amount** → **₹100**
   - Alert thresholds: **50%, 90%, 100%**
   - Tick **Email alerts to billing admins**
   - → Save

   This does not cap spending (Google has no hard cap), it emails you. ₹100 rather than ₹0 because a ₹0 budget fires alerts constantly on rounding noise.

## Step 3 — Enable exactly three APIs

Left menu → **APIs & Services** → **Library**. Search for and **Enable** each:

- ✅ **Maps SDK for Android**
- ✅ **Maps SDK for iOS**
- ✅ **Maps JavaScript API**

**Enable nothing else.** Specifically do *not* enable Directions, Roads, Places, Geocoding, or Distance Matrix — those bill per request, have no meaningful free tier for your volume, and our design never calls them.

## Step 4 — Create the three keys

For each key: **APIs & Services** → **Credentials** → **+ Create Credentials** → **API key** → copy the value → **Edit API key** (pencil icon) → apply restrictions below → **Save**.

Restrictions can take up to 5 minutes to take effect.

### 4a. Web key
- **Name:** `web-maps-key`
- **Application restrictions:** → **Websites**
  - Add: `http://localhost:3000/*`
  - Add your production domain later: `https://yourdomain.com/*`
- **API restrictions:** → **Restrict key** → tick **Maps JavaScript API** only

→ goes in `.env` as `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`

### 4b. Android key
- **Name:** `android-maps-key`
- **Application restrictions:** → **Android apps** → **Add**
  - Package name: `com.fleettracking.app` (must match the app's `applicationId` — I'll use exactly this)
  - SHA-1 certificate fingerprint: run this and paste the `SHA1:` line —
    ```bash
    keytool -list -v -keystore ~/.android/debug.keystore \
      -alias androiddebugkey -storepass android -keypass android | grep SHA1
    ```
    (Tell me if the file doesn't exist yet — it's created on your first Android build, and I'll generate it during setup.)
  - You will add a **second** entry with your *release* keystore's SHA-1 before publishing. Debug and release certificates differ, and forgetting this is why maps show a blank grey grid in production builds.
- **API restrictions:** → **Maps SDK for Android** only

→ `.env` as `ANDROID_MAPS_API_KEY`

### 4c. iOS key
- **Name:** `ios-maps-key`
- **Application restrictions:** → **iOS apps** → Bundle ID: `com.fleettracking.app`
- **API restrictions:** → **Maps SDK for iOS** only

→ `.env` as `IOS_MAPS_API_KEY`

## Step 5 — Create a Map ID (web only)

Needed for `AdvancedMarkerElement` (the classic `Marker` is deprecated), and it lets you restyle the map from the console without redeploying.

1. Left menu → **Google Maps Platform** → **Map Management**
   (direct link: <https://console.cloud.google.com/google/maps-apis/studio/maps>)
2. **Create Map ID**
   - Name: `fleet-web`
   - Map type: **JavaScript**
   - Rendering: **Vector** (tick *Tilt* and *Rotation* — useful for the bearing arrow on moving vehicles)
3. Copy the generated ID (looks like `a1b2c3d4e5f6g7h8`).

→ `.env` as `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`

## Step 6 — Put them in `.env`

```bash
cd /home/reward_hack/Desktop/application
cp .env.example .env
```

Then fill in the four values. `.env` is already gitignored — verify with `git status` that it never appears.

---

## Indian map borders

Google serves Survey of India-compliant borders when the request declares Indian region/locale. Our web loader will set `region: 'IN'` and `language: 'en'`; the mobile SDKs pick this up from device locale automatically. No extra configuration or cost.

## Quick self-check

- [ ] Exactly 3 APIs enabled (Library → filter "Enabled")
- [ ] All 3 keys show a restriction — none says "None" under Application restrictions
- [ ] Budget alert exists
- [ ] Map ID created, type JavaScript, Vector
- [ ] `.env` filled, `git status` does not list it

## If the map renders grey

Almost always one of: restrictions still propagating (wait 5 min) · wrong project · SHA-1 mismatch (debug vs release) · billing not enabled. Open the browser console — the JS API prints the exact reason (`RefererNotAllowedMapError`, `ApiNotActivatedMapError`, `BillingNotEnabledMapError`).
