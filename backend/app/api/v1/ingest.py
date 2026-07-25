"""Location ingest endpoints — the device-facing write path."""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from app.api.deps import DbSession, RateLimitedDevice, client_ip
from app.schemas.ingest import IngestBatchIn, IngestBatchOut, LocationPingIn
from app.services.ingest_service import ingest_batch

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("/batch", response_model=IngestBatchOut, status_code=status.HTTP_200_OK)
async def ingest_batch_endpoint(
    payload: IngestBatchIn,
    device: RateLimitedDevice,
    db: DbSession,
    request: Request,
) -> IngestBatchOut:
    """Accept a batch of fixes drained from the device outbox.

    Returns a per-item result so the app knows exactly which entries it may
    delete. Items are independent: one malformed fix never fails the batch.
    """
    return await ingest_batch(
        db=db,
        device=device,
        pings=payload.pings,
        source_ip=client_ip(request),
    )


@router.post("/single", response_model=IngestBatchOut, status_code=status.HTTP_200_OK)
async def ingest_single_endpoint(
    payload: LocationPingIn,
    device: RateLimitedDevice,
    db: DbSession,
    request: Request,
) -> IngestBatchOut:
    """Single-fix convenience endpoint, mainly for debugging with curl."""
    return await ingest_batch(
        db=db,
        device=device,
        pings=[payload],
        source_ip=client_ip(request),
    )
