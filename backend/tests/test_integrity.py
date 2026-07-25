"""Unit tests for the integrity scorer. Pure functions — no database needed."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.schemas.ingest import LocationPingIn
from app.services.integrity import (
    PreviousFix,
    angular_difference,
    bearing_deg,
    blend_device_trust,
    evaluate,
    haversine_m,
)

BASE_TIME = datetime(2026, 7, 20, 12, 0, 0, tzinfo=timezone.utc)


def make_ping(
    lat=22.307215,
    lon=73.181234,
    accuracy=5.3,
    altitude=35.8,
    speed=16.67,
    bearing=180.5,
    activity="driving",
    battery=0.85,
    charging=True,
    network="cellular",
    mock=False,
    ts=BASE_TIME,
) -> LocationPingIn:
    return LocationPingIn.model_validate(
        {
            "timestamp": ts.isoformat(),
            "location": {
                "latitude": lat,
                "longitude": lon,
                "accuracy": accuracy,
                "altitude": altitude,
                "altitudeAccuracy": 1.5,
            },
            "movement": {"speed": speed, "bearing": bearing, "activity": activity},
            "deviceState": {
                "batteryLevel": battery,
                "isCharging": charging,
                "networkStatus": network,
                "isMockLocation": mock,
            },
        }
    )


# --- geometry helpers -----------------------------------------------------


def test_haversine_known_distance():
    # Vadodara -> Ahmedabad is roughly 100 km.
    d = haversine_m(22.307215, 73.181234, 23.022505, 72.571362)
    assert 95_000 < d < 115_000


def test_haversine_zero():
    assert haversine_m(22.3, 73.1, 22.3, 73.1) == pytest.approx(0.0, abs=1e-6)


def test_bearing_north_and_east():
    assert bearing_deg(0, 0, 1, 0) == pytest.approx(0, abs=0.5)
    assert bearing_deg(0, 0, 0, 1) == pytest.approx(90, abs=0.5)


def test_angular_difference_wraps():
    assert angular_difference(350, 10) == pytest.approx(20)
    assert angular_difference(10, 350) == pytest.approx(20)
    assert angular_difference(0, 180) == pytest.approx(180)


# --- clean data -----------------------------------------------------------


def test_clean_ping_scores_full():
    result = evaluate(make_ping(), None)
    assert result.score == 100
    assert result.flags == []
    assert not result.is_suspicious


def test_realistic_movement_stays_trusted():
    """A vehicle at ~60 km/h for 10 s should not be flagged."""
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=10),
        battery_level=0.86,
        accuracy_m=4.8,
    )
    # ~167 m south of the previous point => ~16.7 m/s, matching reported speed.
    ping = make_ping(lat=22.305715, lon=73.181234, bearing=180.0)
    result = evaluate(ping, previous)
    assert result.score >= 90, result.flags


# --- spoofing detection ---------------------------------------------------


def test_mock_location_flag_penalised():
    result = evaluate(make_ping(mock=True), None)
    assert "mock_location_flag" in result.flags
    assert result.is_spoofed


def test_teleport_detected():
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=10),
    )
    # Vadodara -> Ahmedabad in 10 seconds.
    result = evaluate(make_ping(lat=23.022505, lon=72.571362), previous)
    assert "teleport" in result.flags
    assert result.is_spoofed


def test_speed_displacement_mismatch():
    """Position barely moves but the device claims highway speed."""
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=60),
    )
    ping = make_ping(lat=22.307815, lon=73.181234, speed=40.0, bearing=0.0)
    result = evaluate(ping, previous)
    assert "speed_displacement_mismatch" in result.flags


def test_bearing_trajectory_mismatch():
    """Moving north while claiming to head south."""
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=10),
    )
    ping = make_ping(lat=22.308215, lon=73.181234, bearing=180.0, speed=11.0)
    result = evaluate(ping, previous)
    assert "bearing_trajectory_mismatch" in result.flags


def test_quantised_coordinates_flagged():
    result = evaluate(make_ping(lat=22.31, lon=73.18), None)
    assert "quantised_coordinates" in result.flags


def test_zero_accuracy_flagged():
    result = evaluate(make_ping(accuracy=0), None)
    assert "zero_accuracy" in result.flags


def test_static_accuracy_flagged():
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=10),
        accuracy_m=5.0,
    )
    result = evaluate(make_ping(accuracy=5.0, speed=0.1, activity="still"), previous)
    assert "static_accuracy" in result.flags


def test_battery_rising_without_charging():
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME - timedelta(seconds=10),
        battery_level=0.50,
    )
    result = evaluate(make_ping(battery=0.90, charging=False), previous)
    assert "battery_rose_uncharged" in result.flags


def test_activity_speed_mismatch():
    result = evaluate(make_ping(activity="still", speed=30.0), None)
    assert "activity_speed_mismatch" in result.flags


def test_wifi_at_highway_speed():
    result = evaluate(make_ping(network="wifi", speed=30.0), None)
    assert "wifi_at_speed" in result.flags


def test_timestamp_regression():
    previous = PreviousFix(
        latitude=22.307215,
        longitude=73.181234,
        recorded_at=BASE_TIME + timedelta(seconds=30),
    )
    result = evaluate(make_ping(), previous)
    assert "timestamp_regression" in result.flags


def test_ios_mock_flag_is_noted_not_penalised():
    """iOS cannot report mock location, so its `false` means less."""
    result = evaluate(make_ping(), None, platform="ios")
    assert "ios_mock_unverifiable" in result.flags
    assert result.score == 100  # noted, not penalised


def test_score_never_negative():
    previous = PreviousFix(
        latitude=0.0, longitude=0.0, recorded_at=BASE_TIME + timedelta(seconds=5)
    )
    result = evaluate(
        make_ping(
            lat=22.31,
            lon=73.18,
            accuracy=0,
            speed=0.0,
            activity="still",
            mock=True,
            network="wifi",
        ),
        previous,
    )
    assert 0 <= result.score <= 100


# --- rolling reputation ---------------------------------------------------


def test_blend_moves_slowly():
    """One bad ping is a tunnel; sustained bad behaviour is fraud."""
    assert blend_device_trust(100.0, 0) == pytest.approx(90.0)
    score = 100.0
    for _ in range(50):
        score = blend_device_trust(score, 0)
    assert score < 10
