"""LR (consignment note) number generation.

Requirements this satisfies:
  * Unique within an organization, forever.
  * Never reused — a repeated LR number makes two shipments indistinguishable
    in a dispute, which is the whole point of the document.
  * Human-readable and sortable: ``VT/2026-27/000001``.
  * Restarts each Indian financial year (1 April – 31 March), which is what
    transporters and auditors expect.

Concurrency: the counter row is locked with ``SELECT … FOR UPDATE`` inside the
booking transaction, so two dispatchers booking simultaneously cannot receive
the same number. A plain "max(lr_number) + 1" would race.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.consignment import Consignment, LrCounter


def financial_year(on: date | None = None) -> tuple[int, str]:
    """Indian FY containing `on`. Returns (start_year, label) e.g. (2026, "2026-27")."""
    d = on or datetime.now(timezone.utc).date()
    start = d.year if d.month >= 4 else d.year - 1
    return start, f"{start}-{str(start + 1)[-2:]}"


def org_prefix(organization_name: str) -> str:
    """Initials of the organization, e.g. "Vediya Transport" -> "VT"."""
    words = re.findall(r"[A-Za-z]+", organization_name)
    letters = "".join(w[0] for w in words[:3]).upper()
    return letters or "LR"


async def next_lr_number(
    db: AsyncSession, organization_id, organization_name: str
) -> str:
    """Allocate the next LR number. Must be called inside a transaction."""
    year, label = financial_year()

    row = await db.execute(
        select(LrCounter)
        .where(
            LrCounter.organization_id == organization_id,
            LrCounter.year == year,
        )
        .with_for_update()
    )
    counter = row.scalar_one_or_none()

    if counter is None:
        counter = LrCounter(organization_id=organization_id, year=year, last_value=0)
        db.add(counter)
        await db.flush()
        # Re-select with the lock held so a concurrent inserter cannot slip past.
        row = await db.execute(
            select(LrCounter)
            .where(
                LrCounter.organization_id == organization_id,
                LrCounter.year == year,
            )
            .with_for_update()
        )
        counter = row.scalar_one()

    prefix = org_prefix(organization_name)

    # Step over numbers already taken by hand. A transporter who keys in
    # "VT/2026-27/000042" from a pre-printed book does not advance the counter,
    # so the counter will eventually walk into that number — and the unique
    # constraint would turn an ordinary booking into a 500. Skipping is the
    # only correct resolution: an LR number is never reused.
    while True:
        counter.last_value += 1
        candidate = f"{prefix}/{label}/{counter.last_value:06d}"
        if await is_lr_available(db, organization_id, candidate):
            break

    await db.flush()
    return candidate


async def reserve_manual_lr(
    db: AsyncSession, organization_id, organization_name: str, lr_number: str
) -> None:
    """Pull the counter up past a hand-entered number in our own format.

    Without this the counter keeps issuing numbers below the ones already
    written in the operator's LR book, so every future booking has to skip over
    them one at a time and the two sequences stay tangled forever.
    """
    year, label = financial_year()
    prefix = org_prefix(organization_name)

    match = re.fullmatch(rf"{re.escape(prefix)}/{re.escape(label)}/(\d+)", lr_number.strip())
    if not match:
        return  # A number in someone else's format; our sequence is unaffected.

    value = int(match.group(1))
    row = await db.execute(
        select(LrCounter)
        .where(
            LrCounter.organization_id == organization_id,
            LrCounter.year == year,
        )
        .with_for_update()
    )
    counter = row.scalar_one_or_none()
    if counter is None:
        db.add(LrCounter(organization_id=organization_id, year=year, last_value=value))
    elif value > counter.last_value:
        counter.last_value = value
    await db.flush()


async def is_lr_available(db: AsyncSession, organization_id, lr_number: str) -> bool:
    """Whether a manually-entered LR number is free.

    Offered because some transporters carry their own pre-printed LR books and
    need to key in the book's number rather than accept a generated one.
    """
    result = await db.execute(
        select(Consignment.id).where(
            Consignment.organization_id == organization_id,
            Consignment.lr_number == lr_number.strip(),
        )
    )
    return result.scalar_one_or_none() is None


async def suggest_lr_numbers(
    db: AsyncSession, organization_id, organization_name: str, count: int = 3
) -> list[str]:
    """Peek at the next N numbers without consuming them.

    Read-only on purpose: the UI shows these as a preview while the operator
    is still filling the form, and abandoning a half-filled form must not burn
    an LR number.
    """
    year, label = financial_year()
    result = await db.execute(
        select(LrCounter.last_value).where(
            LrCounter.organization_id == organization_id,
            LrCounter.year == year,
        )
    )
    last = result.scalar_one_or_none() or 0
    prefix = org_prefix(organization_name)

    # Skip numbers already taken by hand, exactly as next_lr_number() will —
    # otherwise the preview promises a number the booking then does not use.
    out: list[str] = []
    candidate = last
    while len(out) < count:
        candidate += 1
        number = f"{prefix}/{label}/{candidate:06d}"
        if await is_lr_available(db, organization_id, number):
            out.append(number)
    return out
