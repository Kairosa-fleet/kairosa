"""Where uploaded documents physically live.

Two backends behind one interface:

  * **Object storage** (Cloudflare R2, or any S3-compatible service) whenever
    ``S3_BUCKET`` is configured. This is what production uses, because a
    platform's local disk is ephemeral — on Render every redeploy would wipe
    every scan, leaving the database pointing at files that 404.
  * **Local disk** otherwise, for development and the test suite, so neither
    needs cloud credentials.

Objects are namespaced by organization id in *both* backends, so the download
handler scopes reads to the caller's own organization and cross-tenant access
is structural rather than a check that could be forgotten.

Blocking S3/filesystem calls run in a threadpool (``anyio.to_thread``) so they
never stall the async event loop — the same pattern the SMTP sender uses.
"""

from __future__ import annotations

import functools
from pathlib import Path

import anyio

from app.core.config import settings


def use_s3() -> bool:
    """True when object storage is configured; otherwise local disk is used."""
    return bool(settings.S3_BUCKET and settings.S3_ENDPOINT_URL)


def backend_name() -> str:
    return "s3" if use_s3() else "local"


@functools.lru_cache(maxsize=1)
def _client():
    # Imported lazily so a local/dev install without object storage never needs
    # boto3 loaded. boto3 clients are thread-safe, so one shared client is fine
    # across the threadpool.
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL,
        aws_access_key_id=settings.S3_ACCESS_KEY_ID,
        aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
        # R2 ignores region but the SDK requires one; "auto" is R2's convention.
        region_name=settings.S3_REGION or "auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def _object_key(organization_id, name: str) -> str:
    return f"{organization_id}/{name}"


# --- blocking implementations (run in a worker thread) ---------------------


def _put_sync(organization_id, name: str, data: bytes, content_type: str) -> None:
    if use_s3():
        _client().put_object(
            Bucket=settings.S3_BUCKET,
            Key=_object_key(organization_id, name),
            Body=data,
            ContentType=content_type,
        )
        return
    directory = Path(settings.UPLOAD_DIR) / str(organization_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_bytes(data)


def _get_sync(organization_id, name: str) -> bytes | None:
    if use_s3():
        from botocore.exceptions import ClientError

        try:
            response = _client().get_object(
                Bucket=settings.S3_BUCKET, Key=_object_key(organization_id, name)
            )
            return response["Body"].read()
        except ClientError:
            # Missing key, wrong bucket, etc. — treated as "not found".
            return None
    path = Path(settings.UPLOAD_DIR) / str(organization_id) / name
    return path.read_bytes() if path.is_file() else None


# --- async interface -------------------------------------------------------


async def put(organization_id, name: str, data: bytes, content_type: str) -> None:
    await anyio.to_thread.run_sync(_put_sync, organization_id, name, data, content_type)


async def get(organization_id, name: str) -> bytes | None:
    return await anyio.to_thread.run_sync(_get_sync, organization_id, name)
