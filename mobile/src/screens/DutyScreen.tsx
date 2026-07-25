import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Badge, Button, Card, ELEVATION, Notice, SectionLabel, StatTile } from "../components/ui";
import { api } from "../lib/api";
import { COLORS } from "../lib/config";
import { getCurrentPosition } from "../lib/locationService";
import type { DeviceInfo } from "../lib/types";
import type { useTracking } from "../lib/useTracking";

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)}h`;
}

function initials(name: string): string {
  const parts = name.replace(/—.*/, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "");
}

/**
 * The driver's main screen: one switch, and honest status.
 *
 * Deliberately not a map-first design. The driver does not need to watch
 * themselves move — they need to know tracking is working and that their
 * queued fixes are getting through.
 *
 * The duty control is the hero and everything else is secondary, because in a
 * cab this screen is read in a glance at arm's length: whether tracking is on
 * has to be answerable from the colour of the top card alone.
 */
export function DutyScreen({
  tracking,
}: {
  tracking: ReturnType<typeof useTracking>;
}) {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [fix, setFix] = useState<{ lat: number; lon: number; acc: number | null } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.me();
        if (!cancelled) setDevice(info);
      } catch {
        /* offline — the cached view is still useful */
      }
      const position = await getCurrentPosition();
      if (position && !cancelled) {
        setFix({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          acc: position.coords.accuracy ?? null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tracking.onDuty]);

  const onDuty = tracking.onDuty;
  const healthy = onDuty && tracking.serviceRunning;
  const brokenService = onDuty && !tracking.serviceRunning;

  const name = device?.label ?? "This device";
  const driverName = name.split("—")[0].trim();
  const handset = name.includes("—") ? name.split("—")[1].trim() : null;

  const trust = device ? Math.round(device.trustScore) : null;

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.surface }}
      contentContainerStyle={{ padding: 18, gap: 16, paddingTop: 26, paddingBottom: 32 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await tracking.refresh();
            setRefreshing(false);
          }}
        />
      }
    >
      {/* Identity. An avatar rather than a bare string, so the driver can
          confirm at a glance that they are signed in as themselves — this is
          a handset that changes hands between shifts. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}>
        <View style={styles_avatar}>
          <Text style={{ color: COLORS.white, fontSize: 17, fontWeight: "800" }}>
            {initials(driverName).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 20, fontWeight: "800", color: COLORS.ink, letterSpacing: -0.4 }}
          >
            {driverName}
          </Text>
          {handset ? (
            <Text style={{ fontSize: 13, color: COLORS.ink3, marginTop: 1 }}>
              {handset}
            </Text>
          ) : null}
        </View>
      </View>

      {/* The hero. Its colour is the answer to "am I being tracked?". */}
      <View
        style={[
          {
            borderRadius: 24,
            padding: 20,
            gap: 16,
            backgroundColor: healthy ? COLORS.success : COLORS.bg,
          },
          ELEVATION.card,
        ]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              letterSpacing: 0.8,
              textTransform: "uppercase",
              color: healthy ? "rgba(255,255,255,0.85)" : COLORS.ink3,
            }}
          >
            Duty status
          </Text>
          {healthy ? (
            <View style={styles_livePill}>
              <View style={styles_liveDot} />
              <Text style={{ color: COLORS.white, fontSize: 12.5, fontWeight: "700" }}>
                Live
              </Text>
            </View>
          ) : (
            <Badge
              tone={brokenService ? "critical" : "idle"}
              label={brokenService ? "Service stopped" : "Not tracking"}
            />
          )}
        </View>

        <Text
          style={{
            fontSize: 27,
            fontWeight: "800",
            letterSpacing: -0.8,
            lineHeight: 31,
            color: healthy ? COLORS.white : COLORS.ink,
          }}
        >
          {healthy
            ? "You are on duty"
            : brokenService
              ? "Tracking has stopped"
              : "You are off duty"}
        </Text>

        {onDuty ? (
          <Button
            title="Go off duty"
            variant="secondary"
            size="lg"
            onPress={tracking.goOffDuty}
            loading={tracking.busy}
          />
        ) : (
          <Button
            title="Go on duty"
            size="lg"
            onPress={tracking.goOnDuty}
            loading={tracking.busy}
          />
        )}

        <Text
          style={{
            fontSize: 12.5,
            lineHeight: 18,
            color: healthy ? "rgba(255,255,255,0.8)" : COLORS.ink3,
          }}
        >
          Location is only recorded while you are on duty. Going off duty stops
          it completely.
        </Text>
      </View>

      {brokenService ? (
        <Notice tone="critical">
          You are marked on duty but the tracking service is not running — your
          phone probably shut it down. Tap “Go on duty” again, and check the
          battery settings under Status.
        </Notice>
      ) : null}

      {tracking.lastError ? (
        <Notice tone="critical">{tracking.lastError}</Notice>
      ) : null}

      {/* Queue health — the honest bit. A driver in a dead zone should be able
          to see that nothing has been lost, only delayed. */}
      <SectionLabel>Sync</SectionLabel>
      <Card>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <StatTile
            label="Waiting to send"
            value={tracking.pending === 0 ? "0" : String(tracking.pending)}
            caption={tracking.pending === 1 ? "fix" : "fixes"}
            tone={tracking.pending > 200 ? "warn" : undefined}
          />
          <StatTile label="Last upload" value={ago(tracking.lastSyncAt)} caption="ago" />
        </View>
        <Button
          title="Sync now"
          variant="secondary"
          onPress={() => void tracking.syncNow()}
          loading={tracking.busy}
        />
        {tracking.pending > 0 ? (
          <Text style={{ color: COLORS.ink3, fontSize: 12.5, lineHeight: 18 }}>
            Queued fixes are stored on this phone and sent when you have signal.
            Nothing is lost in a tunnel or a dead zone.
          </Text>
        ) : null}
      </Card>

      <SectionLabel>This device</SectionLabel>
      <Card>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <StatTile
            label="Location integrity"
            value={trust === null ? "—" : `${trust}`}
            caption="out of 100"
            tone={
              trust === null ? undefined : trust < 40 ? "critical" : trust < 70 ? "warn" : "ok"
            }
          />
          <StatTile
            label="Accuracy"
            value={fix?.acc ? `${Math.round(fix.acc)}` : "—"}
            caption="metres"
          />
        </View>

        {fix ? (
          <View style={{ gap: 3 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: COLORS.ink2 }}>
              Last known position
            </Text>
            <Text
              style={{
                fontFamily: "monospace",
                fontSize: 13.5,
                color: COLORS.ink,
              }}
            >
              {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}
            </Text>
          </View>
        ) : (
          <Text style={{ color: COLORS.ink2, fontSize: 13.5, lineHeight: 20 }}>
            No fix yet — this can take a moment outdoors, longer indoors.
          </Text>
        )}
      </Card>
    </ScrollView>
  );
}

const styles_avatar = {
  width: 46,
  height: 46,
  borderRadius: 23,
  backgroundColor: COLORS.accentFill,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

const styles_livePill = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
  paddingHorizontal: 11,
  paddingVertical: 6,
  borderRadius: 999,
  backgroundColor: "rgba(255,255,255,0.22)",
};

const styles_liveDot = {
  width: 7,
  height: 7,
  borderRadius: 4,
  backgroundColor: COLORS.white,
};
