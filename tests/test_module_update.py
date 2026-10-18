import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'module_update', Path(__file__).resolve().parents[1] / 'tools/module_update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class ModuleUpdateTests(unittest.TestCase):
    def props(self, **overrides):
        values = dict(id='bindhosts_personal', version='v0.13.2', versionCode='48', updateJson=updater.UPDATE_URL)
        values.update(overrides)
        return '\n'.join(key + '=' + value for key, value in values.items())

    def test_stable_manifest_uses_integer_version_and_exact_release_assets(self):
        result = updater.build_manifest(self.props(), 'v0.13.2')
        self.assertEqual(set(result), {'version', 'versionCode', 'zipUrl', 'changelog'})
        self.assertEqual(result['version'], 'v0.13.2')
        self.assertIs(type(result['versionCode']), int)
        self.assertEqual(result['versionCode'], 48)
        base = 'https://github.com/Ccmra404/AdBlock-Pro-next/releases/download/v0.13.2/'
        self.assertEqual(result['zipUrl'], base + 'AdBlock-Pro-v0.13.2-arm64.zip')
        self.assertEqual(result['changelog'], base + 'changelog.md')

    def test_unpublished_and_mismatched_versions_are_rejected(self):
        for tag in ['v0.13.2-dev.abcdef0', 'v0.13.2-rc.1', 'v0.13.1', 'v0.13.2/other']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                updater.build_manifest(self.props(), tag)

    def test_invalid_version_code_or_module_identity_is_rejected(self):
        for props in [dict(versionCode=code) for code in ['', '-1', '0', '48.0', '2147483648', '4\n8']] + [
                dict(id='other_module'), dict(updateJson='https://example.org/update.json')]:
            with self.subTest(props=props), self.assertRaises(ValueError):
                updater.build_manifest(self.props(**props), 'v0.13.2')

    def test_installer_and_generator_share_the_update_endpoint(self):
        props = (Path(__file__).resolve().parents[1] / 'module.prop').read_text(encoding='utf-8')
        self.assertIn('updateJson=' + updater.UPDATE_URL, props.splitlines())
