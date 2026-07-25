"""Async SQLAlchemy engine, session factory, and declarative base."""

from collections.abc import AsyncGenerator
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def _async_engine_args(url: str) -> tuple[str, dict]:
    """Make a standard managed-Postgres URL work with the asyncpg driver.

    Every managed provider (Neon, Supabase, Render, RDS) hands you a
    connection string ending in ``?sslmode=require``. That is a *libpq*
    parameter; asyncpg has never heard of it and raises
    ``connect() got an unexpected keyword argument 'sslmode'`` on boot. So the
    naive "paste the Neon URL into DATABASE_URL" — which is exactly what the
    deployment guide tells the operator to do — would fail at startup.

    We strip ``sslmode`` (and its cousin ``channel_binding``) out of the URL
    and translate a TLS-requiring value into asyncpg's own ``ssl`` connect
    argument, so the copy-pasted string just works.
    """
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    connect_args: dict = {}

    sslmode = query.pop("sslmode", [None])[0]
    query.pop("channel_binding", None)  # also libpq-only; asyncpg rejects it
    if sslmode in {"require", "verify-ca", "verify-full", "prefer", "allow"}:
        # Neon terminates TLS but presents a cert asyncpg cannot chain to a
        # public root by default; require encryption without cert verification,
        # which is the standard posture for these providers.
        connect_args["ssl"] = True

    cleaned = urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment)
    )
    return cleaned, connect_args


_db_url, _connect_args = _async_engine_args(settings.DATABASE_URL)

engine = create_async_engine(
    _db_url,
    echo=settings.DB_ECHO,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_pre_ping=True,  # drop dead connections instead of erroring on first use
    connect_args=_connect_args,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a session that rolls back on error."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
