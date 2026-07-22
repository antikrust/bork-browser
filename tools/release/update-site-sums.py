#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Refresh the download page's per-file sizes and sha256 sums from dist/.

The page states a sha256 next to every download so people can verify what
they fetched. Those are only true of one build, so without this step every
release silently republishes the previous build's sums and the check fails
for anyone who runs it. Called by production-build.sh before the page is
uploaded.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE = ROOT / "tools" / "release" / "site" / "index.html"
ARTIFACTS = [
    "macos/Derp-macOS-universal.dmg",
    "linux/Derp-linux-x86_64.tar.gz",
    "windows/Derp-windows-x86_64.zip",
]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    html = PAGE.read_text()
    updated = []
    for rel in ARTIFACTS:
        path = ROOT / "dist" / rel
        if not path.exists():
            print(f"[site-sums] skipping absent {rel}")
            continue
        name = path.name
        size_mb = round(path.stat().st_size / 1_000_000)
        # Rewrite only inside this file's own <a class="dl"> block, so the
        # three downloads cannot pick up each other's values.
        block = re.compile(
            r'(<a class="dl" href="downloads/' + re.escape(name) + r'">)(.*?)(</a>)',
            re.DOTALL,
        )
        match = block.search(html)
        if not match:
            print(f"[site-sums] no page block for {name}", file=sys.stderr)
            return 1
        body = match.group(2)
        body = re.sub(r"·\s*[\d.]+\s*MB", f"· {size_mb} MB", body)
        body = re.sub(r"sha256\s+[0-9a-f]{64}", f"sha256 {sha256(path)}", body)
        html = html[: match.start(2)] + body + html[match.end(2) :]
        updated.append(f"{name} ({size_mb} MB)")

    PAGE.write_text(html)
    print("[site-sums] refreshed: " + ", ".join(updated) if updated else
          "[site-sums] nothing to update")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
