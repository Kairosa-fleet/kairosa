"""Alembic environment — async engine, models autoloaded from app.models."""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import settings
from app.core.database import Base, _async_engine_args

# Importing the package registers every table on Base.metadata.
import app.models  # noqa: F401

config = context.config
# Same normalisation the runtime engine uses, so migrations connect to a
# managed Postgres (Neon/Render/Supabase) whose URL carries `sslmode=require`
# — which asyncpg would otherwise reject. See app/core/database.py.
_migration_url, _migration_connect_args = _async_engine_args(settings.DATABASE_URL)
config.set_main_option("sqlalchemy.url", _migration_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    """Only ever manage tables this application actually owns.

    The PostGIS image ships the `tiger`, `tiger_data` and `topology` schemas
    plus `spatial_ref_sys`. Without this filter, autogenerate reflects them,
    sees they are absent from our metadata, and emits DROP TABLE for all of
    them — which would destroy the PostGIS installation.
    """
    if type_ == "table":
        if getattr(obj, "schema", None) not in (None, "public"):
            return False
        return name in target_metadata.tables
    # Never touch indexes/constraints belonging to tables we do not own.
    parent = getattr(obj, "table", None)
    if parent is not None and parent.name not in target_metadata.tables:
        return False
    return True


def run_migrations_offline() -> None:
    context.configure(
        url=settings.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=_migration_connect_args,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
