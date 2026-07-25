"""Aggregates every v1 route into a single router."""

from fastapi import APIRouter

from app.api.v1 import (
    auth, booking, devices, documents, driver_auth, fleet, ingest, org,
    tracking, tracking_public, ws,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(driver_auth.router)
api_router.include_router(devices.router)
api_router.include_router(fleet.router)
api_router.include_router(documents.router)
api_router.include_router(org.router)
api_router.include_router(booking.router)
api_router.include_router(ingest.router)
api_router.include_router(tracking.router)
api_router.include_router(tracking_public.router)
api_router.include_router(ws.router)
