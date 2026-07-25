"""Redis connection and pub/sub channel helpers.

Redis serves three roles:
  1. Pub/sub fan-out so any API worker can push to any connected WebSocket.
  2. Device-token revocation cache (checked on every ingest, must be fast).
  3. Sliding-window rate limiting.
"""

from __future__ import annotations

import redis.asyncio as aioredis

from app.core.config import settings

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    """Return the shared Redis client, creating it on first use."""
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            health_check_interval=30,
        )
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


# --- Channel naming -------------------------------------------------------


def org_channel(organization_id: str) -> str:
    """Pub/sub channel carrying every ping for one organization."""
    return f"track:org:{organization_id}"


def revoked_key(device_id: str) -> str:
    return f"revoked:device:{device_id}"


def rate_limit_key(scope: str, identity: str) -> str:
    return f"ratelimit:{scope}:{identity}"
