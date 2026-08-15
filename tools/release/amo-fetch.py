#!/usr/bin/env python3
"""Download the newest approved signed xpi for an add-on from AMO.

Used by sign-extension.sh --fetch, once a listed version has cleared review.
Credentials come from the environment (AMO_JWT_ISSUER / AMO_JWT_SECRET); AMO
authenticates with a short-lived JWT the caller signs itself, so there is no
login and no password anywhere in this pipeline.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request
import uuid

API = "https://addons.mozilla.org/api/v5"


def token(issuer: str, secret: str) -> str:
    def part(data: bytes) -> bytes:
        return base64.urlsafe_b64encode(data).rstrip(b"=")

    header = part(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = part(
        json.dumps(
            {"iss": issuer, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 300}
        ).encode()
    )
    signature = part(
        hmac.new(secret.encode(), header + b"." + payload, hashlib.sha256).digest()
    )
    return (header + b"." + payload + b"." + signature).decode()


def get(url: str, auth: str) -> bytes:
    request = urllib.request.Request(url, headers={"Authorization": f"JWT {auth}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> int:
    addon = os.environ.get("AMO_ADDON_ID")
    out = os.environ.get("AMO_OUT")
    issuer = os.environ.get("AMO_JWT_ISSUER")
    secret = os.environ.get("AMO_JWT_SECRET")
    if not (addon and out and issuer and secret):
        print("AMO_ADDON_ID, AMO_OUT, AMO_JWT_ISSUER, AMO_JWT_SECRET required", file=sys.stderr)
        return 2

    auth = token(issuer, secret)
    versions = json.loads(
        get(f"{API}/addons/addon/{addon}/versions/?filter=all_with_unlisted", auth)
    ).get("results", [])

    # "public" is AMO's word for a reviewed, approved file. Anything else is
    # still in the queue and its download would not be signed.
    approved = [
        version
        for version in versions
        if (version.get("file") or {}).get("status") == "public"
        and (version.get("file") or {}).get("url")
    ]
    if not approved:
        pending = ", ".join(
            f"{v.get('version')} ({(v.get('file') or {}).get('status')})"
            for v in versions[:5]
        )
        print(f"no approved version yet — {pending or 'nothing submitted'}", file=sys.stderr)
        return 1

    newest = approved[0]
    print(f"fetching {newest['version']} ({newest.get('channel')})")
    with open(out, "wb") as handle:
        handle.write(get(newest["file"]["url"], auth))
    return 0


if __name__ == "__main__":
    sys.exit(main())
