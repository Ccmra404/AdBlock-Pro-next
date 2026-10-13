import importlib.util
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "guard", Path(__file__).resolve().parents[1] / "tools/release_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
SHA = "a" * 40


class ReleaseGuardTests(unittest.TestCase):
    def fetch(self, path):
        if path.endswith("heads/main"):
            return {"object": {"sha": SHA}}
        return None

    def test_new_tag_on_current_main_is_allowed(self):
        guard.check_release("Ccmra404/AdBlock-Pro-next", "v0.13.1", SHA, self.fetch)

    def test_existing_release_or_tag_is_rejected(self):
        for fragment in ["releases/tags/", "git/ref/tags/"]:
            def fetch(path):
                return {} if fragment in path else self.fetch(path)
            with self.subTest(fragment=fragment), self.assertRaises(ValueError):
                guard.check_release("Ccmra404/AdBlock-Pro-next", "v0.13.1", SHA, fetch)

    def test_obsolete_main_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "current main"):
            guard.check_release("Ccmra404/AdBlock-Pro-next", "v0.13.1", "b" * 40, self.fetch)

    def test_api_errors_do_not_mean_tag_absent(self):
        for code in [401, 403, 429, 500]:
            with self.subTest(code=code), patch.dict("os.environ", {"GH_TOKEN": "fixture-only"}), \
                 patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("test", code, "error", {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    guard.get_json("repos/Ccmra404/AdBlock-Pro-next/git/ref/tags/v0.13.1")

    def test_only_404_means_absent(self):
        with patch.dict("os.environ", {"GH_TOKEN": "fixture-only"}), \
             patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("test", 404, "missing", {}, None)):
            self.assertIsNone(guard.get_json("repos/Ccmra404/AdBlock-Pro-next/git/ref/tags/v0.13.1"))

    def test_invalid_versions_are_rejected(self):
        for tag in ["v0.13.1-dev.abc1234", "v0.13.1\nx=y", "v0.13.1;echo bad"]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                guard.check_release("Ccmra404/AdBlock-Pro-next", tag, SHA, self.fetch)
