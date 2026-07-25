"""WebSocket endpoint for live position streaming."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from jose import JWTError

from app.core.database import AsyncSessionLocal
from app.core.security import decode_token
from app.models.user import User
from app.services.broadcast import manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])

WS_POLICY_VIOLATION = 1008


@router.websocket("/ws/track")
async def track_ws(websocket: WebSocket, token: str = Query(...)) -> None:
    """Stream live positions for the caller's organization.

    The token arrives as a query parameter because browsers cannot set
    headers on a WebSocket handshake. It is verified before the socket is
    accepted, and it is an access JWT, so it expires quickly.
    """
    try:
        claims = decode_token(token, expected_type="access")
        user_id = uuid.UUID(claims["sub"])
    except (JWTError, KeyError, ValueError):
        await websocket.close(code=WS_POLICY_VIOLATION, reason="Invalid token")
        return

    # Re-check the user against the database: a JWT alone could belong to a
    # since-deactivated account.
    async with AsyncSessionLocal() as db:
        user = await db.get(User, user_id)
        if user is None or not user.is_active:
            await websocket.close(code=WS_POLICY_VIOLATION, reason="Invalid user")
            return
        organization_id = str(user.organization_id)

    await manager.connect(websocket, organization_id)
    try:
        await websocket.send_json({"type": "connected", "organizationId": organization_id})
        while True:
            # Client messages are only used as a keepalive; the stream is
            # server-push. A ping/pong keeps intermediaries from idling us out.
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=60)
                if message == "ping":
                    await websocket.send_text("pong")
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("websocket error")
    finally:
        await manager.disconnect(websocket, organization_id)
        with contextlib.suppress(Exception):
            await websocket.close()
