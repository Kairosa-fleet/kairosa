"""WebSocket connection registry and Redis-backed fan-out.

A viewer's socket lives on one API worker; the ingest that should update it
may land on another. Redis pub/sub bridges them, which is what allows the
service to run more than one process.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import WebSocket

from app.core.redis_client import get_redis, org_channel

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Tracks live sockets per organization on *this* worker."""

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        self._listener: asyncio.Task | None = None
        self._pubsub = None

    async def connect(self, websocket: WebSocket, organization_id: str) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.setdefault(organization_id, set()).add(websocket)
        logger.info("ws connected org=%s total=%d", organization_id, self.count())

    async def disconnect(self, websocket: WebSocket, organization_id: str) -> None:
        async with self._lock:
            sockets = self._connections.get(organization_id)
            if sockets:
                sockets.discard(websocket)
                if not sockets:
                    self._connections.pop(organization_id, None)

    def count(self) -> int:
        return sum(len(s) for s in self._connections.values())

    async def send_local(self, organization_id: str, message: dict) -> None:
        """Deliver to sockets held by this worker, pruning dead ones."""
        sockets = list(self._connections.get(organization_id, ()))
        if not sockets:
            return
        payload = json.dumps(message, default=str)
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws, organization_id)

    async def publish(self, organization_id: str, message: dict) -> None:
        """Publish to every worker via Redis; falls back to local delivery."""
        try:
            redis = get_redis()
            await redis.publish(
                org_channel(organization_id), json.dumps(message, default=str)
            )
        except Exception:
            logger.warning("redis publish failed; delivering locally only")
            await self.send_local(organization_id, message)

    # --- Redis subscriber ---

    async def start_listener(self) -> None:
        if self._listener is not None:
            return
        self._listener = asyncio.create_task(self._listen())

    async def stop_listener(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._listener
            self._listener = None
        if self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.aclose()
            self._pubsub = None

    async def _listen(self) -> None:
        """Subscribe to all org channels and relay into local sockets."""
        while True:
            try:
                redis = get_redis()
                self._pubsub = redis.pubsub()
                await self._pubsub.psubscribe("track:org:*")
                async for raw in self._pubsub.listen():
                    if raw.get("type") != "pmessage":
                        continue
                    channel = raw["channel"]
                    organization_id = channel.rsplit(":", 1)[-1]
                    try:
                        message = json.loads(raw["data"])
                    except (ValueError, TypeError):
                        continue
                    await self.send_local(organization_id, message)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("pubsub listener error; retrying in 2s")
                await asyncio.sleep(2)


manager = ConnectionManager()
