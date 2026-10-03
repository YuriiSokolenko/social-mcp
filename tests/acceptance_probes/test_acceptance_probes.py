"""Run the trusted acceptance-boundary probes from ``manifest.json`` (#427).

These probes live outside the implementation-authored focused suites on
purpose: a passing generated suite must not imply the acceptance boundary is
covered. The directory is control-plane protected, so a candidate cannot weaken
or delete a probe to turn a failure into VERIFIED.
"""

from __future__ import annotations

import importlib
import json
from datetime import datetime
from pathlib import Path

import pytest

MANIFEST = json.loads((Path(__file__).parent / "manifest.json").read_text("utf-8"))
PROBES = MANIFEST["probes"]
CRITERIA = MANIFEST["criteria"]


def _decode(value):
    if isinstance(value, dict):
        if "$float" in value:
            return float(value["$float"])
        if "$datetime" in value:
            return datetime.fromisoformat(value["$datetime"])
    return value


def _target(criterion: str):
    module, _, name = CRITERIA[criterion]["target"].partition(":")
    return getattr(importlib.import_module(module), name)


@pytest.mark.parametrize("probe", PROBES, ids=[p["id"] for p in PROBES])
def test_probe(probe) -> None:
    function = _target(probe["criterion"])
    args = [_decode(arg) for arg in probe["args"]]
    if "raises" in probe:
        with pytest.raises(ValueError):
            function(*args)
    else:
        result = function(*args)
        assert result == probe["returns"]


def test_manifest_is_well_formed() -> None:
    ids = [probe["id"] for probe in PROBES]
    assert len(ids) == len(set(ids)), "probe ids must be unique"
    for probe in PROBES:
        assert probe["criterion"] in CRITERIA, probe["id"]
        assert ("raises" in probe) != ("returns" in probe), probe["id"]
        assert probe.get("raises", "ValueError") == "ValueError", probe["id"]
    for name, criterion in CRITERIA.items():
        assert criterion["status"] and criterion["source"], name
        assert any(p["criterion"] == name for p in PROBES), f"criterion {name} has no probe"
