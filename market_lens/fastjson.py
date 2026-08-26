"""JSON fast path: orjson when available, stdlib otherwise.

orjson parses the nine venue firehoses several times faster than the
stdlib and serializes the 2.5Hz broadcast payloads likewise — measured as
a meaningful slice of the 1-vCPU VPS load (2026-08-26). The fallback
keeps every environment working if the wheel is ever missing.
"""

from __future__ import annotations

try:
    import orjson as _orjson

    def loads(data):  # str | bytes -> object
        return _orjson.loads(data)

    def dumps_str(obj) -> str:
        # orjson emits bytes; websocket text frames need str.
        return _orjson.dumps(obj).decode()

except ImportError:  # pragma: no cover — orjson is in requirements
    import json as _json

    def loads(data):
        return _json.loads(data)

    def dumps_str(obj) -> str:
        return _json.dumps(obj)
