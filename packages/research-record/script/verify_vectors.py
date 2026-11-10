"""Independent RFC 8785 verifier for the frozen digest vectors.

Written from the specification rather than ported from the TypeScript, so agreement is evidence and not an echo.
Run from this package: python script/verify_vectors.py test/vectors.json
"""

import hashlib
import json
import sys


def units(text):
    result = []
    for character in text:
        point = ord(character)
        if point > 0xFFFF:
            point -= 0x10000
            result.append(0xD800 + (point >> 10))
            result.append(0xDC00 + (point & 0x3FF))
        else:
            result.append(point)
    return result


def jcs_string(text):
    out = ['"']
    for character in text:
        point = ord(character)
        if character == '"':
            out.append('\\"')
        elif character == "\\":
            out.append("\\\\")
        elif point == 0x08:
            out.append("\\b")
        elif point == 0x09:
            out.append("\\t")
        elif point == 0x0A:
            out.append("\\n")
        elif point == 0x0C:
            out.append("\\f")
        elif point == 0x0D:
            out.append("\\r")
        elif point < 0x20 or 0xD800 <= point <= 0xDFFF:
            out.append("\\u%04x" % point)
        else:
            out.append(character)
    out.append('"')
    return "".join(out)


def jcs_number(value):
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("canonical JSON cannot hold %r" % value)
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    text = repr(value)
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = exponent[0] if exponent[0] in "+-" else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        return "%se%s%s" % (mantissa, sign, digits)
    return text


def jcs(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return jcs_number(value)
    if isinstance(value, str):
        return jcs_string(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=units)
        return "{" + ",".join(jcs_string(key) + ":" + jcs(value[key]) for key in keys) + "}"
    raise ValueError("canonical JSON cannot hold %r" % (value,))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "test/vectors.json"
    with open(path, encoding="utf-8") as handle:
        vectors = json.load(handle)
    failures = []
    for vector in vectors:
        canonical = jcs(vector["input"])
        payload = canonical.encode("utf-8")
        digest = "sha256:" + hashlib.sha256(payload).hexdigest()
        if canonical != vector["canonical"]:
            failures.append("%s: canonical\n  frozen %s\n  python %s" % (vector["name"], vector["canonical"], canonical))
        if digest != vector["digest"]:
            failures.append("%s: digest\n  frozen %s\n  python %s" % (vector["name"], vector["digest"], digest))
    if failures:
        print("\n".join(failures))
        return 1
    print("python verifier agrees on %d vectors" % len(vectors))
    return 0


if __name__ == "__main__":
    sys.exit(main())
