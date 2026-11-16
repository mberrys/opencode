import json
import struct
import sys
import unittest
from collections import OrderedDict
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE / 'python'))

from research_record.canonical_json import CanonicalJsonError, canonical_digest, canonical_json  # noqa: E402
from research_record.verify import VerifyError, revision_id, skill_digest, verify_fragment  # noqa: E402

CANONICAL = json.loads((PACKAGE / 'test' / 'vectors' / 'canonical-json.json').read_text(encoding='utf-8'))
REVISIONS = json.loads((PACKAGE / 'test' / 'vectors' / 'revisions.json').read_text(encoding='utf-8'))


def double(bits):
    return struct.unpack('>d', bytes.fromhex(bits))[0]


class CanonicalJson(unittest.TestCase):
    """The same vectors test/canonical.test.ts checks."""

    def test_valid(self):
        for vector in CANONICAL['valid']:
            with self.subTest(vector['name']):
                value = json.loads(vector['json'])
                self.assertEqual(canonical_json(value), vector['canonical'])
                self.assertEqual(canonical_digest(value), vector['digest'])

    def test_invalid(self):
        for vector in CANONICAL['invalid']:
            with self.subTest(vector['name']):
                self.assertRefused(json.loads(vector['json']), vector['code'])

    def test_numbers(self):
        for vector in CANONICAL['numbers']:
            with self.subTest(vector['bits']):
                self.assertEqual(canonical_json(double(vector['bits'])), vector['canonical'])

    def test_invalid_numbers(self):
        for vector in CANONICAL['invalidNumbers']:
            with self.subTest(vector['name']):
                self.assertRefused(double(vector['bits']), vector['code'])

    def test_python_only_refusals(self):
        cycle = []
        cycle.append({'cycle': cycle})
        cases = [
            ('NaN parsed by the lenient json module', json.loads('NaN'), 'non-finite-number'),
            ('tuple', (1, 2), 'unsupported-value'),
            ('non-string member name', {1: 'a'}, 'unsupported-value'),
            ('dict subclass', OrderedDict(a=1), 'unsupported-value'),
            ('surrogate pair spelled as two code points', chr(0xD83D) + chr(0xDE00), 'lone-surrogate'),
            ('value that contains itself', cycle, 'cyclic-value'),
        ]
        for name, value, code in cases:
            with self.subTest(name):
                self.assertRefused(value, code)

    def assertRefused(self, value, code):
        with self.assertRaises(CanonicalJsonError) as refused:
            canonical_json(value)
        self.assertEqual(refused.exception.code, code)


class Revisions(unittest.TestCase):
    """Every frozen identity in test/vectors/revisions.json, recomputed independently."""

    def test_ids(self):
        for entry in REVISIONS['revisions']:
            with self.subTest(entry['name']):
                self.assertEqual(revision_id(entry['revision']), entry['revision']['revisionId'])

    def test_every_kind_is_covered(self):
        kinds = {entry['revision']['kind'] for entry in REVISIONS['revisions']}
        self.assertEqual(kinds, {'source', 'copy', 'representation', 'fragment', 'claim', 'evidence', 'judgment',
                                 'decision', 'protocol', 'artifact', 'receipt', 'snapshot'})

    def test_a_changed_revision_has_another_id(self):
        revision = dict(REVISIONS['revisions'][0]['revision'])
        del revision['revisionId']
        revision['objectId'] = revision['objectId'] + '-changed'
        self.assertNotEqual(revision_id(revision), REVISIONS['revisions'][0]['revision']['revisionId'])

    def test_refusals(self):
        for vector in REVISIONS['refusals']:
            with self.subTest(vector['name']):
                with self.assertRaises(VerifyError) as refused:
                    revision_id(vector['revision'])
                self.assertEqual(refused.exception.code, vector['code'])

    def test_refuses_an_extra_field(self):
        revision = dict(REVISIONS['revisions'][0]['revision'], extra=1)
        with self.assertRaises(VerifyError) as refused:
            revision_id(revision)
        self.assertEqual(refused.exception.code, 'invalid-record')


class Fragments(unittest.TestCase):
    def test_fragments(self):
        for vector in REVISIONS['fragments']:
            with self.subTest(vector['name']):
                try:
                    verify_fragment(vector['representationDigest'], vector['selector'], vector['text'].encode('utf-8'))
                    result = 'ok'
                except VerifyError as refused:
                    result = refused.code
                self.assertEqual(result, vector['result'])


class Skills(unittest.TestCase):
    def test_skills(self):
        for vector in REVISIONS['skills']:
            with self.subTest(vector['name']):
                files = {path: text.encode('utf-8') for path, text in vector['files'].items()}
                self.assertEqual(skill_digest(files), vector['digest'])


if __name__ == '__main__':
    unittest.main()
