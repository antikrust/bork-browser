#!/usr/bin/env python3
"""Sign an unlisted add-on through AMO's API and write the signed xpi out.

Unlisted means AMO's robot signs it without human review, so this returns
with a finished file rather than leaving something in a queue.

Straight against the API rather than through web-ext: web-ext arrives via
`npx`, which fetches and runs a package off npm in the middle of a release.
Everything here is stdlib.

Environment:
  AMO_JWT_ISSUER / AMO_JWT_SECRET   from the AMO API key page
  AMO_ADDON_ID                      the add-on's gecko id
  AMO_ZIP                           packed extension to submit
  AMO_OUT                           where to write the signed xpi
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

API = "https://addons.mozilla.org/api/v5"

# AMO validates in seconds and signs in about a minute. The ceiling stops a
# stuck submission from hanging a release forever.
POLL_SECONDS = 10
POLL_LIMIT = 60


def token() -> str:
    issuer = os.environ["AMO_JWT_ISSUER"]
    secret = os.environ["AMO_JWT_SECRET"]

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


def request(url, method="GET", body=None, content_type=None, allow=()):
    # A fresh token per call: they expire in five minutes and signing can take
    # longer than that.
    headers = {"Authorization": f"JWT {token()}"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        detail = error.read()
        if error.code in allow:
            return error.code, detail
        raise SystemExit(
            f"AMO {method} {url} -> {error.code}\n"
            f"{detail.decode('utf-8', 'replace')[:2000]}"
        ) from None


def json_request(url, method="GET", body=None, allow=()):
    data = json.dumps(body).encode() if body is not None else None
    status, raw = request(
        url, method, data, "application/json" if data else None, allow
    )
    return status, json.loads(raw or b"{}")


def upload(path: str, channel: str = "unlisted") -> str:
    """Send the zip as multipart/form-data; AMO answers with an upload uuid."""
    boundary = f"----bork{uuid.uuid4().hex}"
    with open(path, "rb") as handle:
        blob = handle.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="channel"\r\n\r\n'
        f"{channel}\r\n"
    ).encode()
    body += (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="upload"; '
        f'filename="{os.path.basename(path)}"\r\n'
        f"Content-Type: application/zip\r\n\r\n"
    ).encode() + blob + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    _, raw = request(
        f"{API}/addons/upload/",
        "POST",
        body,
        f"multipart/form-data; boundary={boundary}",
    )
    return json.loads(raw)["uuid"]


def await_validation(upload_uuid: str) -> None:
    for _ in range(POLL_LIMIT):
        _, state = json_request(f"{API}/addons/upload/{upload_uuid}/")
        if state.get("processed"):
            if state.get("valid"):
                return
            validation = state.get("validation") or {}
            for message in (validation.get("messages") or [])[:10]:
                print(f"  {message.get('type')}: {message.get('message')}", file=sys.stderr)
            raise SystemExit("AMO rejected the upload as invalid")
        time.sleep(POLL_SECONDS)
    raise SystemExit("timed out waiting for AMO to validate the upload")


def create_version(addon: str, upload_uuid: str) -> tuple:
    """Add a version to the add-on, registering the add-on first if needed."""
    status, version = json_request(
        f"{API}/addons/addon/{addon}/versions/",
        "POST",
        {"upload": upload_uuid},
        allow=(404,),
    )
    if status != 404:
        return addon, version

    # No such add-on on this account — first submission, or the previous one
    # was deleted. Register it; AMO takes the id from the manifest.
    print("no existing add-on for this id; registering it")
    _, created = json_request(
        f"{API}/addons/addon/", "POST", {"version": {"upload": upload_uuid}}
    )
    return created.get("guid", addon), created.get("version") or created


def await_signature(addon: str, version_id: int) -> str:
    """Wait for the robot to approve, then hand back the signed file's URL."""
    for _ in range(POLL_LIMIT):
        _, version = json_request(f"{API}/addons/addon/{addon}/versions/{version_id}/")
        file_info = version.get("file") or {}
        # "public" is AMO's word for an approved, signed file. Anything else is
        # still being worked on and its download would carry no signature.
        if file_info.get("status") == "public" and file_info.get("url"):
            return file_info["url"]
        time.sleep(POLL_SECONDS)
    raise SystemExit("timed out waiting for AMO to sign the version")


def main() -> int:
    addon = os.environ["AMO_ADDON_ID"]
    zip_path = os.environ["AMO_ZIP"]
    out = os.environ["AMO_OUT"]

    print("uploading to AMO")
    upload_uuid = upload(zip_path)
    print(f"upload {upload_uuid}: validating")
    await_validation(upload_uuid)

    print("creating unlisted version")
    addon, version = create_version(addon, upload_uuid)
    print(f"version {version.get('version')} created: waiting for signature")

    url = await_signature(addon, version["id"])
    _, blob = request(url)
    with open(out, "wb") as handle:
        handle.write(blob)
    print(f"signed: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
