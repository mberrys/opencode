"""An independent check of research-record@1 identities, written apart from the TypeScript package.

It recomputes a revision's id from its eight preimage fields, checks a quote against stored bytes, and computes a
skill digest. It shares no code with the TypeScript implementation; both are held to test/vectors/revisions.json.
"""

import hashlib

from .canonical_json import canonical_digest

__all__ = ['PREIMAGE_FIELDS', 'WRITERS', 'VerifyError', 'blob_digest', 'revision_id', 'verify_fragment', 'skill_digest']

PREIMAGE_FIELDS = ('projectId', 'kind', 'schema', 'objectId', 'parent', 'author', 'context', 'body')

# Which voices may write each kind. Kept apart from the TypeScript table on purpose, so the two can disagree visibly.
WRITERS = {
    'source': {'program'},
    'copy': {'program'},
    'representation': {'program'},
    'fragment': {'program'},
    'claim': {'agent', 'researcher'},
    'evidence': {'agent', 'researcher'},
    'judgment': {'agent'},
    'decision': {'researcher'},
    'protocol': {'agent', 'researcher'},
    'artifact': {'program'},
    'receipt': {'program'},
    'snapshot': {'program'},
}


class VerifyError(ValueError):
    """A refusal. `code` matches the ContractError code the TypeScript implementation reports."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def blob_digest(data):
    """`sha256:` and the hex SHA-256 of raw bytes. A byte identity is never a JSON identity."""
    return 'sha256:' + hashlib.sha256(bytes(data)).hexdigest()


def revision_id(revision):
    """Check a revision's envelope and return the digest of its preimage: exactly the eight fields.

    This checks identity, kind, schema and voice. Body shapes are the TypeScript parser's job; here they only need to
    hash the same.
    """
    if type(revision) is not dict or set(revision) - {'revisionId'} != set(PREIMAGE_FIELDS):
        raise VerifyError('invalid-record', 'a revision has exactly ' + ', '.join(PREIMAGE_FIELDS))
    kind = revision['kind']
    if type(kind) is not str or kind not in WRITERS:
        raise VerifyError('invalid-record', 'unknown kind ' + repr(kind))
    if revision['schema'] != kind + '@1':
        raise VerifyError('unsupported-schema', 'unsupported schema ' + repr(revision['schema']))
    author = revision['author']
    if type(author) is not dict or author.get('voice') not in WRITERS[kind]:
        raise VerifyError('invalid-author', kind + ' is written by ' + ' or '.join(sorted(WRITERS[kind])))
    digest = canonical_digest({field: revision[field] for field in PREIMAGE_FIELDS})
    if 'revisionId' in revision and revision['revisionId'] != digest:
        raise VerifyError('digest-mismatch', "revisionId is not the digest of the revision's preimage")
    return digest


def verify_fragment(representation_digest, selector, data):
    """Check a quote against the stored text byte for byte, with no normalization. Returns the quote's digest."""
    data = bytes(data)
    if (
        type(selector) is not dict
        or set(selector) != {'profile', 'start', 'end', 'quote'}
        or selector['profile'] != 'utf8-bytes@1'
        or type(selector['start']) is not int
        or type(selector['end']) is not int
        or type(selector['quote']) is not str
    ):
        raise VerifyError('selector-mismatch', 'a selector is utf8-bytes@1 with integer offsets and a quote')
    start, end, quote = selector['start'], selector['end'], selector['quote']
    try:
        expected = quote.encode('utf-8')
    except UnicodeEncodeError:
        raise VerifyError('selector-mismatch', 'the quote is not well-formed text') from None
    if blob_digest(data) != representation_digest:
        raise VerifyError('digest-mismatch', "the representation's bytes do not match its digest")

    def boundary(offset):
        return offset == len(data) or (data[offset] & 0xC0) != 0x80

    if not (0 <= start < end <= len(data)) or not boundary(start) or not boundary(end):
        raise VerifyError('selector-mismatch', 'a selector is a non-empty span inside the text, on code point boundaries')
    try:
        data.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        raise VerifyError('selector-mismatch', 'the representation is not valid UTF-8 text') from None
    span = data[start:end]
    if span != expected:
        raise VerifyError('selector-mismatch', 'the quote does not equal the stored bytes')
    return blob_digest(span)


def skill_digest(files):
    """The canonical digest of a skill's {path: blob digest} file map."""
    return canonical_digest({path: blob_digest(data) for path, data in files.items()})
