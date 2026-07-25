"use client";

import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { FleetMap } from "@/components/FleetMap";
import { useResolvedTheme } from "@/components/ThemeToggle";
import { VehicleDetail } from "@/components/VehicleDetail";
import { VehicleList } from "@/components/VehicleList";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { cn } from "@/lib/format";
import { useDevices } from "@/lib/queries";
import { useLiveTracking } from "@/lib/useLiveTracking";
import type { Position } from "@/lib/types";

export default function FleetPage() {
  const theme = useResolvedTheme();
  const { positions, list, connection, error, loading, refresh } = useLiveTracking();
  const devicesQuery = useDevices();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<Position[] | undefined>();

  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const deviceMap = useMemo(
    () => new Map(devices.map((d) => [d.id, d])),
    [devices],
  );
  const selectedDevice = selectedId ? deviceMap.get(selectedId) : undefined;

  // Changing selection must drop the previous vehicle's trail, otherwise one
  // vehicle's history lingers on the map under another.
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setTrail(undefined);
  }, []);

  const refreshAll = useCallback(() => {
    void refresh();
    void devicesQuery.refetch();
  }, [refresh, devicesQuery]);

  const anyError =
    error ??
    (devicesQuery.error instanceof Error ? devicesQuery.error.message : null);

  return (
    <div className="flex h-full">
      <aside className="hidden w-[19rem] shrink-0 flex-col border-r border-[var(--stroke)] md:flex">
        <ConnectionBar connection={connection} onRefresh={refreshAll} />
        {loading ? (
          <Spinner label="Loading fleet…" />
        ) : (
          <VehicleList
            devices={devices}
            positions={positions}
            selectedId={selectedId}
            onSelect={select}
          />
        )}
      </aside>

      <div className="relative min-w-0 flex-1">
        <FleetMap
          positions={list}
          devices={deviceMap}
          selectedId={selectedId}
          onSelect={select}
          theme={theme}
          trail={trail}
        />

        {anyError && (
          <div className="absolute top-4 left-1/2 z-10 w-[min(28rem,90vw)] -translate-x-1/2">
            <ErrorNote>{anyError}</ErrorNote>
          </div>
        )}

        {/* The detail panel floats over the map so the map never resizes —
            a resize forces MapLibre to re-render every tile. */}
        {selectedDevice && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-end sm:inset-x-auto sm:right-4 sm:bottom-4">
            <VehicleDetail
              key={selectedDevice.id}
              device={selectedDevice}
              position={positions.get(selectedDevice.id)}
              onClose={() => select(null)}
              onTrailChange={setTrail}
            />
          </div>
        )}

        {/* Mobile: the vehicle list becomes a bottom sheet. */}
        {!selectedDevice && (
          <div className="absolute inset-x-0 bottom-0 z-10 max-h-[45vh] overflow-hidden rounded-t-[var(--radius-card)] border-t border-[var(--stroke)] bg-[var(--bg)] shadow-[var(--shadow-pop)] md:hidden">
            <VehicleList
              devices={devices}
              positions={positions}
              selectedId={selectedId}
              onSelect={select}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionBar({
  connection,
  onRefresh,
}: {
  connection: "connecting" | "live" | "offline";
  onRefresh: () => void;
}) {
  const map = {
    live: { Icon: Radio, text: "Live", color: "var(--success)" },
    connecting: { Icon: RefreshCw, text: "Connecting…", color: "var(--warning)" },
    offline: { Icon: WifiOff, text: "Reconnecting…", color: "var(--danger)" },
  } as const;
  const { Icon, text, color } = map[connection];

  return (
    <div className="flex items-center justify-between border-b border-[var(--stroke)] px-4 py-2">
      <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color }}>
        <Icon
          size={13}
          aria-hidden
          className={cn(connection === "connecting" && "animate-spin")}
        />
        {text}
      </span>
      <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh">
        <RefreshCw size={13} aria-hidden />
      </Button>
    </div>
  );
}
