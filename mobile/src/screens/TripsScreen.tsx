import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";

import { Badge, Button, Card, Notice, Row, Title } from "../components/ui";
import { api } from "../lib/api";
import { COLORS } from "../lib/config";
import type { DriverTrip } from "../lib/types";

const STATUS_TONE: Record<string, "ok" | "warn" | "critical" | "idle"> = {
  planned: "idle",
  assigned: "warn",
  started: "ok",
  in_transit: "ok",
  at_destination: "ok",
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The driver's schedule.
 *
 * Deliberately does NOT show freight amounts or what the customer is paying —
 * the driver needs the route, the goods, the e-way bill number a checkpoint
 * will ask for, and who to call at each end.
 */
export function TripsScreen() {
  const [trips, setTrips] = useState<DriverTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrips(await api.myTrips());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load trips");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openMaps(lat: number, lon: number, label: string) {
    // Hand off to whatever navigation app the driver already uses rather than
    // building turn-by-turn — they will use Google Maps regardless.
    const url = `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`),
    );
  }

  function call(phone: string | null) {
    if (!phone) {
      Alert.alert("No number", "No contact number was provided for this stop.");
      return;
    }
    Linking.openURL(`tel:${phone}`).catch(() => {});
  }

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.surface }}
      contentContainerStyle={{ padding: 18, gap: 16, paddingTop: 26, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      <Title sub={trips.length > 0 ? `${trips.length} scheduled` : undefined}>
        My trips
      </Title>

      {error ? <Notice tone="critical">{error}</Notice> : null}

      {!loading && trips.length === 0 ? (
        <Card>
          <Text style={{ fontSize: 16, fontWeight: "700", color: COLORS.ink }}>
            No trips assigned
          </Text>
          <Text style={{ color: COLORS.ink2, fontSize: 14, lineHeight: 21 }}>
            When dispatch schedules a consignment to you it will appear here,
            with the route and both contacts.
          </Text>
        </Card>
      ) : null}

      {trips.map((trip) => (
        <Card key={trip.id} style={{ gap: 14 }}>
          {/* header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ flex: 1, gap: 5 }}>
              <Text
                style={{ fontSize: 21, fontWeight: "800", color: COLORS.ink, letterSpacing: -0.5 }}
              >
                {dayLabel(trip.scheduledStart)} · {timeLabel(trip.scheduledStart)}
              </Text>
              <Text
                style={{
                  fontFamily: "monospace",
                  fontSize: 12.5,
                  color: COLORS.ink3,
                }}
              >
                {trip.lrNumber}
              </Text>
            </View>
            <Badge
              tone={STATUS_TONE[trip.status] ?? "idle"}
              label={trip.status.replace(/_/g, " ")}
            />
          </View>

          {/* At-a-glance chips: the two numbers a driver wants before reading
              anything else — how far, and how long. */}
          {trip.route.distanceKm || trip.weightKg ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
              {trip.route.distanceKm ? <Chip text={`${trip.route.distanceKm} km`} /> : null}
              {trip.route.durationH ? <Chip text={`${trip.route.durationH} h drive`} /> : null}
              {trip.weightKg ? <Chip text={`${(trip.weightKg / 1000).toFixed(1)} T`} /> : null}
              {trip.isHazardous ? <Chip text="Hazardous" tone="critical" /> : null}
              {trip.isFragile ? <Chip text="Fragile" tone="warn" /> : null}
            </View>
          ) : null}

          {/* route */}
          <View
            style={{
              flexDirection: "row",
              gap: 12,
              borderTopWidth: 1,
              borderTopColor: COLORS.stroke,
              paddingTop: 12,
            }}
          >
            <View style={{ alignItems: "center", paddingTop: 4 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.success }} />
              <View style={{ width: 1, flex: 1, minHeight: 34, backgroundColor: COLORS.stroke, marginVertical: 4 }} />
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.danger }} />
            </View>

            <View style={{ flex: 1, gap: 14 }}>
              <Stop
                kind="Pickup"
                name={trip.pickup.name}
                address={trip.pickup.address}
                city={trip.pickup.city}
                onNavigate={() =>
                  openMaps(trip.pickup.latitude, trip.pickup.longitude, trip.pickup.name)
                }
                onCall={() => call(trip.pickup.contact)}
              />
              <Stop
                kind="Delivery"
                name={trip.drop.name}
                address={trip.drop.address}
                city={trip.drop.city}
                onNavigate={() =>
                  openMaps(trip.drop.latitude, trip.drop.longitude, trip.drop.name)
                }
                onCall={() => call(trip.drop.contact)}
              />
            </View>
          </View>

          {/* suggested route */}
          {trip.route.distanceKm ? (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: COLORS.stroke,
                paddingTop: 12,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: COLORS.ink, marginBottom: 6 }}>
                Suggested route
              </Text>
              <Row label={trip.route.summary ?? "Fastest"} value={`${trip.route.distanceKm} km`} />
              {trip.route.durationH ? (
                <Row label="Estimated driving time" value={`${trip.route.durationH} h`} />
              ) : null}
              {trip.route.alternatives.length > 1 ? (
                <Text style={{ fontSize: 12, color: COLORS.ink2, marginTop: 4 }}>
                  {trip.route.alternatives.length} options were considered by dispatch.
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* load */}
          <View style={{ borderTopWidth: 1, borderTopColor: COLORS.stroke, paddingTop: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: COLORS.ink, marginBottom: 6 }}>
              Load
            </Text>
            <Row label="Goods" value={trip.goods} />
            {trip.packages ? <Row label="Packages" value={String(trip.packages)} /> : null}
            {trip.weightKg ? <Row label="Weight" value={`${(trip.weightKg / 1000).toFixed(1)} T`} /> : null}
            {trip.vehicle ? <Row label="Vehicle" value={trip.vehicle} mono /> : null}
          </View>

          {/* papers — what a checkpoint asks for */}
          {trip.ewayBillNumber || trip.invoiceNumber ? (
            <View style={{ borderTopWidth: 1, borderTopColor: COLORS.stroke, paddingTop: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: COLORS.ink, marginBottom: 6 }}>
                Papers to carry
              </Text>
              {trip.ewayBillNumber ? (
                <Row label="E-way bill" value={trip.ewayBillNumber} mono />
              ) : null}
              {trip.ewayBillValidUntil ? (
                <Row
                  label="Valid until"
                  value={new Date(trip.ewayBillValidUntil).toLocaleString(undefined, {
                    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                  })}
                  tone={
                    new Date(trip.ewayBillValidUntil).getTime() < Date.now()
                      ? "critical"
                      : undefined
                  }
                />
              ) : null}
              {trip.invoiceNumber ? <Row label="Invoice" value={trip.invoiceNumber} mono /> : null}
            </View>
          ) : null}

          {trip.instructions || trip.notes ? (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: COLORS.stroke,
                paddingTop: 12,
                gap: 4,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: COLORS.ink }}>
                Instructions
              </Text>
              <Text style={{ fontSize: 13, color: COLORS.ink2, lineHeight: 20 }}>
                {[trip.instructions, trip.notes].filter(Boolean).join("\n")}
              </Text>
            </View>
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}

/** A compact fact, sized to be read without stopping the truck. */
function Chip({ text, tone }: { text: string; tone?: "critical" | "warn" }) {
  const fg = tone === "critical" ? COLORS.danger : tone === "warn" ? COLORS.warning : COLORS.ink2;
  const bg =
    tone === "critical" ? COLORS.dangerSoft : tone === "warn" ? COLORS.warningSoft : COLORS.surface2;
  return (
    <View
      style={{
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "700", color: fg }}>{text}</Text>
    </View>
  );
}

function Stop({
  kind, name, address, city, onNavigate, onCall,
}: {
  kind: string;
  name: string;
  address: string;
  city: string | null;
  onNavigate: () => void;
  onCall: () => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 11, color: COLORS.ink2, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {kind}
      </Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color: COLORS.ink }}>{name}</Text>
      <Text style={{ fontSize: 13, color: COLORS.ink2, lineHeight: 19 }}>
        {city ? `${city} — ` : ""}
        {address}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
        <View style={{ flex: 1 }}>
          <Button title="Navigate" variant="secondary" onPress={onNavigate} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Call" variant="secondary" onPress={onCall} />
        </View>
      </View>
    </View>
  );
}
