"use client";

/**
 * Live tracking: React Query seeds the current positions, the WebSocket keeps
 * them current.
 *
 * The socket writes straight into the query cache rather than into component
 * state, so there is exactly one source of truth and no setState-in-effect
 * cascade. Reconnect uses exponential backoff *with jitter* — without jitter
 * every dashboard in an office reconnects on the same tick after a blip and
 * stampedes the backend.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, getAccessToken } from "./api";
import type { Position, SocketFrame } from "./types";

const WS_BASE =
  process.env.NEXT_PUBLIC_WS_BASE_URL?.replace(/\/$/, "") ??
  (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000")
    .replace(/^http/, "ws")
    .replace(/\/$/, "");

export const positionsKey = ["positions", "latest"] as const;

export type ConnectionState = "connecting" | "live" | "offline";

export function useLiveTracking() {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  const { data, error, isPending, refetch } = useQuery({
    queryKey: positionsKey,
    queryFn: api.latestPositions,
    // The socket keeps this fresh; polling would duplicate its job.
    refetchInterval: false,
  });

  const upsert = useCallback(
    (incoming: Position) => {
      queryClient.setQueryData<Position[]>(positionsKey, (prev = []) => {
        const index = prev.findIndex((p) => p.deviceId === incoming.deviceId);
        if (index === -1) return [...prev, incoming];
        // Out-of-order frames must not rewind a marker to an older position.
        if (new Date(prev[index].recordedAt) > new Date(incoming.recordedAt))
          return prev;
        const next = prev.slice();
        next[index] = incoming;
        return next;
      });
    },
    [queryClient],
  );

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;

    const scheduleReconnect = () => {
      if (closedRef.current) return;
      const attempt = Math.min(attemptRef.current++, 6);
      const base = Math.min(1000 * 2 ** attempt, 30_000);
      const delay = base * (0.7 + Math.random() * 0.6);
      timerRef.current = setTimeout(() => {
        void refetch(); // catch up on anything missed while disconnected
        connect();
      }, delay);
    };

    function connect() {
      const token = getAccessToken();
      if (!token || closedRef.current) return;

      setConnection((current) => (current === "live" ? current : "connecting"));

      let ws: WebSocket;
      try {
        ws = new WebSocket(
          `${WS_BASE}/v1/ws/track?token=${encodeURIComponent(token)}`,
        );
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setConnection("live");
        heartbeatRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 30_000);
      };

      ws.onmessage = (event) => {
        if (event.data === "pong") return;
        let frame: SocketFrame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === "position") upsert(frame);
      };

      ws.onerror = () => setConnection("offline");

      ws.onclose = () => {
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
        socketRef.current = null;
        if (!closedRef.current) {
          setConnection("offline");
          scheduleReconnect();
        }
      };
    }

    connect();

    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [refetch, upsert]);

  const list = useMemo(() => data ?? [], [data]);
  const positions = useMemo(
    () => new Map(list.map((p) => [p.deviceId, p])),
    [list],
  );

  return {
    positions,
    list,
    connection,
    error: error instanceof Error ? error.message : null,
    loading: isPending,
    refresh: refetch,
  };
}
