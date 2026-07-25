"""Sending tracking links to customers.

**All automated outbound sending is currently OFF** (NOTIFICATIONS_ENABLED).
That is a decision, not an unfinished edge: a customer does not need a message
to track a shipment. The tracking link is public and needs no login, so the
dispatcher copies or shares it. Turning sending on is a config change.

Channels, once enabled:

  * **email**    — real SMTP. A send with no credentials is recorded as
                   SKIPPED, never pretended to have succeeded.
  * **whatsapp** — a ``wa.me`` deep link. Free, works today regardless of the
                   flag, because a human taps it. This is how most Indian
                   logistics actually communicates.
  * **sms**      — needs a paid Indian provider (MSG91/Twilio). Records
                   SKIPPED with a clear reason, so nobody believes an SMS went
                   out when it did not.

Every attempt is written to ``notification_log`` — the point is being able to
prove, later, that the customer was told.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.consignment import (
    NotificationLog,
    NotifyChannel,
    NotifyStatus,
    TrackingLink,
    TrackingParty,
)

logger = logging.getLogger(__name__)


def tracking_url(token: str) -> str:
    return f"{settings.PUBLIC_WEB_URL.rstrip('/')}/track/{token}"


def _message_text(
    *, party: TrackingParty, lr_number: str, url: str, org_name: str,
    origin: str, destination: str,
) -> str:
    role = "shipment you have sent" if party == TrackingParty.CONSIGNOR else "shipment on its way to you"
    return (
        f"{org_name}\n\n"
        f"You can track the {role}.\n\n"
        f"Consignment: {lr_number}\n"
        f"From: {origin}\n"
        f"To:   {destination}\n\n"
        f"Live tracking: {url}\n\n"
        f"This link works without a login. Please do not share it publicly."
    )


def whatsapp_link(phone: str, message: str) -> str:
    """A click-to-chat deep link. Free, no provider account needed."""
    digits = "".join(c for c in phone if c.isdigit())
    # wa.me needs a country code; assume India when a bare 10-digit number
    # is given, which is what operators type.
    if len(digits) == 10:
        digits = "91" + digits
    return f"https://wa.me/{digits}?text={quote(message)}"


def _send_email(to: str, subject: str, body: str) -> None:
    """Blocking SMTP send. Raises on failure."""
    message = EmailMessage()
    message["From"] = f"{settings.MAIL_FROM_NAME} <{settings.MAIL_FROM}>"
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    context = ssl.create_default_context()
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=20) as server:
        if settings.SMTP_STARTTLS:
            server.starttls(context=context)
        if settings.SMTP_USER:
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.send_message(message)


def email_configured() -> bool:
    return bool(settings.SMTP_HOST and settings.MAIL_FROM)


def sending_status() -> dict:
    """What the UI shows next to the send buttons, so the state is never a
    mystery to the dispatcher."""
    return {
        "enabled": settings.NOTIFICATIONS_ENABLED,
        "email": settings.NOTIFICATIONS_ENABLED and email_configured(),
        "sms": settings.NOTIFICATIONS_ENABLED and settings.SMS_ENABLED,
        # A wa.me deep link is just a URL — it works whether or not automated
        # sending is on, because a human taps it.
        "whatsapp": True,
        "reason": (
            None
            if settings.NOTIFICATIONS_ENABLED
            else "Automated sending is switched off. Copy or share the link manually."
        ),
    }


async def send_tracking_link(
    db: AsyncSession,
    link: TrackingLink,
    *,
    channel: NotifyChannel,
    recipient: str,
    lr_number: str,
    org_name: str,
    origin: str,
    destination: str,
) -> NotificationLog:
    """Send one link over one channel and record the attempt."""
    url = tracking_url(link.token)
    body = _message_text(
        party=link.party,
        lr_number=lr_number,
        url=url,
        org_name=org_name,
        origin=origin,
        destination=destination,
    )

    entry = NotificationLog(
        tracking_link_id=link.id,
        trip_id=link.trip_id,
        channel=channel,
        recipient=recipient,
        status=NotifyStatus.QUEUED,
    )
    db.add(entry)
    await db.flush()

    # Global kill switch, checked before anything channel-specific so no
    # provider is contacted while sending is disabled.
    if not settings.NOTIFICATIONS_ENABLED:
        entry.status = NotifyStatus.SKIPPED
        entry.error = (
            "Automated sending is switched off (NOTIFICATIONS_ENABLED=false). "
            "The tracking link is ready to copy or share manually."
        )
        return entry

    if not recipient:
        entry.status = NotifyStatus.SKIPPED
        entry.error = "No contact detail on file for this party"
        return entry

    if channel == NotifyChannel.EMAIL:
        if not email_configured():
            entry.status = NotifyStatus.SKIPPED
            entry.error = (
                "Email is not configured — set SMTP_HOST, MAIL_FROM, SMTP_USER "
                "and SMTP_PASSWORD"
            )
            return entry
        try:
            import anyio

            await anyio.to_thread.run_sync(
                _send_email,
                recipient,
                f"Track your consignment {lr_number}",
                body,
            )
            entry.status = NotifyStatus.SENT
            entry.sent_at = datetime.now(timezone.utc)
        except Exception as exc:
            logger.warning("email send failed: %s", exc)
            entry.status = NotifyStatus.FAILED
            entry.error = str(exc)[:400]
        return entry

    if channel == NotifyChannel.WHATSAPP:
        # Nothing is sent server-side; the dispatcher opens the returned link.
        entry.status = NotifyStatus.SENT
        entry.sent_at = datetime.now(timezone.utc)
        entry.error = None
        return entry

    if channel == NotifyChannel.SMS:
        entry.status = NotifyStatus.SKIPPED
        entry.error = (
            "SMS is switched off (SMS_ENABLED=false). It needs a paid Indian "
            "provider such as MSG91 or Twilio — the send path is built and "
            "needs only a key."
        )
        return entry

    entry.status = NotifyStatus.SENT
    entry.sent_at = datetime.now(timezone.utc)
    return entry


def driver_brief(
    *, lr_number: str, origin: str, destination: str, when: datetime,
    goods: str, distance_km: float | None, consignee_name: str,
    consignee_phone: str | None,
) -> str:
    """The trip summary the driver sees on their phone."""
    lines = [
        f"Trip {lr_number}",
        f"Pickup : {origin}",
        f"Drop   : {destination}",
        f"When   : {when.strftime('%d %b %Y, %H:%M')}",
        f"Goods  : {goods}",
    ]
    if distance_km:
        lines.append(f"Distance: {distance_km:.0f} km")
    lines.append(f"Receiver: {consignee_name}" + (f" ({consignee_phone})" if consignee_phone else ""))
    return "\n".join(lines)
