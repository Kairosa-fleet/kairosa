"""FastAPI application entrypoint.

Deployment shape: a single stateless service. All shared state lives in
Postgres and Redis, so N replicas can run behind a load balancer with no
sticky sessions — including for WebSockets, which fan out through Redis.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import AsyncSessionLocal, engine
from app.core.redis_client import close_redis, get_redis
from app.services.broadcast import manager

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MiB — a 100-ping batch is ~40 KiB


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("starting %s (%s)", settings.SERVICE_NAME, settings.ENVIRONMENT)
    await manager.start_listener()
    yield
    await manager.stop_listener()
    await close_redis()
    await engine.dispose()
    logger.info("shutdown complete")


app = FastAPI(
    title="Kairosa API",
    description="Location ingest, integrity scoring, and live tracking.",
    version="1.0.0",
    lifespan=lifespan,
    # Never expose interactive docs or the schema in production.
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Device-Token"],
    max_age=600,
)


@app.middleware("http")
async def security_and_logging(request: Request, call_next):
    """Body-size cap, request id, timing, and security headers."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_BODY_BYTES:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={"detail": "Request body too large"},
                )
        except ValueError:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"detail": "Invalid Content-Length"},
            )

    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000

    response.headers["X-Request-ID"] = request_id
    response.headers["X-Response-Time-ms"] = f"{elapsed_ms:.1f}"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    response.headers["Cache-Control"] = "no-store"
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    """Compact 422 body; avoids echoing raw input back to the caller."""
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "Validation error",
            "errors": [
                {"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]}
                for e in exc.errors()
            ],
        },
    )


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    """Never leak a stack trace or internal detail to a client."""
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok", "service": settings.SERVICE_NAME}


@app.get("/health/ready", tags=["health"])
async def readiness() -> JSONResponse:
    """Dependency check for load balancers and orchestrators."""
    checks: dict[str, str] = {}
    healthy = True

    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {type(exc).__name__}"
        healthy = False

    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {type(exc).__name__}"
        healthy = False

    return JSONResponse(
        status_code=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"status": "ready" if healthy else "degraded", "checks": checks},
    )


app.include_router(api_router, prefix=settings.API_V1_PREFIX)
