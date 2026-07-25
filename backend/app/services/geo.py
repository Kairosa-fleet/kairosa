"""Address search and routing.

Proxied through the backend rather than called from the browser for three
reasons: the provider key never reaches the client, results can be cached in
Redis (both providers rate-limit), and swapping provider is a change here
instead of in every screen.

Providers:
  * Geocoding  — MapTiler (same key as the map tiles)
  * Routing    — OSRM

See docs/MAPPING_STACK.md.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)

GEOCODE_TTL = 60 * 60 * 24 * 7   # addresses barely move
ROUTE_TTL = 60 * 60 * 6          # roads change more often than addresses


class GeoError(Exception):
    pass


async def _cached(key: str, ttl: int, produce) -> Any:
    redis = None
    try:
        redis = get_redis()
        hit = await redis.get(key)
        if hit:
            return json.loads(hit)
    except Exception:
        redis = None  # cache is an optimisation, never a dependency

    value = await produce()

    if redis is not None:
        try:
            await redis.setex(key, ttl, json.dumps(value))
        except Exception:
            pass
    return value


# --- Geocoding -------------------------------------------------------------


# How precise a geocoded result actually is, derived from the feature type the
# provider returns. Surfaced to the operator because a locality centroid and a
# street address look identical once they are just two numbers in a form — and
# routing a truck to the middle of an industrial estate instead of its gate is
# the difference between arriving and phoning for directions.
PRECISION_BY_TYPE = {
    "address": "exact",
    "poi": "exact",
    "poi_landmark": "exact",
    "street": "street",
    "postal_code": "area",
}

# Only these are precise enough to route a vehicle to without a human check.
PRECISE = {"exact", "street"}


def _precision(feature: dict) -> str:
    types = feature.get("place_type") or []
    for t in types:
        if t in PRECISION_BY_TYPE:
            return PRECISION_BY_TYPE[t]
    return "area"


def _haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _rank(places: list[dict], near: tuple[float, float] | None) -> list[dict]:
    """Re-order results by relevance *and* distance from where we are looking.

    The provider barely weights distance: searching "Bhiwandi warehouse" from
    Mumbai returns a Warehouse Road in Kerala, 1,300 km away, at relevance 0.48
    against the correct town's 0.50. That ordering is useless at a dispatch
    desk.

    Distance decays the score rather than filtering, because a transporter
    booking Jaipur → Kochi is legitimately searching 2,000 km away. A far
    result that genuinely matches still wins against a near one that does not.
    """
    if near is None:
        return places

    lat, lon = near
    for place in places:
        if place.get("latitude") is None:
            place["distanceKm"] = None
            place["_score"] = place.get("relevance") or 0.0
            continue
        distance = _haversine_km(lat, lon, place["latitude"], place["longitude"])
        place["distanceKm"] = round(distance, 1)
        decay = 0.55 + 0.45 * math.exp(-distance / 250.0)
        place["_score"] = (place.get("relevance") or 0.0) * decay

    ordered = sorted(places, key=lambda p: p.get("_score", 0.0), reverse=True)
    for place in ordered:
        place.pop("_score", None)
    return ordered


def _dedupe(places: list[dict]) -> list[dict]:
    """Drop repeats.

    The provider happily returns "Naraina, Delhi, India" twice. Two entries the
    operator cannot tell apart is worse than one — they assume the difference
    is meaningful and hesitate.
    """
    seen: set[tuple] = set()
    out: list[dict] = []
    for place in places:
        name = (place.get("placeName") or "").strip().lower()
        # ~100 m: the same place returned from two indexes rarely differs more.
        key = (
            name,
            round(place["latitude"], 3) if place.get("latitude") is not None else None,
            round(place["longitude"], 3) if place.get("longitude") is not None else None,
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(place)
    return out


async def search_places(
    query: str, limit: int = 6, near: tuple[float, float] | None = None
) -> list[dict]:
    """Autocomplete for an address box.

    Biased to India via `country=in`; without it "Nagar" matches half the world.
    `near` biases towards where the dispatcher is actually working — the other
    end of the consignment, or the last place they picked.
    """
    q = query.strip()
    if len(q) < 3:
        return []

    async def fetch() -> list[dict]:
        if not settings.MAPTILER_KEY:
            raise GeoError("MAPTILER_KEY is not configured")
        params: dict[str, Any] = {
            "key": settings.MAPTILER_KEY,
            "country": "in",
            # Over-fetch so there is something left to rank after deduping.
            "limit": min(10, max(limit * 2, 6)),
            "language": "en",
            "autocomplete": "true",
            "fuzzyMatch": "true",
        }
        if near is not None:
            # The provider wants lon,lat — the opposite order to everything
            # else in this file, which is a classic way to end up in the sea.
            params["proximity"] = f"{near[1]},{near[0]}"

        # The query goes in the URL *path*, so every reserved character has to
        # be escaped — `safe=""` in particular. Indian addresses are full of
        # slashes ("C2/301", "Plot 5/2", "H.No 12/A"), and an unescaped one
        # becomes a path separator: the request 404s and the operator is told
        # their address does not exist.
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"https://api.maptiler.com/geocoding/{quote(q, safe='')}.json",
                params=params,
            )
        if response.status_code != 200:
            raise GeoError(f"Geocoding failed ({response.status_code})")

        features = response.json().get("features", [])
        return [_to_place(f) for f in features]

    key_near = f"{near[0]:.2f},{near[1]:.2f}" if near else "-"
    places = await _cached(
        f"geo:search:{q.lower()}:{limit}:{key_near}", GEOCODE_TTL, fetch
    )
    return _rank(_dedupe(places), near)[:limit]


async def reverse_geocode(latitude: float, longitude: float) -> dict | None:
    """Pin dropped on the map -> a usable postal address."""

    async def fetch() -> dict | None:
        if not settings.MAPTILER_KEY:
            raise GeoError("MAPTILER_KEY is not configured")
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"https://api.maptiler.com/geocoding/{longitude},{latitude}.json",
                params={"key": settings.MAPTILER_KEY, "language": "en"},
            )
        if response.status_code != 200:
            raise GeoError(f"Reverse geocoding failed ({response.status_code})")
        features = response.json().get("features", [])
        return _to_place(features[0]) if features else None

    return await _cached(
        f"geo:rev:{latitude:.5f},{longitude:.5f}", GEOCODE_TTL, fetch
    )


def _to_place(feature: dict) -> dict:
    """Flatten a MapTiler feature into the fields an address form needs."""
    center = feature.get("center") or [None, None]
    context = {c.get("id", "").split(".")[0]: c.get("text") for c in feature.get("context", [])}

    return {
        "id": feature.get("id"),
        "placeName": feature.get("place_name"),
        "text": feature.get("text"),
        # How much to trust the pin. "area" means the coordinates are a
        # locality centroid and the operator must drag the pin to the gate.
        "precision": _precision(feature),
        "relevance": feature.get("relevance"),
        # The top-level feature type — "poi" marks a landmark, which is how
        # Indian addresses are actually described ("behind Sayaji Hospital").
        "kind": (feature.get("place_type") or ["unknown"])[0],
        "longitude": center[0],
        "latitude": center[1],
        "city": context.get("municipality") or context.get("place") or context.get("municipal_district"),
        "state": context.get("region"),
        "pincode": context.get("postal_code"),
        "country": context.get("country") or "India",
    }


# --- Routing ---------------------------------------------------------------


async def route(
    origin: tuple[float, float],
    destination: tuple[float, float],
    alternatives: bool = True,
) -> dict:
    """Driving route(s) between two points.

    Returns the fastest route plus any alternatives OSRM offers, each with
    distance, duration and a GeoJSON LineString for drawing on the map.
    """
    o_lat, o_lon = origin
    d_lat, d_lon = destination

    async def fetch() -> dict:
        url = (
            f"{settings.OSRM_BASE_URL}/route/v1/driving/"
            f"{o_lon},{o_lat};{d_lon},{d_lat}"
        )
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                url,
                params={
                    "overview": "full",
                    "geometries": "geojson",
                    "alternatives": "true" if alternatives else "false",
                    "steps": "false",
                },
            )
        if response.status_code != 200:
            raise GeoError(f"Routing failed ({response.status_code})")

        body = response.json()
        if body.get("code") != "Ok":
            raise GeoError(f"No route found ({body.get('code')})")

        routes = []
        for index, r in enumerate(body.get("routes", [])):
            legs = r.get("legs") or [{}]
            routes.append(
                {
                    "index": index,
                    # OSRM returns the fastest route first; the label is what
                    # a dispatcher actually reasons about.
                    "label": "Fastest" if index == 0 else f"Alternative {index}",
                    "distanceMeters": r.get("distance"),
                    "durationSeconds": r.get("duration"),
                    "geometry": r.get("geometry"),
                    "summary": legs[0].get("summary") or None,
                }
            )

        # Surface the shortest-by-distance separately: on Indian highways the
        # fastest and the shortest are frequently different roads, and the
        # cheaper one (tolls, fuel) is often the shorter one.
        if len(routes) > 1:
            shortest = min(routes, key=lambda r: r["distanceMeters"] or float("inf"))
            if shortest["index"] != 0:
                shortest["label"] = "Shortest"

        return {"routes": routes}

    key = f"geo:route:{o_lat:.4f},{o_lon:.4f}:{d_lat:.4f},{d_lon:.4f}:{alternatives}"
    return await _cached(key, ROUTE_TTL, fetch)
