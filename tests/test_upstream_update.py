import importlib.util
import hashlib
import io
import json
from pathlib import Path
import struct
import tarfile
import unittest
import tempfile
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "update_adguard_home.py"
SPEC = importlib.util.spec_from_file_location("updater", SCRIPT)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)
TAG = "v0.107.79"
URL = f"https://github.com/AdguardTeam/AdGuardHome/releases/download/{TAG}/AdGuardHome_linux_arm64.tar.gz"
SHA = "3f7893c18e8aaadc456d0452839190561c306ca95175a2254958be80a769c1ae"


def stable_release(version=TAG, digest=SHA, prerelease=False):
    return {
        "tag_name": version,
        "draft": False,
        "prerelease": prerelease,
        "assets": [{
            "name": "AdGuardHome_linux_arm64.tar.gz",
            "digest": "sha256:" + digest,
            "browser_download_url": (
                "https://github.com/AdguardTeam/AdGuardHome/releases/download/"
                + version + "/AdGuardHome_linux_arm64.tar.gz"
            ),
        }],
    }


def dummy_arm64():
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", data, 18, 183)
    return bytes(data)


def compressed(member_name, payload, kind=tarfile.REGTYPE):
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode="w:gz") as tar:
        item = tarfile.TarInfo(name=member_name)
        item.type = kind
        item.size = len(payload) if kind == tarfile.REGTYPE else 0
        tar.addfile(item, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
    return target.getvalue()


class UpstreamSafetyTests(unittest.TestCase):
    def test_pinned_release_is_consistent_and_can_move_forward(self):
        pinned = json.loads(updater.LOCK.read_text(encoding="utf-8"))
        version = pinned["version"]
        # A future upstream upgrade MUST NOT fail just because the current
        # stable version has changed. Validate invariant properties instead.
        updater.numeric_version(version)
        self.assertEqual(pinned["channel"], "stable")
        self.assertEqual(pinned["archive"], updater.ASSET_NAME)
        self.assertRegex(pinned["archive_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(
            pinned["source"],
            f"https://github.com/AdguardTeam/AdGuardHome/releases/download/"
            f"{version}/{updater.ASSET_NAME}",
        )
        # The updater records the extracted executable hash on every upgrade.
        # Verify it against Git content, guarding against a modified binary.
        if "binary_sha256" in pinned:
            self.assertEqual(
                hashlib.sha256(updater.BINARY.read_bytes()).hexdigest(),
                pinned["binary_sha256"],
            )

    def test_metadata_from_newer_stable_release_does_not_break_tests(self):
        pinned = {
            "version": "v0.108.0", "channel": "stable",
            "archive": updater.ASSET_NAME,
            "archive_sha256": "a" * 64,
            "source": "https://github.com/AdguardTeam/AdGuardHome/releases/"
                      "download/v0.108.0/AdGuardHome_linux_arm64.tar.gz",
        }
        version, _url, _sha, changed = updater.check_release(
            stable_release(version="v0.109.0"), pinned)
        self.assertEqual(version, "v0.109.0")
        self.assertTrue(changed)

    def test_stable_release_parsed(self):
        self.assertEqual(updater.latest_asset(stable_release()), (TAG, URL, SHA))

    def test_prerelease_never_selected(self):
        with self.assertRaises(ValueError):
            updater.latest_asset(stable_release("v1.0.0", prerelease=True))

    def test_missing_sha256_fails_closed(self):
        with self.assertRaises(ValueError):
            updater.latest_asset(stable_release(digest="bad"))

    def test_asset_url_must_be_exact_official_release(self):
        rel = stable_release()
        rel["assets"][0]["browser_download_url"] = "https://example.org/AdGuardHome_linux_arm64.tar.gz"
        with self.assertRaises(ValueError):
            updater.latest_asset(rel)

    def test_old_version_cannot_downgrade(self):
        self.assertFalse(updater.check_release(
            stable_release(), {"version": "v0.107.80"}
        )[3])
        self.assertTrue(updater.check_release(
            stable_release(version="v0.107.80", digest=SHA),
            {"version": TAG},
        )[3])

    def test_arm64_elf_machine(self):
        updater.verify_arm64(dummy_arm64())
        x = bytearray(dummy_arm64())
        struct.pack_into("<H", x, 18, 62)  # x86_64
        with self.assertRaises(ValueError):
            updater.verify_arm64(bytes(x))

    def test_archive_contains_expected_regular_member(self):
        data = dummy_arm64()
        archive = compressed("AdGuardHome/AdGuardHome", data)
        self.assertEqual(updater.extract_engine(archive), data)

    def test_rejects_symlink_or_unexpected_archive_path(self):
        with self.assertRaises(ValueError):
            updater.extract_engine(compressed("AdGuardHome/AdGuardHome", b"", tarfile.SYMTYPE))
        with self.assertRaises(ValueError):
            updater.extract_engine(compressed("../AdGuardHome", dummy_arm64()))

    def test_failed_download_validation_never_replaces_pinned_binary_or_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'AdGuardHome'
            lock = Path(directory) / 'lock.json'
            binary.write_bytes(b'original-engine')
            saved_lock = json.dumps({'version': TAG})
            lock.write_text(saved_lock)
            release = stable_release(version='v0.107.80', digest='a' * 64)
            def download(url, limit):
                return json.dumps(release).encode() if url == updater.API else b'bad-archive'
            with patch.object(updater, 'BINARY', binary), patch.object(updater, 'LOCK', lock), \
                 patch.object(updater, 'fetch_bytes', download), patch('sys.argv', ['updater', '--update']):
                with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                    updater.main()
            self.assertEqual(binary.read_bytes(), b'original-engine')
            self.assertEqual(lock.read_text(), saved_lock)

    def test_version_pattern_blocks_shell_injection(self):
        for bad in ["v1.0.0-beta", "v1.0.0;echo hello", "v1.0.0\nx=y"]:
            with self.assertRaises(ValueError):
                updater.numeric_version(bad)


if __name__ == "__main__":
    unittest.main()
