"""Server-side location integrity scoring.

Client flags like ``isMockLocation`` are trivially bypassed on a rooted phone
and do not exist at all on iOS, so they are treated as weak inputs. The real
detection is physics: a spoofer can lie about any single value, but keeping
position, speed, bearing, accuracy, altitude and battery mutually consistent
over hours is hard, and every mistake is permanent evidence.

Scores start at 100 and lose points per failed check. Nothing is ever
rejected on trust score alone — see docs/ANTI_SPOOFING.md. Legitimate GPS
produces terrible data in tunnels, basements and urban canyons, and a
discarded ping is evidence you no longer have.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

from app.core.config import settings
from app.schemas.ingest import LocationPingIn

EARTH_RADIUS_M = 6_371_000.0


@dataclass
class PreviousFix:
    """The last accepted fix for a device, used as the comparison baseline."""

    latitude: float
    longitude: float
    recorded_at: datetime
    battery_level: float | None = None
    accuracy_m: float | None = None


@dataclass
class IntegrityResult:
    score: int
    flags: list[str] = field(default_factory=list)

    @property
    def is_suspicious(self) -> bool:
        return self.score < settings.TRUST_SUSPICIOUS_THRESHOLD

    @property
    def is_spoofed(self) -> bool:
        return self.score < settings.TRUST_SPOOFED_THRESHOLD


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, in degrees clockwise from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angular_difference(a: float, b: float) -> float:
    """Smallest absolute difference between two bearings, 0-180."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _count_decimals(value: float) -> int:
    text = repr(float(value))
    if "e" in text or "E" in text:
        return 10  # scientific notation implies plenty of precision
    _, _, frac = text.partition(".")
    return len(frac.rstrip("0"))


def evaluate(
    ping: LocationPingIn,
    previous: PreviousFix | None,
    *,
    platform: str | None = None,
) -> IntegrityResult:
    """Score one ping against its predecessor. Pure function — easy to test."""
    score = 100
    flags: list[str] = []

    def penalise(points: int, flag: str) -> None:
        nonlocal score
        score -= points
        flags.append(flag)

    loc = ping.location
    mov = ping.movement
    state = ping.device_state

    # --- Layer 1: client-declared signals (weak, but free) ---
    if state.is_mock_location:
        # Asymmetric signal. It is bypassable, so `false` proves nothing —
        # but when the OS says `true` it is authoritative, and there is no
        # plausible false positive. A true value alone is enough to classify
        # the fix as spoofed.
        penalise(65, "mock_location_flag")

    # --- Accuracy fingerprinting ---
    # Real GNSS accuracy fluctuates constantly. A perfectly round, unchanging
    # value across fixes is characteristic of synthetic data.
    if loc.accuracy is not None:
        if loc.accuracy == 0:
            penalise(15, "zero_accuracy")
        elif (
            previous is not None
            and previous.accuracy_m is not None
            and loc.accuracy == previous.accuracy_m
            and float(loc.accuracy).is_integer()
        ):
            penalise(10, "static_accuracy")

    # --- Coordinate quantisation ---
    # Genuine fixes carry many decimal places; hand-written or grid-snapped
    # coordinates are conspicuously round.
    if _count_decimals(loc.latitude) <= 3 and _count_decimals(loc.longitude) <= 3:
        penalise(15, "quantised_coordinates")

    # --- Altitude plausibility ---
    # Most spoofing tools ignore altitude entirely and send a constant 0.
    if loc.altitude is not None and loc.altitude == 0 and loc.accuracy not in (None, 0):
        penalise(5, "zero_altitude")

    # --- Activity vs motion agreement ---
    speed = mov.speed
    if speed is not None:
        if mov.activity.value == "driving" and speed < 0.5:
            penalise(5, "activity_speed_mismatch")
        elif mov.activity.value == "still" and speed > 5.0:
            penalise(10, "activity_speed_mismatch")

    # --- Network vs motion agreement ---
    if (
        state.network_status.value == "wifi"
        and speed is not None
        and speed > 25.0  # ~90 km/h on wifi is not plausible
    ):
        penalise(10, "wifi_at_speed")

    # --- Checks needing a predecessor ---
    if previous is not None:
        dt = (ping.timestamp - previous.recorded_at).total_seconds()

        if dt < 0:
            penalise(20, "timestamp_regression")
        elif dt > 0:
            distance = haversine_m(
                previous.latitude, previous.longitude, loc.latitude, loc.longitude
            )
            implied_speed = distance / dt

            # Teleport: displacement impossible for any road vehicle.
            if implied_speed > settings.MAX_PLAUSIBLE_SPEED_MPS:
                penalise(40, "teleport")

            # Reported speed disagreeing with actual displacement. Spoofers
            # commonly set a position but forget to make speed agree.
            if speed is not None and dt <= 120 and distance > 20:
                # Allow generous tolerance for GPS noise and non-straight paths.
                if implied_speed > 1.0 and (
                    speed > implied_speed * 3 + 5 or speed < implied_speed / 3 - 5
                ):
                    penalise(15, "speed_displacement_mismatch")

            # Reported bearing disagreeing with the actual direction travelled.
            if (
                mov.bearing is not None
                and distance > 30  # short hops are dominated by noise
                and dt <= 120
                and angular_difference(
                    mov.bearing,
                    bearing_deg(
                        previous.latitude,
                        previous.longitude,
                        loc.latitude,
                        loc.longitude,
                    ),
                )
                > 90
            ):
                penalise(10, "bearing_trajectory_mismatch")

            # Battery rising while not charging is physically impossible.
            if (
                state.battery_level is not None
                and previous.battery_level is not None
                and state.is_charging is False
                and state.battery_level > previous.battery_level + 0.02
            ):
                penalise(10, "battery_rose_uncharged")

    # iOS cannot report mock location at all, so an iOS `false` carries less
    # information than an Android `false`. Recorded, not penalised.
    if platform and platform.lower() == "ios" and not state.is_mock_location:
        flags.append("ios_mock_unverifiable")

    return IntegrityResult(score=max(0, min(100, score)), flags=flags)


def blend_device_trust(current: float, ping_score: int, weight: float = 0.1) -> float:
    """Exponentially-weighted rolling device reputation.

    One bad ping is a tunnel; a hundred is a spoofing app. The low weight is
    deliberate — it takes sustained bad behaviour to move the score.
    """
    return round(current * (1 - weight) + ping_score * weight, 2)
