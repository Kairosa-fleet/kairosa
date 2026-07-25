import * as Device from "expo-device";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, Share, Text, View } from "react-native";

import { Badge, Button, Card, Row, Title } from "../components/ui";
import { API_BASE_URL, COLORS } from "../lib/config";
import {
  clearDiagnostics,
  oldestPending,
  outboxDepth,
  recentEvents,
} from "../lib/db";
import { getPermissionStatus, isTracking } from "../lib/locationService";
import type { DiagnosticRow } from "../lib/types";

const KIND_TONE: Record<string, "ok" | "warn" | "critical" | "idle"> = {
  service_started: "ok",
  sync_ok: "ok",
  fix_recorded: "idle",
  app_launched: "idle",
  duty_changed: "idle",
  permission_changed: "idle",
  service_stopped: "warn",
  sync_failed: "warn",
  unexpected_restart: "critical",
};

function stamp(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/**
 * Field-testing evidence.
 *
 * The point of this screen: an 8-hour drive on a Redmi either produces a
 * timeline you can act on, or it produces "it felt like it dropped some".
 * Kill/restart events are the specific thing OEM battery managers cause, and
 * they are invisible without recording them.
 */
export function DiagnosticsScreen() {
  const [events, setEvents] = useState<DiagnosticRow[]>([]);
  const [pending, setPending] = useState(0);
  const [oldest, setOldest] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [perms, setPerms] = useState<string>("checking…");

  const load = useCallback(async () => {
    const [rows, depth, oldestTs, isRunning, permission] = await Promise.all([
      recentEvents(200),
      outboxDepth(),
      oldestPending(),
      isTracking(),
      getPermissionStatus(),
    ]);
    setEvents(rows);
    setPending(depth);
    setOldest(oldestTs);
    setRunning(isRunning);
    setPerms(
      `${permission.foregroundGranted ? "foreground ✓" : "foreground ✗"} · ${
        permission.backgroundGranted ? "background ✓" : "background ✗"
      } · ${permission.servicesEnabled ? "GPS on" : "GPS OFF"}`,
    );
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [load]);

  const killCount = events.filter((e) => e.kind === "unexpected_restart").length;

  async function exportLog() {
    const header = [
      `Kairosa diagnostics`,
      `Device: ${Device.manufacturer} ${Device.modelName} (Android ${Device.osVersion})`,
      `Service running: ${running}`,
      `Permissions: ${perms}`,
      `Queued fixes: ${pending}`,
      `Unexpected restarts: ${killCount}`,
      ``,
    ].join("\n");
    const body = events
      .map((e) => `${stamp(e.created_at)}  ${e.kind}${e.detail ? `  ${e.detail}` : ""}`)
      .join("\n");
    try {
      await Share.share({ message: header + body });
    } catch {
      /* user dismissed */
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.surface }}
      contentContainerStyle={{ padding: 18, gap: 16, paddingTop: 26, paddingBottom: 32 }}
    >
      <Title sub="What this phone has actually been doing">Status</Title>

      <Card>
        <Text style={{ fontWeight: "600", color: COLORS.ink, fontSize: 16 }}>
          Right now
        </Text>
        <Row
          label="Tracking service"
          value={running ? "running" : "stopped"}
          tone={running ? "ok" : "warn"}
        />
        <Row label="Permissions" value={perms} />
        <Row label="Queued fixes" value={String(pending)} />
        <Row
          label="Oldest queued"
          value={oldest ? stamp(oldest) : "—"}
        />
        <Row
          label="Unexpected restarts"
          value={String(killCount)}
          tone={killCount > 0 ? "critical" : "ok"}
        />
        <Row label="API" value={API_BASE_URL} mono />
        <Row
          label="Device"
          value={`${Device.manufacturer ?? "?"} ${Device.modelName ?? ""}`}
        />
      </Card>

      {killCount > 0 ? (
        <Card>
          <Text style={{ color: COLORS.danger, fontWeight: "600" }}>
            This phone killed the tracking service {killCount}×
          </Text>
          <Text style={{ color: COLORS.ink2, fontSize: 13, lineHeight: 20 }}>
            That is the OEM battery manager, not a crash. Autostart and
            unrestricted battery need to be enabled for this app — see the
            setup steps. Each restart is a gap in the driver&apos;s track.
          </Text>
        </Card>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button title="Export log" variant="secondary" onPress={exportLog} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="Clear"
            variant="ghost"
            onPress={() =>
              Alert.alert("Clear diagnostics?", "The event history is deleted.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Clear",
                  style: "destructive",
                  onPress: async () => {
                    await clearDiagnostics();
                    await load();
                  },
                },
              ])
            }
          />
        </View>
      </View>

      <Card>
        <Text style={{ fontWeight: "600", color: COLORS.ink, fontSize: 16 }}>
          Event log
        </Text>
        {events.length === 0 ? (
          <Text style={{ color: COLORS.ink2, fontSize: 14 }}>
            Nothing recorded yet.
          </Text>
        ) : (
          events.slice(0, 100).map((e) => (
            <View
              key={e.id}
              style={{
                borderTopWidth: 1,
                borderTopColor: COLORS.stroke,
                paddingTop: 8,
                gap: 4,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Badge tone={KIND_TONE[e.kind] ?? "idle"} label={e.kind} />
                <Text style={{ color: COLORS.ink3, fontSize: 11 }}>
                  {stamp(e.created_at)}
                </Text>
              </View>
              {e.detail ? (
                <Text style={{ color: COLORS.ink2, fontSize: 12 }}>
                  {e.detail}
                </Text>
              ) : null}
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  );
}
