import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    'validator', Path(__file__).resolve().parents[1] / 'tools/validate_module_zip.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
VERSION = 'v0.13.0-rc.3-dev.abcdef0'


class ModuleZipTests(unittest.TestCase):
    def fixture(self, extra=None, missing='', arm=True, version=VERSION, corrupt_ca=False,
                update_url='https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest/download/update.json'):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        target = Path(folder.name) / 'candidate.zip'
        with zipfile.ZipFile(target, 'w') as archive:
            for name in sorted(validator.REQUIRED - {missing}):
                info = zipfile.ZipInfo(name)
                info.external_attr = 0o100755 << 16
                data = b'fixture'
                if name == 'module.prop':
                    props = f'id=bindhosts_personal\nversion={version}\nversionCode=45\n'
                    if update_url is not None:
                        props += 'updateJson=' + update_url + '\n'
                    data = props.encode()
                if name == 'certs/cacert.pem':
                    data = b'broken' if corrupt_ca else (Path(__file__).resolve().parents[1] / name).read_bytes()
                if name in ['bin/AdGuardHome', 'bin/adblock-bootstrap', 'bin/curl']:
                    data = bytearray(64)
                    data[:6] = b'\x7fELF\x02\x01'
                    struct.pack_into('<H', data, 18, 183 if arm else 62)
                archive.writestr(info, data)
            if extra:
                archive.writestr(extra, b'fixture-only')
        return target

    def test_complete_arm64_candidate(self):
        validator.validate(self.fixture(), VERSION, 45)

    def test_credentials_and_unsafe_paths_are_rejected(self):
        for name in ['admin.auth', 'bin/AdGuardHome.yaml', 'config/api.auth', '../other']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validator.validate(self.fixture(extra=name), VERSION, 45)

    def test_missing_compat_layer_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing installer'):
            validator.validate(self.fixture(missing='scripts/compat.sh'), VERSION, 45)

    def test_missing_upstream_notices_are_rejected(self):
        for name in ['THIRD_PARTY_NOTICES.md', 'licenses/AWAvenue-GPL-3.0.txt',
                     'licenses/curl-COPYING.txt', 'licenses/openssl-LICENSE.txt', 'licenses/cacert-MPL-2.0.txt']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'missing installer'):
                validator.validate(self.fixture(missing=name), VERSION, 45)

    def test_missing_or_modified_ca_bundle_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing installer'):
            validator.validate(self.fixture(missing='certs/cacert.pem'), VERSION, 45)
        with self.assertRaisesRegex(ValueError, 'certificate bundle checksum'):
            validator.validate(self.fixture(corrupt_ca=True), VERSION, 45)

    def test_missing_or_unexpected_update_endpoint_is_rejected(self):
        for url in [None, 'http://example.org/update.json', 'https://example.org/update.json']:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'Root-manager update URL'):
                validator.validate(self.fixture(update_url=url), VERSION, 45)

    def test_wrong_cpu_or_unmarked_test_version_is_rejected(self):
        for options in [{'arm': False}, {'version': 'v0.13.0-rc.3'}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                validator.validate(self.fixture(**options), VERSION, 45)
