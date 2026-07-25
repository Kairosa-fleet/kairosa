"""Upload and retrieval of scanned compliance documents.

A document number alone is not evidence. At a checkpoint the officer wants to
see the certificate, and in an insurance claim months later so does the
insurer — so the scan is stored alongside the number, not instead of it.

Two rules shape everything here:

  * **The client never names a file.** Uploads are stored under a generated
    UUID inside a directory named for the organization. A filename supplied by
    a browser is attacker-controlled input, and joining it onto a path is how
    directory traversal happens.
  * **Reads are scoped by that directory, not by a check.** The download
    handler resolves paths only within the caller's own organization folder,
    so cross-tenant access is structurally impossible rather than merely
    guarded against.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser
from app.core.config import settings

router = APIRouter(prefix="/documents", tags=["documents"])

# What each accepted format actually begins with. Checked because the
# browser-supplied content-type is a claim, not a fact — a .pdf full of shell
# script arrives with exactly the content-type its uploader chooses.
SIGNATURES: tuple[tuple[bytes, str, str], ...] = (
    (b"%PDF-", "pdf", "application/pdf"),
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
)

# WebP is RIFF....WEBP — the marker sits at byte 8, so it needs its own check.
WEBP = ("webp", "image/webp")

MEDIA_TYPES = {ext: media for _, ext, media in SIGNATURES} | {WEBP[0]: WEBP[1]}


def _sniff(contents: bytes) -> tuple[str, str] | None:
    """Identify the format from its leading bytes. None if unrecognised."""
    for magic, ext, media in SIGNATURES:
        if contents.startswith(magic):
            return ext, media
    if contents[:4] == b"RIFF" and contents[8:12] == b"WEBP":
        return WEBP
    return None


def _org_dir(organization_id) -> Path:
    path = Path(settings.UPLOAD_DIR) / str(organization_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_document(user: CurrentUser, file: UploadFile = File(...)) -> dict:
    """Store a PDF or photo and return the reference to save against a record.

    Certificates arrive as PDFs; vehicle photos as JPEG, PNG or WebP. Both go
    through the same door because the storage, scoping and traversal rules are
    identical — only the accepted signatures differ.
    """
    limit = settings.MAX_UPLOAD_MB * 1024 * 1024
    contents = await file.read(limit + 1)
    if len(contents) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That file is larger than {settings.MAX_UPLOAD_MB} MB",
        )
    if not contents:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That file is empty")

    sniffed = _sniff(contents)
    if sniffed is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Only PDF, JPEG, PNG or WebP files are accepted — this file is "
            "not one of those, whatever it is named",
        )
    ext, media_type = sniffed

    stored_name = f"{uuid.uuid4()}.{ext}"
    (_org_dir(user.organization_id) / stored_name).write_bytes(contents)

    return {
        "fileUrl": f"/v1/documents/{stored_name}",
        # Kept for display only. It is never used to build a path.
        "fileName": (file.filename or f"upload.{ext}")[:200],
        "contentType": media_type,
        "sizeBytes": len(contents),
    }


@router.get("/{stored_name}")
async def get_document(stored_name: str, user: CurrentUser) -> FileResponse:
    """Stream a stored PDF back. Authenticated, and scoped to the caller's org.

    Deliberately not a static mount: an insurance certificate carries the
    policy number and the owner's address, and serving these from a public
    directory would make every scan in the fleet world-readable to anyone who
    guessed a name.
    """
    # Reject anything that is not a bare generated filename before it ever
    # reaches the filesystem.
    stem, _, ext = stored_name.rpartition(".")
    if "/" in stored_name or "\\" in stored_name or ext not in MEDIA_TYPES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    try:
        uuid.UUID(stem)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found") from None

    org_dir = _org_dir(user.organization_id).resolve()
    path = (org_dir / stored_name).resolve()
    # Belt and braces: the resolved path must still sit inside the org folder.
    if not path.is_file() or org_dir not in path.parents:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")

    return FileResponse(path, media_type=MEDIA_TYPES[ext], filename=stored_name)
