"""RFC 8785 canonical JSON and digests, matching Canonical.json and Canonical.digest in @opencode/research-record.

Ported from Ivory's @ivory/contracts, unchanged in behaviour.

Both implementations are held to test/vectors/canonical-json.json. The accepted input is
I-JSON built from exactly dict (str keys), list, str, int, float, bool and None; anything else is
refused rather than converted the way json.dumps would.
"""

import hashlib
import math
import re
from contextlib import contextmanager
from decimal import Decimal

__all__ = ['CanonicalJsonError', 'canonical_json', 'canonical_digest']

# Surrogate code points in a str are always unpaired: json.loads joins escaped pairs into one code point.
_SURROGATE = re.compile('[' + chr(0xD800) + '-' + chr(0xDFFF) + ']')
_ESCAPES = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'}


class CanonicalJsonError(ValueError):
    """A refused value. `code` matches the ContractError code the TypeScript implementation uses."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def canonical_json(value):
    """Serialize `value` as RFC 8785 JSON Canonicalization Scheme text."""
    return _serialize(value, set())


def canonical_digest(value):
    """`sha256:` and the hex SHA-256 of the UTF-8 bytes of canonical_json(value)."""
    return 'sha256:' + hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def _serialize(value, ancestors):
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if type(value) in (int, float):
        return _number(value)
    if type(value) is str:
        return _string(value)
    if type(value) is list:
        with _entered(value, ancestors):
            return '[' + ','.join(_serialize(item, ancestors) for item in value) + ']'
    if type(value) is dict:
        with _entered(value, ancestors):
            names = {}
            for key in value:
                if type(key) is not str:
                    raise CanonicalJsonError('unsupported-value', f'member name {key!r} is not a string')
                names[key] = _string(key)
            # RFC 8785 orders members by UTF-16 code units, not by code points as sorted() would.
            ordered = sorted(value, key=lambda key: key.encode('utf-16-be'))
            return '{' + ','.join(names[key] + ':' + _serialize(value[key], ancestors) for key in ordered) + '}'
    raise CanonicalJsonError('unsupported-value', f'{type(value).__name__} is not I-JSON')


def _number(value):
    if type(value) is int:
        try:
            value = float(value)
        except OverflowError:
            raise CanonicalJsonError('non-finite-number', 'integer beyond the range of a double') from None
    if not math.isfinite(value):
        raise CanonicalJsonError('non-finite-number', f'{value} has no JSON representation')
    if value == 0:
        return '0'
    # repr() yields the shortest digits that round-trip, which is what ECMAScript's Number::toString
    # starts from; the branches below are its layout rules (ECMA-262, Number::toString, step 5 on).
    sign, digits, exponent = Decimal(repr(value)).normalize().as_tuple()
    text = ''.join(map(str, digits))
    k = len(text)
    n = exponent + k
    if k <= n <= 21:
        text = text + '0' * (n - k)
    elif 0 < n <= 21:
        text = text[:n] + '.' + text[n:]
    elif -6 < n <= 0:
        text = '0.' + '0' * -n + text
    else:
        e = n - 1
        text = text[0] + ('.' + text[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return ('-' if sign else '') + text


def _string(value):
    if _SURROGATE.search(value):
        raise CanonicalJsonError('lone-surrogate', 'strings must not contain unpaired UTF-16 surrogates')
    out = []
    for char in value:
        if char in _ESCAPES:
            out.append(_ESCAPES[char])
        elif char < ' ':
            out.append('\\u%04x' % ord(char))
        else:
            out.append(char)
    return '"' + ''.join(out) + '"'


@contextmanager
def _entered(container, ancestors):
    if id(container) in ancestors:
        raise CanonicalJsonError('cyclic-value', 'a value that contains itself has no JSON representation')
    ancestors.add(id(container))
    try:
        yield
    finally:
        ancestors.discard(id(container))
