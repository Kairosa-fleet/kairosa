#!/usr/bin/env python
"""Add one fully-documented vehicle, with a generated PDF per document.

Exists so the vehicle screen can be demonstrated end to end — number, expiry
and an openable scan on every mandatory document — without anyone having to
find four real certificates to upload.

    python scripts/add_demo_vehicle.py

The PDFs are written by hand rather than with a library: a valid one-page PDF
is a few hundred bytes, and this avoids adding a reporting dependency to a
backend that has no other use for one.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta

BASE = "http://127.0.0.1:8000"
EMAIL = "pritam@example.com"
PASSWORD = "correct-horse-battery-1"


def build_pdf(title: str, lines: list[str]) -> bytes:
    """A single-page PDF with a heading and some body lines.

    Offsets in the cross-reference table have to be byte-exact, so the file is
    assembled first and the table computed from the real positions.
    """
    def esc(text: str) -> str:
        return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    content = ["BT", "/F1 18 Tf", "60 780 Td", f"({esc(title)}) Tj", "ET"]
    y = 740
    for line in lines:
        content += ["BT", "/F1 11 Tf", f"60 {y} Td", f"({esc(line)}) Tj", "ET"]
        y -= 18  # 11pt line with 7pt leading
    stream = "\n".join(content).encode()

    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj".encode() + body + b"endobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref_at}\n".encode()
    )
    out += b"%%EOF\n"
    return bytes(out)


def call(method: str, path: str, token: str | None, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"\n{method} {path} -> {exc.code}\n{exc.read().decode()[:500]}") from exc


def upload(token: str, filename: str, payload: bytes) -> dict:
    """Multipart upload, hand-rolled to keep this script dependency-free."""
    boundary = f"----{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{BASE}/v1/documents",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"\nupload {filename} -> {exc.code}\n{exc.read().decode()[:400]}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registration", default="RJ14GA5623")
    args = parser.parse_args()

    reg = args.registration
    today = date.today()

    tokens = call("POST", "/v1/auth/login", None, {"email": EMAIL, "password": PASSWORD})
    token = tokens["accessToken"]

    # Deliberately staggered expiries: one document inside the 30-day warning
    # window so the compliance dashboard has something real to show.
    specs = [
        ("rc", "Registration Certificate", "RJ14 20219876543", None,
         ["Owner: Vediya Transport", "Class: Goods Carrier (HGV)", "Fuel: Diesel"]),
        ("insurance", "Certificate of Insurance", "POL/2026/8891234", today + timedelta(days=245),
         ["Insurer: National Insurance Co. Ltd.", "Cover: Comprehensive", "IDV: Rs 12,40,000"]),
        ("puc", "Pollution Under Control Certificate", "PUC-RJ-2026-44821", today + timedelta(days=21),
         ["Centre: Sitapura Emission Test Centre", "Result: PASS"]),
        ("fitness", "Certificate of Fitness", "FIT/RJ14/2026/771", today + timedelta(days=310),
         ["Issued by: RTO Jaipur (RJ14)", "Result: FIT FOR SERVICE"]),
    ]

    documents = []
    for doc_type, title, number, expires, extra in specs:
        lines = [
            f"Vehicle registration : {reg}",
            f"Document number      : {number}",
            f"Issued on            : {today - timedelta(days=40)}",
            f"Valid until          : {expires or 'Not applicable'}",
            "",
        ] + extra + [
            "",
            "SPECIMEN — generated demo document, not a real certificate.",
        ]
        pdf = build_pdf(title, lines)
        stored = upload(token, f"{reg}-{doc_type}.pdf", pdf)
        print(f"  uploaded {stored['fileName']:<28} {stored['sizeBytes']:>5} bytes")
        documents.append(
            {
                "docType": doc_type,
                "number": number,
                "expiresOn": expires.isoformat() if expires else None,
                "fileUrl": stored["fileUrl"],
                "fileName": stored["fileName"],
            }
        )

    vehicle = call("POST", "/v1/vehicles", token, {
        "registrationNumber": reg,
        "displayName": "Tata LPT 1618",
        "vehicleType": "truck",
        "make": "Tata",
        "model": "LPT 1618 Cowl",
        "manufactureYear": 2021,
        "bodyType": "Closed container",
        "capacityKg": 16000,
        "chassisNumber": "MAT448099N2K21345",
        "engineNumber": "697TC58MJZ998211",
        "fuelType": "Diesel",
        "documents": documents,
    })

    print(f"\n  vehicle {vehicle['registrationNumber']} — {vehicle['displayName']}")
    for doc in vehicle["documents"]:
        print(f"    {doc['docType']:<10} {doc['number']:<22} scan: {doc.get('fileUrl')}")


if __name__ == "__main__":
    sys.exit(main())
