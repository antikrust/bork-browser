#!/usr/bin/env python3
"""Put a version of an add-on on AMO, in either channel.

UNLISTED (the default) is signed by AMO's robot without human review, so it
returns with a finished file rather than leaving something in a queue — which
is what the bundled copies and the site download need.

LISTED is the public catalogue. A human reviews it, which takes however long it
takes, so there is no file to collect and nothing to wait for here: it uploads,
creates the version, sets the listing fields AMO requires before it will show a
page, and reports where in the process it got to.

Straight against the API rather than through web-ext: web-ext arrives via
`npx`, which fetches and runs a package off npm in the middle of a release.
Everything here is stdlib.

Environment:
  AMO_JWT_ISSUER / AMO_JWT_SECRET   from the AMO API key page
  AMO_ADDON_ID                      the add-on's gecko id
  AMO_ZIP                           packed extension to submit
  AMO_OUT                           where to write the signed xpi (unlisted)
  AMO_CHANNEL                       "unlisted" (default) or "listed"
  AMO_SUMMARY / AMO_CATEGORY        listed only: the catalogue page's fields
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


def create_version(addon: str, upload_uuid: str, body: dict) -> tuple:
    """Add a version to the add-on, registering the add-on first if needed."""
    status, version = json_request(
        f"{API}/addons/addon/{addon}/versions/",
        "POST",
        dict(body, upload=upload_uuid),
        allow=(404,),
    )
    if status != 404:
        return addon, version

    # No such add-on on this account — first submission, or the previous one
    # was deleted. Register it; AMO takes the id from the manifest.
    print("no existing add-on for this id; registering it")
    _, created = json_request(
        f"{API}/addons/addon/",
        "POST",
        {"version": dict(body, upload=upload_uuid)},
    )
    return created.get("guid", addon), created.get("version") or created


def next_listed_version(addon: str) -> str:
    """The version number the next catalogue submission should carry.

    AMO version numbers are unique per add-on across BOTH channels, so the
    public listing can never reuse one the self-hosted channel has spent — and
    the self-hosted one is bumped several times a day. Rather than reserving
    numbers by hand and finding out by 409, the catalogue keeps a line of its
    own starting at 1.0.0, which the self-hosted 0.x line cannot run into.

    Asked of AMO rather than kept in the repo: AMO is the only thing that knows
    what has actually been submitted.
    """
    # all_with_unlisted, because the plain listing leaves out anything not yet
    # approved — and a version waiting in the review queue is exactly the one
    # whose number must not be handed out again. Without it this returns a
    # number AMO already holds and the submission dies on a 409.
    status, page = json_request(
        f"{API}/addons/addon/{addon}/versions/"
        f"?page_size=50&filter=all_with_unlisted",
        allow=(400, 404),
    )
    highest = (1, 0, -1)
    if status != 404:
        for item in page.get("results") or []:
            parts = str(item.get("version", "")).split(".")
            try:
                numbers = tuple(int(part) for part in parts)
            except ValueError:
                continue
            # Only the catalogue's own line. The self-hosted 0.x versions come
            # back here too and must not drag the number backwards.
            if len(numbers) == 3 and numbers[0] >= 1 and numbers > highest:
                highest = numbers
    return f"{highest[0]}.{highest[1]}.{highest[2] + 1}"


def describe(addon: str) -> None:
    """Fill in what AMO insists on before it will show a catalogue page.

    Only the fields that are required, and only from what the manifest and the
    release already say — a listing page is public writing in someone's name,
    so nothing here is invented for it.
    """
    fields = {}
    # The catalogue name is held by AMO, not read from the manifest: it was
    # taken from whatever the first submission said and stays there until it is
    # written over. Renaming the extension does not rename the page.
    name = os.environ.get("AMO_NAME")
    summary = os.environ.get("AMO_SUMMARY")
    category = os.environ.get("AMO_CATEGORY")
    if name:
        fields["name"] = {"en-US": name}
    if summary:
        fields["summary"] = {"en-US": summary}
    if category:
        fields["categories"] = [category]
    if not fields:
        return

    # Only write what would actually change. Every later submission would
    # otherwise re-send the same name and summary it sent last time, and AMO
    # rate-limits writes hard enough that this one pointless call is what
    # blocks the submission behind it.
    status, current = json_request(f"{API}/addons/addon/{addon}/", allow=(404,))
    if status == 200:
        same = True
        for key, value in fields.items():
            held = current.get(key)
            if isinstance(value, dict):
                same = same and (held or {}).get("en-US") == value["en-US"]
            else:
                # Categories come back as a list, in whatever order AMO likes.
                same = same and sorted(held or []) == sorted(value)
        if same:
            print("listing fields already set: leaving them alone")
            return

    status, answer = json_request(
        f"{API}/addons/addon/{addon}/", "PATCH", fields, allow=(400,)
    )
    if status == 400:
        raise SystemExit(
            f"AMO would not take the listing fields: {json.dumps(answer)[:600]}\n"
            "Set them on the Developer Hub page and run this again."
        )
    print(f"listing fields set: {', '.join(sorted(fields))}")


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
    channel = os.environ.get("AMO_CHANNEL", "unlisted")

    # Asked for before the extension is packed, because the answer goes inside
    # the zip.
    if os.environ.get("AMO_MODE") == "next-listed-version":
        print(next_listed_version(addon))
        return 0

    zip_path = os.environ["AMO_ZIP"]

    print("uploading to AMO")
    upload_uuid = upload(zip_path, channel)
    print(f"upload {upload_uuid}: validating")
    await_validation(upload_uuid)

    body = {}
    if channel == "listed":
        # Before the version, not after: AMO refuses to create a listed version
        # at all until the add-on has the fields its catalogue page needs.
        describe(addon)
        body["license"] = os.environ.get("AMO_LICENSE", "MPL-2.0")

    print(f"creating {channel} version")
    addon, version = create_version(addon, upload_uuid, body)
    print(f"version {version.get('version')} created")

    if channel == "listed":
        print(
            "submitted for review. Nothing else happens here: a person at "
            "Mozilla looks at it, and the catalogue page appears when they "
            f"approve it.\nhttps://addons.mozilla.org/developers/addon/{addon}/versions"
        )
        return 0

    out = os.environ["AMO_OUT"]
    print("waiting for signature")
    url = await_signature(addon, version["id"])
    _, blob = request(url)
    with open(out, "wb") as handle:
        handle.write(blob)
    print(f"signed: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
