import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('source_registry_check', ROOT / 'tools/check_source_registry.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class SourceRegistryCheckTests(unittest.TestCase):
    def test_bundled_registry_and_unsafe_entries(self):
        text = (ROOT / 'rules/source-registry.tsv').read_text(encoding='utf-8')
        revision, entries = checker.parse_registry(text)
        self.assertEqual(revision, '2026102801')
        self.assertEqual({source for source, _ in entries}, checker.IDS)
        for url in ['http://example.com/list', 'https://127.0.0.1/private',
                    'https://host.local/private', 'https://example.com/list?token=x']:
            self.assertFalse(checker.valid_url(url))

    def test_response_samples(self):
        self.assertTrue(checker.valid_sample('10007', b'0.0.0.0 ads.example\n'))
        self.assertTrue(checker.valid_sample('goodbyeads', b'||ads.example^\n'))
        self.assertTrue(checker.valid_sample('goodbyeads-allow', b'@@||example.com^\n'))
        self.assertTrue(checker.valid_sample('shared', b'# revision: 10\nads.example\n'))
        self.assertTrue(checker.valid_sample('registry', (ROOT / 'rules/source-registry.tsv').read_bytes()))
        for data in (b'', b'\x1f\x8bcompressed', b'<html>error</html>', b'\x00broken'):
            self.assertFalse(checker.valid_sample('10007', data))


if __name__ == '__main__':
    unittest.main()
