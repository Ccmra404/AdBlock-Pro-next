#!/usr/bin/env python3
"""Pin the latest stable AdGuard Home ARM64 engine from official GitHub releases.

This script changes repository files only in --update mode. It never
installs, upgrades or restarts AdGuard Home on a user's phone.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "upstream" / "adguard-home.json"
BINARY = ROOT / "bin" / "AdGuardHome"
API = "https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest"
ASSET_NAME = "AdGuardHome_linux_arm64.tar.gz"
VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_BINARY = 100 * 1024 * 1024


def numeric_version(value: str) -> tuple[int, int, int]:
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError("not a stable upstream version: " + value)
    return tuple(int(n) for n in match.groups())


def latest_asset(release: dict) -> tuple[str, str, str]:
    version = str(release.get("tag_name", ""))
    numeric_version(version)
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("refusing draft or prerelease")
    assets = [a for a in release.get("assets", []) if a.get("name") == ASSET_NAME]
    if len(assets) != 1:
        raise ValueError("missing or ambiguous official ARM64 release archive")
    asset = assets[0]
    digest = str(asset.get("digest") or "")
    if not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest):
        raise ValueError("official release asset has no trustworthy SHA256 digest")
    url = str(asset.get("browser_download_url") or "")
    expected_url = (
        f"https://github.com/AdguardTeam/AdGuardHome/releases/download/{version}/{ASSET_NAME}"
    )
    if url != expected_url:
        raise ValueError("unexpected upstream asset URL")
    return version, url, digest.split(":", 1)[1].lower()


def fetch_bytes(url: str, max_bytes: int) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json" if url == API else "application/octet-stream",
            "User-Agent": "AdBlock-Pro-Upstream-Checker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    token = os.environ.get("GH_TOKEN")
    if token and url == API:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("upstream asset exceeds allowed size")
    return data


def verify_arm64(binary: bytes) -> None:
    # ELF64, little endian, e_machine = EM_AARCH64 (183).
    if (
        len(binary) < 64
        or binary[:4] != b"\x7fELF"
        or binary[4] != 2
        or binary[5] != 1
        or struct.unpack_from("<H", binary, 18)[0] != 183
    ):
        raise ValueError("downloaded payload is not a Linux ARM64 ELF binary")


def extract_engine(archive: bytes) -> bytes:
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf:
        members = [
            member for member in tf.getmembers()
            if member.name == "AdGuardHome/AdGuardHome"
        ]
        if len(members) != 1 or not members[0].isfile():
            raise ValueError("invalid AdGuard Home archive layout")
        member = members[0]
        if member.size < 1 or member.size > MAX_BINARY:
            raise ValueError("engine binary size is not acceptable")
        stream = tf.extractfile(member)
        if stream is None:
            raise ValueError("archive engine is unreadable")
        data = stream.read(MAX_BINARY + 1)
        if len(data) != member.size:
            raise ValueError("engine binary is truncated or oversized")
        verify_arm64(data)
        return data


def check_release(release: dict, pinned: dict) -> tuple[str, str, str, bool]:
    version, url, digest = latest_asset(release)
    current = str(pinned["version"])
    needs_update = numeric_version(version) > numeric_version(current)
    return version, url, digest, needs_update


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--check", action="store_true", help="output GitHub Actions decisions")
    cli.add_argument("--update", action="store_true", help="download and verify new stable binary")
    args = cli.parse_args()
    if args.check == args.update:
        cli.error("choose exactly one of --check and --update")
    pinned = json.loads(LOCK.read_text(encoding="utf-8"))
    release = json.loads(fetch_bytes(API, 2 * 1024 * 1024))
    version, url, digest, changed = check_release(release, pinned)
    if args.check:
        print("upstream_version=" + version)
        print("current_version=" + str(pinned["version"]))
        print("update_required=" + str(changed).lower())
        return
    if not changed:
        print("Already pinned to the latest upstream stable release:", pinned["version"])
        return
    archive = fetch_bytes(url, MAX_ARCHIVE)
    actual_digest = hashlib.sha256(archive).hexdigest()
    if actual_digest != digest:
        raise ValueError("upstream archive SHA256 mismatch")
    binary = extract_engine(archive)
    # Changes are staged as ordinary Git files. CI must still execute --version,
    # --check-config and module tests before proposing this update.
    with tempfile.NamedTemporaryFile(dir=BINARY.parent, prefix=".agh-new-", delete=False) as f:
        temp_binary = Path(f.name)
        f.write(binary)
    try:
        temp_binary.chmod(0o755)
        os.replace(temp_binary, BINARY)
    finally:
        temp_binary.unlink(missing_ok=True)
    new_lock = {
        "version": version,
        "channel": "stable",
        "archive": ASSET_NAME,
        "archive_sha256": digest,
        "binary_sha256": hashlib.sha256(binary).hexdigest(),
        "source": url,
    }
    LOCK.write_text(json.dumps(new_lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated the repository engine from {pinned['version']} to {version}")


if __name__ == "__main__":
    main()
