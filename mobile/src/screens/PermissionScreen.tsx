import * as Device from "expo-device";
import { useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";

import { Button, Card, Notice } from "../components/ui";
import { COLORS } from "../lib/config";
import {
  needsOemWhitelisting,
  oemInstructions,
  openSettings,
  requestBackground,
  requestForeground,
  type PermissionStatus,
} from "../lib/locationService";

/**
 * The permission ladder.
 *
 * Order is load-bearing. Android 11+ removes "Allow all the time" from the
 * first system dialog entirely, so background must be a separate, later
 * request — and asking cold, without the plain-language explanation first,
 * roughly halves grant rates. Google Play also *requires* this prominent
 * disclosure for background location; the app is rejected without it.
 *
 * See docs/BACKGROUND_TRACKING.md.
 */
export function PermissionScreen({
  status,
  onDone,
}: {
  status: PermissionStatus;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const manufacturer = Device.manufacturer ?? null;
  const showOem = needsOemWhitelisting(manufacturer);

  async function askForeground() {
    setBusy(true);
    await requestForeground();
    setBusy(false);
    onDone();
  }

  async function askBackground() {
    setBusy(true);
    await requestBackground();
    setBusy(false);
    onDone();
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingTop: 60 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 26, fontWeight: "700", color: COLORS.ink }}>
          Location access
        </Text>
        <Text style={{ fontSize: 15, color: COLORS.ink2, lineHeight: 22 }}>
          Dispatch needs your position while you are on duty so they can route
          jobs to you and know you are safe.
        </Text>
      </View>

      <Card>
        <Text style={{ fontWeight: "600", color: COLORS.ink, fontSize: 16 }}>
          What we collect
        </Text>
        <Text style={{ color: COLORS.ink2, fontSize: 14, lineHeight: 21 }}>
          • Your location, speed and heading{"\n"}• Battery level and network
          type, so dispatch knows if your phone is about to die{"\n"}
          {"\n"}
          <Text style={{ color: COLORS.ink, fontWeight: "600" }}>
            Only while you are on duty.
          </Text>{" "}
          When you go off duty, tracking stops completely and nothing is
          recorded until your next shift.
        </Text>
      </Card>

      {/* Step 1 */}
      <Card>
        <Text style={{ fontWeight: "600", color: COLORS.ink }}>
          Step 1 — Allow location
        </Text>
        {status.foregroundGranted ? (
          <Notice tone="ok">Granted</Notice>
        ) : (
          <>
            <Text style={{ color: COLORS.ink2, fontSize: 14 }}>
              Choose “While using the app” when asked.
            </Text>
            <Button
              title="Allow location"
              onPress={askForeground}
              loading={busy}
            />
          </>
        )}
      </Card>

      {/* Step 2 — only offered once step 1 is granted; the OS ignores it otherwise. */}
      {status.foregroundGranted ? (
        <Card>
          <Text style={{ fontWeight: "600", color: COLORS.ink }}>
            Step 2 — Allow all the time
          </Text>
          {status.backgroundGranted ? (
            <Notice tone="ok">Granted</Notice>
          ) : (
            <>
              <Text style={{ color: COLORS.ink2, fontSize: 14, lineHeight: 21 }}>
                Your phone will open Settings. Choose{" "}
                <Text style={{ fontWeight: "600", color: COLORS.ink }}>
                  “Allow all the time”
                </Text>
                . Without it, tracking stops the moment your screen locks.
              </Text>
              <Button
                title="Open location settings"
                onPress={askBackground}
                loading={busy}
              />
            </>
          )}
        </Card>
      ) : null}

      {!status.servicesEnabled ? (
        <Notice tone="critical">
          Location services (GPS) are switched off on this phone. Turn them on
          in Settings, or nothing can be tracked.
        </Notice>
      ) : null}

      {status.stage === "blocked" ? (
        <Card>
          <Notice tone="critical">
            Location permission was permanently denied. It has to be re-enabled
            in system settings.
          </Notice>
          <Button
            title="Open app settings"
            variant="secondary"
            onPress={openSettings}
          />
        </Card>
      ) : null}

      {/* Step 3 — the one that cannot be automated. */}
      {showOem && status.backgroundGranted ? (
        <Card>
          <Text style={{ fontWeight: "600", color: COLORS.ink }}>
            Step 3 — Stop {manufacturer} from killing the app
          </Text>
          <Text style={{ color: COLORS.ink2, fontSize: 14, lineHeight: 21 }}>
            {manufacturer} phones shut down background apps aggressively to save
            battery. These switches cannot be changed by the app — you have to
            set them yourself, once:
          </Text>
          {oemInstructions(manufacturer).map((line, i) => (
            <Text
              key={i}
              style={{ color: COLORS.ink, fontSize: 14, lineHeight: 21 }}
            >
              {i + 1}. {line}
            </Text>
          ))}
          <Button
            title="Open settings"
            variant="secondary"
            onPress={() => Linking.openSettings().catch(() => {})}
          />
          <Text style={{ color: COLORS.ink3, fontSize: 12, lineHeight: 18 }}>
            We also check this automatically: if the app gets killed while you
            are on duty, it is recorded and dispatch is alerted.
          </Text>
        </Card>
      ) : null}

      {status.backgroundGranted ? (
        <Button title="Continue" onPress={onDone} />
      ) : null}
    </ScrollView>
  );
}
